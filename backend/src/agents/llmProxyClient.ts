// LLM Proxy Client for Coforge
// Use fetch instead of axios for LLM proxy calls
import { config } from '../config/env';
import { enforceBudgetOrThrow } from '../utils/tokenBudget';

export interface LLMProxyOptions {
  apiKey: string;
  chatUrl?: string;
  embeddingUrl?: string;
  /** Phase 3 budget controller context (optional). */
  projectId?: string;
}

export class LLMProxyClient {
  private apiKey: string;
  private chatUrls: string[];
  private embeddingUrls: string[];
  private projectId?: string;

  constructor(options: LLMProxyOptions) {
    this.apiKey = options.apiKey;
    this.chatUrls = this.buildUrlCandidates(options.chatUrl, config.LLM_PROXY_CHAT_URL);
    this.embeddingUrls = this.buildUrlCandidates(options.embeddingUrl, config.LLM_PROXY_EMBEDDING_URL);
    this.projectId = options.projectId;
    this.log('LLMProxyClient initialized', { apiKey: !!this.apiKey, projectId: this.projectId, chatUrls: this.chatUrls, embeddingUrls: this.embeddingUrls });
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

  private buildModelCandidates(primaryModel: string): string[] {
    const candidates = [
      primaryModel,
      config.GPT4O_MINI_MODEL,
      config.GPT4O_MODEL,
      config.GPT5_MINI_MODEL,
      config.GPT5_2_MODEL,
    ].filter((m): m is string => typeof m === 'string' && m.trim().length > 0);

    const seen = new Set<string>();
    return candidates.filter((m) => {
      if (seen.has(m)) return false;
      seen.add(m);
      return true;
    });
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
    if (!this.apiKey || this.apiKey.trim().length < 3) {
      this.log('chatCompletion called without valid API key', { model: selectedModel, apiKeyLength: this.apiKey?.length || 0 });
      throw new Error(`LLM Proxy chatCompletion failed: No valid API key configured for model "${selectedModel}". Check your environment variables for API_KEY settings.`);
    }

    // Phase 3 budget controller: enforce an approximate token budget per call
    // (using max_tokens as a conservative estimate).
    if (this.projectId) {
      enforceBudgetOrThrow(this.projectId, max_tokens);
    }

    const estimatedPayloadSize = JSON.stringify(messages || []).length;
    const estimatedWorkMs = Math.max(
      max_tokens * 35,
      Math.ceil(estimatedPayloadSize / 6) * 18,
      Array.isArray(messages) ? messages.length * 2500 : 5000
    );
    const defaultTimeout = Math.min(420_000, Math.max(45_000, estimatedWorkMs));
    const requestTimeoutMs = timeoutMs ?? defaultTimeout;

    const modelCandidates = this.buildModelCandidates(selectedModel);
    if (this.chatUrls.length === 0) {
      throw new Error('LLM Proxy chatCompletion failed: No chat URL configured. Set LLM_PROXY_CHAT_URL or pass chatUrl to LLMProxyClient.');
    }
    const urlCandidates = this.chatUrls;
    this.log('chatCompletion called', {
      model: selectedModel,
      modelCandidates,
      urlCandidates,
      messageCount: messages.length,
      temperature,
      top_p,
      max_tokens,
      timeoutMs: requestTimeoutMs,
    });

    let lastError: any;
    for (const chatUrl of urlCandidates) {
      for (let i = 0; i < modelCandidates.length; i += 1) {
        const modelCandidate = modelCandidates[i];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

            const requestPayload = { model: modelCandidate, messages, temperature, top_p, max_tokens };
            this.log('chatCompletion making request', {
              attempt: attempt + 1,
              modelCandidate,
              selectedModel,
              chatUrl,
              messageCount: messages.length,
              apiKeyLength: this.apiKey?.length || 0,
              timeoutMs: requestTimeoutMs,
            });

            const response = await fetch(chatUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                'X-API-KEY': this.apiKey,
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
                  await this.sleep(750 * (attempt + 1));
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
                await this.sleep(750 * (attempt + 1));
                continue;
              }
              throw new Error(this.formatHttpError('chatCompletion', response.status, response.statusText, data?.error?.message || data?.message || JSON.stringify(data).slice(0, 240)));
            }

            if (modelCandidate !== selectedModel || chatUrl !== urlCandidates[0]) {
              this.log('chatCompletion recovered with fallback target', { selectedModel, fallbackModel: modelCandidate, chatUrl });
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
            if (this.isModelNotFoundError(err) && i < modelCandidates.length - 1) {
              this.log('chatCompletion retrying with next model candidate', {
                failedModel: modelCandidate,
                nextModel: modelCandidates[i + 1],
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

  async embedding(texts: string[], dimensions = 746): Promise<number[][]> {
    this.log('embedding called', { texts, dimensions });
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
          body: JSON.stringify({ texts, dimensions }),
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
