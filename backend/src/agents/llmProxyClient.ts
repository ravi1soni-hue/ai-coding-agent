// LLM Proxy Client for Coforge
// Use fetch instead of axios for LLM proxy calls
import { config } from '../config/env';
import { enforceBudgetOrThrow } from '../utils/tokenBudget';

export interface ModelFallback {
  model: string;
  apiKey: string;
}

export interface LLMProxyOptions {
  apiKey: string;
  chatUrl?: string;
  embeddingUrl?: string;
  /** Phase 3 budget controller context (optional). */
  projectId?: string;
  /**
   * Ordered fallback chain of {model, apiKey} pairs from modelRouter.getModelPriorityChain().
   * Each entry carries its own API key so the proxy receives the correct auth per model.
   * When provided, these replace the hardcoded model fallback list inside chatCompletion.
   */
  fallbacks?: ModelFallback[];
}

export class LLMProxyClient {
  private apiKey: string;
  private chatUrls: string[];
  private embeddingUrls: string[];
  private projectId?: string;
  private fallbacks: ModelFallback[];

  constructor(options: LLMProxyOptions) {
    this.apiKey = options.apiKey;
    this.chatUrls = this.buildUrlCandidates(options.chatUrl, config.LLM_PROXY_CHAT_URL);
    this.embeddingUrls = this.buildUrlCandidates(options.embeddingUrl, config.LLM_PROXY_EMBEDDING_URL);
    this.projectId = options.projectId;
    this.fallbacks = options.fallbacks ?? [];
    if (!options.projectId) {
      this.log('LLMProxyClient WARNING: projectId not set — per-project token budget guard is disabled for this client instance');
    }
    this.log('LLMProxyClient initialized', { apiKey: !!this.apiKey, projectId: this.projectId, chatUrls: this.chatUrls, embeddingUrls: this.embeddingUrls, fallbackCount: this.fallbacks.length });
  }

