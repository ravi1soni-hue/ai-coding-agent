// LLM Proxy Client for Coforge
// Use fetch instead of axios for LLM proxy calls
// eslint-disable-next-line @typescript-eslint/no-var-requires
const util = require('util');
import { config } from '../config/env';

export interface LLMProxyOptions {
  apiKey: string;
  chatUrl?: string;
  embeddingUrl?: string;
}

export class LLMProxyClient {
  private apiKey: string;
  private chatUrl: string;
  private embeddingUrl: string;

  constructor(options: LLMProxyOptions) {
    this.apiKey = options.apiKey;
    this.chatUrl = options.chatUrl || config.LLM_PROXY_CHAT_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions';
    this.embeddingUrl = options.embeddingUrl || config.LLM_PROXY_EMBEDDING_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings';
    this.log('LLMProxyClient initialized', { apiKey: !!this.apiKey, chatUrl: this.chatUrl, embeddingUrl: this.embeddingUrl });
  }

  private log(message: string, data?: any) {
    // Use util.inspect for deep objects
    console.log(`[LLMProxyClient] ${message}${data ? ': ' + util.inspect(data, { depth: 5 }) : ''}`);
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
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

  async chatCompletion(messages: any[], model: string, temperature = 0.8, top_p = 0.9, max_tokens = 1000): Promise<any> {
    const selectedModel = model || config.GPT4O_MINI_MODEL || 'gpt-4o-mini';
    const modelCandidates = this.buildModelCandidates(selectedModel);
    this.log('chatCompletion called', {
      model: selectedModel,
      modelCandidates,
      messages,
      temperature,
      top_p,
      max_tokens,
    });

    let lastError: any;

    for (let i = 0; i < modelCandidates.length; i += 1) {
      const modelCandidate = modelCandidates[i];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 90_000);
          const response = await fetch(this.chatUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-KEY': this.apiKey,
            },
            body: JSON.stringify({ model: modelCandidate, messages, temperature, top_p, max_tokens }),
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const raw = await response.text();
          let data: any;
          try {
            data = JSON.parse(raw);
          } catch (parseErr) {
            const snippet = raw.replace(/\s+/g, ' ').slice(0, 240);
            this.log('chatCompletion invalid JSON response', {
              status: response.status,
              model: modelCandidate,
              contentType: response.headers.get('content-type'),
              raw: raw.slice(0, 1200),
              snippet,
              parseError: String(parseErr),
            });
            if (!response.ok) {
              if (this.shouldRetryStatus(response.status) && attempt < 2) {
                await this.sleep(750 * (attempt + 1));
                continue;
              }
              throw new Error(this.formatHttpError('chatCompletion', response.status, response.statusText, snippet));
            }
            throw new Error(`LLM Proxy returned invalid JSON response: ${snippet}`);
          }
          this.log('chatCompletion response', { status: response.status, model: modelCandidate, data });
          if (!response.ok) {
            this.log('chatCompletion error', { status: response.status, model: modelCandidate, data });
            if (this.shouldRetryStatus(response.status) && attempt < 2) {
              await this.sleep(750 * (attempt + 1));
              continue;
            }
            throw new Error(this.formatHttpError('chatCompletion', response.status, response.statusText, data?.error?.message || data?.message || JSON.stringify(data).slice(0, 240)));
          }
          if (modelCandidate !== selectedModel) {
            this.log('chatCompletion recovered with fallback model', { selectedModel, fallbackModel: modelCandidate });
          }
          return data;
        } catch (err: any) {
          lastError = err;
          const retryableNetworkErr = err?.name === 'AbortError' || /network|timeout|fetch failed/i.test(String(err?.message || ''));
          if (retryableNetworkErr && attempt < 2) {
            this.log('chatCompletion retrying same model after network error', { modelCandidate, attempt, reason: err?.message });
            await this.sleep(750 * (attempt + 1));
            continue;
          }
          if (this.isModelNotFoundError(err) && i < modelCandidates.length - 1) {
            this.log('chatCompletion retrying with next model candidate', {
              failedModel: modelCandidate,
              nextModel: modelCandidates[i + 1],
              reason: err?.message,
            });
            break;
          }
          this.log('chatCompletion FETCH ERROR', err);
          throw err;
        }
      }
    }

    // Defensive fallback, loop should have already returned or thrown.
    throw lastError || new Error('LLM Proxy chatCompletion failed without an explicit error.');
  }

  async embedding(texts: string[], dimensions = 746): Promise<number[][]> {
    this.log('embedding called', { texts, dimensions });
    try {
      const response = await fetch(this.embeddingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey,
        },
        body: JSON.stringify({ texts, dimensions }),
      });
      const data = await response.json();
      this.log('embedding response', { status: response.status, data });
      if (!response.ok) {
        this.log('embedding error', { status: response.status, data });
        throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(data)}`);
      }
      return data.embeddings.map((e: any) => Array.isArray(e) ? e.map(Number) : [Number(e)]);
    } catch (err) {
      this.log('embedding exception', err);
      throw err;
    }
  }
}
