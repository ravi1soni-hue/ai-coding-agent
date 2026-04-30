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

  async chatCompletion(messages: any[], model: string, temperature = 0.8, top_p = 0.9, max_tokens = 1000): Promise<any> {
    const selectedModel = model || config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini';
    this.log('chatCompletion called', { model: selectedModel, messages, temperature, top_p, max_tokens });
    try {
      const response = await fetch(this.chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey,
        },
        body: JSON.stringify({ model: selectedModel, messages, temperature, top_p, max_tokens }),
      });
      const data = await response.json();
      this.log('chatCompletion response', { status: response.status, data });
      if (!response.ok) {
        this.log('chatCompletion error', { status: response.status, data });
        throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${JSON.stringify(data)}`);
      }
      return data;
    } catch (err: any) {
      this.log('chatCompletion FETCH ERROR', err);
      throw err;
    }
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