  private log(message: string, data?: any) {
    console.log(`[LLMProxyClient] ${message}${data ? ' ' + JSON.stringify(data) : ''}`);
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private buildUrlCandidates(...values: Array<string | undefined>): string[] {
    const filtered = values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return Array.from(new Set(filtered.map((value) => value.trim())));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Compute backoff delay for a retryable HTTP error.
   * Honors the proxy's Retry-After header (seconds or HTTP-date) when present;
   * otherwise uses exponential backoff with jitter. Capped at 30s so a single
   * stuck attempt cannot stall the whole pipeline.
   */
  private computeRetryDelayMs(response: Response, attempt: number): number {
    const cap = 30_000;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const asSeconds = Number(retryAfter);
      if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return Math.min(cap, Math.ceil(asSeconds * 1000));
      }
      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) {
        const diff = asDate - Date.now();
        if (diff > 0) return Math.min(cap, diff);
      }
    }
    const base = 1000 * Math.pow(2, attempt);
    const jitter = Math.floor(Math.random() * 500);
    return Math.min(cap, base + jitter);
  }

  /**
   * Returns the ordered {model, apiKey} chain to attempt for a chatCompletion call.
   * If fallbacks were provided via the constructor (from modelRouter.getModelPriorityChain),
   * those are used — each with their own correct API key.
   * Otherwise falls back to just the primary model+key so behaviour is unchanged for
   * callers that haven't adopted the new priority-chain API yet.
   */
  private buildModelChain(primaryModel: string): ModelFallback[] {
    const seen = new Set<string>();
    const chain: ModelFallback[] = [];

    // Always try the primary model + its key first
    if (primaryModel && this.apiKey && this.apiKey.trim().length >= 3) {
      seen.add(primaryModel);
      chain.push({ model: primaryModel, apiKey: this.apiKey });
    }

    // Append fallbacks (rest of priority chain) deduped
    for (const f of this.fallbacks) {
      if (!f.model || !f.apiKey || f.apiKey.trim().length < 3) continue;
      if (seen.has(f.model)) continue;
      seen.add(f.model);
      chain.push(f);
    }

    // Guarantee at least one entry so callers can always check chain[0]
    if (chain.length === 0) chain.push({ model: primaryModel, apiKey: this.apiKey });
    return chain;
  }

  private isModelNotFoundError(err: any): boolean {
    const message = String(err?.message || '').toLowerCase();
    return message.includes('404') && message.includes('model not found');
  }

  private parseResponseBody(raw: string, response: Response, context: string): { data: any; isHtml: boolean; snippet: string } {
    const contentType = response.headers.get('content-type');
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    const looksLikeHtml =
      /text\/html|application\/xhtml\+xml/i.test(contentType || '') ||
      lower.startsWith('<') ||
      lower.includes('<!doctype html') ||
      lower.includes('<html');

    const snippet = raw.replace(/\s+/g, ' ').slice(0, 240);

    if (looksLikeHtml) {
      throw new Error(this.describeHtmlResponse(response.status, response.statusText, raw, contentType, 'unknown', context));
    }

    try {
      return { data: JSON.parse(raw), isHtml: looksLikeHtml, snippet };
    } catch (parseErr) {
      const bodyLooksHtml = /<html|<!doctype html|<head|<body|<title/i.test(lower);
      this.log(`${context} invalid JSON response`, {
        status: response.status,
        statusText: response.statusText,
        contentType,
        isHtmlResponse: looksLikeHtml || bodyLooksHtml,
        raw: raw.slice(0, 800),
        snippet,
        parseError: String(parseErr),
      });
      if (bodyLooksHtml) {
        throw new Error(this.describeHtmlResponse(response.status, response.statusText, raw, contentType, 'unknown', context));
      }
      throw new Error(`LLM Proxy ${context} returned invalid JSON response (${response.status} ${response.statusText}). ${snippet}`);
    }
  }



  private formatHttpError(operation: string, status: number, statusText?: string, detail?: string): string {
    const cleanDetail = String(detail || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (status >= 500) {
      return `LLM Proxy ${operation} is temporarily unavailable (${status} ${statusText || 'Server Error'}). Please try again.`;
    }
    if (!cleanDetail) {
      return `LLM Proxy ${operation} failed (${status} ${statusText || 'Request Error'}).`;
    }
    return `LLM Proxy ${operation} failed (${status}): ${cleanDetail.slice(0, 200)}`;
  }

  private describeHtmlResponse(status: number, statusText: string, raw: string, contentType: string | null, url: string, operation: string): string {
    const snippet = raw.replace(/\s+/g, ' ').slice(0, 360);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    const lower = raw.toLowerCase();
    const hints: string[] = [];
    if (status === 401 || status === 403 || /login|unauthorized|forbidden|auth|sso/.test(lower)) hints.push('authentication/protection');
    if (status === 404 || /not found/.test(lower)) hints.push('wrong URL or route');
    if (status === 408 || status === 504 || /timeout|gateway/.test(lower)) hints.push('gateway timeout');
    if (status === 413 || /too large|payload/.test(lower)) hints.push('payload too large');
    if (status === 429 || /rate limit|too many/.test(lower)) hints.push('rate limit');
    if (status >= 500 || /server error|bad gateway|service unavailable/.test(lower)) hints.push('provider/server error');

    return [
      `LLM Proxy returned HTML during ${operation} (${status} ${statusText || 'Unknown Status'})`,
      contentType ? `content-type=${contentType}` : null,
      title ? `title="${title.slice(0, 120)}"` : null,
      hints.length ? `likely=${Array.from(new Set(hints)).join(', ')}` : null,
      `url=${url}`,
      `snippet=${snippet}`,
    ].filter(Boolean).join('; ');
  }

  async chatCompletion(messages: any[], model: string, temperature = 0.8, top_p = 0.9, max_tokens = 1000, timeoutMs?: number): Promise<any> {
    const selectedModel = model || 'gpt-4o-mini';

    const modelChain = this.buildModelChain(selectedModel);
    if (modelChain.length === 0 || !modelChain[0].apiKey || modelChain[0].apiKey.trim().length < 3) {
      this.log('chatCompletion called without valid API key', { model: selectedModel });
      throw new Error(`LLM Proxy chatCompletion failed: No valid API key configured for model "${selectedModel}". Check your environment variables for API_KEY settings.`);
    }

    const estimatedPayloadSize = JSON.stringify(messages || []).length;
    const estimatedWorkMs = Math.max(
      max_tokens * 35,
      Math.ceil(estimatedPayloadSize / 6) * 18,
      Array.isArray(messages) ? messages.length * 2500 : 5000
    );
    const defaultTimeout = Math.min(420_000, Math.max(45_000, estimatedWorkMs));
    const requestTimeoutMs = timeoutMs ?? defaultTimeout;

    if (this.chatUrls.length === 0) {
      throw new Error('LLM Proxy chatCompletion failed: No chat URL configured. Set LLM_PROXY_CHAT_URL or pass chatUrl to LLMProxyClient.');
    }
    const urlCandidates = this.chatUrls;
    this.log('chatCompletion called', {
      model: selectedModel,
      modelChain: modelChain.map((c) => c.model),
      urlCandidates,
      messageCount: messages.length,
      temperature,
      top_p,
      max_tokens,
      timeoutMs: requestTimeoutMs,
    });

    let lastError: any;
    for (const chatUrl of urlCandidates) {
      for (let i = 0; i < modelChain.length; i += 1) {
        const { model: modelCandidate, apiKey: candidateApiKey } = modelChain[i];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

            const normalizedMessages = Array.isArray(messages) ? messages : [];
            const hasUserOrAssistant = normalizedMessages.some(
              (m: any) =>
                (m?.role === 'user' || m?.role === 'assistant') &&
                typeof m?.content === 'string' &&
                m.content.trim().length > 0,
            );
            const safeMessages = hasUserOrAssistant
              ? normalizedMessages
              : [{ role: 'user', content: ' ' }, ...normalizedMessages];

            const requestPayload = { model: modelCandidate, messages: safeMessages, temperature, top_p, max_tokens };
            this.log('chatCompletion making request', {
              attempt: attempt + 1,
              modelCandidate,
              selectedModel,
              chatUrl,
              messageCount: messages.length,
              apiKeyLength: candidateApiKey?.length || 0,
              timeoutMs: requestTimeoutMs,
            });

            const response = await fetch(chatUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${candidateApiKey}`,
                'X-API-KEY': candidateApiKey,
              },
              body: JSON.stringify(requestPayload),
              signal: controller.signal,
            });
            clearTimeout(timeout);

            const raw = await response.text();
            let data: any;
            try {
              ({ data } = this.parseResponseBody(raw, response, 'chatCompletion'));
            } catch (parseError: any) {
              const contentType = response.headers.get('content-type');
              const isHtmlResponse = /text\/html|application\/xhtml\+xml/i.test(contentType || '') || /^\s*</.test(raw) || /<!doctype html|<html/i.test(raw);
              if (isHtmlResponse || !response.ok) {
                this.log('chatCompletion invalid upstream response', {
                  modelCandidate,
                  attempt: attempt + 1,
                  status: response.status,
                  statusText: response.statusText,
                  contentType,
                  chatUrl,
                  reason: parseError instanceof Error ? parseError.message : String(parseError),
                });
                // HTML proxy response: retrying the same model is never useful (the proxy is
                // broken for this model right now). Break immediately to try the next model.
                if (isHtmlResponse) break;
                if (attempt < 2) {
                  await this.sleep(this.computeRetryDelayMs(response, attempt));
                  continue;
                }
                break;
              }
              throw parseError;
            }

            this.log('chatCompletion response', { status: response.status, model: modelCandidate, chatUrl, data });
            if (!response.ok) {
              this.log('chatCompletion error', { status: response.status, model: modelCandidate, chatUrl, data });
              if (this.shouldRetryStatus(response.status) && attempt < 2) {
                const delay = this.computeRetryDelayMs(response, attempt);
                this.log('chatCompletion retrying after retryable status', {
                  status: response.status,
                  retryAfter: response.headers.get('retry-after'),
                  attempt,
                  delay,
                  modelCandidate,
                  chatUrl,
                });
                await this.sleep(delay);
                continue;
              }
              throw new Error(this.formatHttpError('chatCompletion', response.status, response.statusText, data?.error?.message || data?.message || JSON.stringify(data).slice(0, 240)));
            }

            if (modelCandidate !== selectedModel || chatUrl !== urlCandidates[0]) {
              this.log('chatCompletion recovered with fallback target', { selectedModel, fallbackModel: modelCandidate, chatUrl });
            }
            // Charge actual tokens used (not the max_tokens ceiling) so concurrent
            // workers don't exhaust the project budget with phantom over-estimates.
            if (this.projectId) {
              const actualTokens = data?.usage?.total_tokens ?? data?.usage?.output_tokens ?? max_tokens;
              enforceBudgetOrThrow(this.projectId, actualTokens);
            }
            return data;
          } catch (err: any) {
            lastError = err;
            const retryableNetworkErr = err?.name === 'AbortError' || /network|timeout|fetch failed/i.test(String(err?.message || ''));
            if (retryableNetworkErr && attempt < 2) {
              // Exponential backoff with jitter — prevents synchronized retry
              // storms against the same overloaded target seen in the logs.
              const base = 1000 * Math.pow(2, attempt);
              const jitter = Math.floor(Math.random() * 500);
              const delay = base + jitter;
              this.log('chatCompletion retrying same target after network error', { modelCandidate, chatUrl, attempt, delay, reason: err?.message });
              await this.sleep(delay);
              continue;
            }
            if (this.isModelNotFoundError(err) && i < modelChain.length - 1) {
              this.log('chatCompletion retrying with next model candidate', {
                failedModel: modelCandidate,
                nextModel: modelChain[i + 1].model,
                chatUrl,
                reason: err?.message,
              });
              break;
            }
            this.log('chatCompletion FETCH ERROR', { chatUrl, error: err });
            break;
          }
        }
      }
    }

    throw lastError || new Error('LLM Proxy chatCompletion failed without an explicit error.');
  }

  async embedding(texts: string[], dimensions = 746, model?: string): Promise<number[][]> {
    this.log('embedding called', { texts, dimensions, model });
    let lastError: any;

    if (this.embeddingUrls.length === 0) {
      throw new Error('LLM Proxy embedding failed: No embedding URL configured. Set LLM_PROXY_EMBEDDING_URL or pass embeddingUrl to LLMProxyClient.');
    }

    for (const embeddingUrl of this.embeddingUrls) {
      try {
        const response = await fetch(embeddingUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'X-API-KEY': this.apiKey,
          },
          body: JSON.stringify({ texts, dimensions, ...(model ? { model } : {}) }),
        });
        const raw = await response.text();
        let data: any;
        try {
          ({ data } = this.parseResponseBody(raw, response, 'embedding'));
        } catch (parseError: any) {
          const contentType = response.headers.get('content-type');
          const isHtmlResponse = /text\/html|application\/xhtml\+xml/i.test(contentType || '') || /^\s*</.test(raw) || /<!doctype html|<html/i.test(raw);
          if (isHtmlResponse || !response.ok) {
            lastError = parseError;
            this.log('embedding invalid upstream response', {
              status: response.status,
              embeddingUrl,
              contentType,
              reason: parseError instanceof Error ? parseError.message : String(parseError),
            });
            if (this.shouldRetryStatus(response.status)) {
              continue;
            }
          }
          throw parseError;
        }
        this.log('embedding response', { status: response.status, embeddingUrl, data });
        if (!response.ok) {
          this.log('embedding error', { status: response.status, embeddingUrl, data });
          if (this.shouldRetryStatus(response.status)) {
            lastError = new Error(`LLM Proxy embedding failed (${response.status}): ${JSON.stringify(data).slice(0, 240)}`);
            continue;
          }
          throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(data)}`);
        }
        return data.embeddings.map((e: any) => Array.isArray(e) ? e.map(Number) : [Number(e)]);
      } catch (err: any) {
        lastError = err;
        const retryableNetworkErr = err?.name === 'AbortError' || /network|timeout|fetch failed/i.test(String(err?.message || ''));
        if (retryableNetworkErr) {
          this.log('embedding retrying next target after network/error response', { embeddingUrl, reason: err?.message });
          continue;
        }
        this.log('embedding exception', { embeddingUrl, error: err });
        throw err;
      }
    }

    throw lastError || new Error('LLM Proxy embedding failed without an explicit error.');
  }
}
