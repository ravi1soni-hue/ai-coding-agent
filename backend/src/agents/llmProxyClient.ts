// LLM Proxy Client for Coforge
import axios, { AxiosResponse } from 'axios';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const util = require('util');

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
    this.chatUrl = options.chatUrl || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions';
    this.embeddingUrl = options.embeddingUrl || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings';
    this.log('LLMProxyClient initialized', { apiKey: !!this.apiKey, chatUrl: this.chatUrl, embeddingUrl: this.embeddingUrl });
  }

  private log(message: string, data?: any) {
    // Use util.inspect for deep objects
    console.log(`[LLMProxyClient] ${message}${data ? ': ' + util.inspect(data, { depth: 5 }) : ''}`);
  }

  async chatCompletion(messages: any[], model: string, temperature = 0.8, top_p = 0.9, max_tokens = 1000): Promise<any> {
    this.log('chatCompletion called', { model, messages, temperature, top_p, max_tokens });
    try {
      const response: AxiosResponse<any> = await axios.post(
        this.chatUrl,
        {
          model,
          messages,
          temperature,
          top_p,
          max_tokens,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': this.apiKey,
          },
        }
      );
      this.log('chatCompletion response', { status: response.status, data: response.data });
      if (response.status !== 200) {
        this.log('chatCompletion error', { status: response.status, data: response.data });
        throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${JSON.stringify(response.data)}`);
      }
      return response.data;
    } catch (err) {
      this.log('chatCompletion exception', err);
      throw err;
    }
  }

  async embedding(texts: string[], dimensions = 746): Promise<number[][]> {
    this.log('embedding called', { texts, dimensions });
    try {
      const response: AxiosResponse<any> = await axios.post(
        this.embeddingUrl,
        {
          texts,
          dimensions,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': this.apiKey,
          },
        }
      );
      this.log('embedding response', { status: response.status, data: response.data });
      if (response.status !== 200) {
        this.log('embedding error', { status: response.status, data: response.data });
        throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(response.data)}`);
      }
      return response.data.embeddings.map((e: any) => Array.isArray(e) ? e.map(Number) : [Number(e)]);
    } catch (err) {
      this.log('embedding exception', err);
      throw err;
    }
  }
}
