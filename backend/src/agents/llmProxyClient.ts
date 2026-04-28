// LLM Proxy Client for Coforge
import axios, { AxiosResponse } from 'axios';

export interface LLMProxyOptions {
  apiKey: string;
  url?: string;
}

export class LLMProxyClient {
  private apiKey: string;
  private url: string;

  constructor(options: LLMProxyOptions) {
    this.apiKey = options.apiKey;
    this.url = options.url || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings';
  }

  async chatCompletion(messages: any[], model: string): Promise<any> {
    // This is a placeholder. You may need to adjust the payload and endpoint for chat completion if your proxy supports it.
    const response: AxiosResponse<any> = await axios.post(
      this.url.replace('embeddings', 'chat/completions'),
      {
        model,
        messages,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey,
        },
      }
    );
    if (response.status !== 200) {
      throw new Error(`LLM Proxy failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async embedding(text: string): Promise<number[]> {
    const response: AxiosResponse<any> = await axios.post(
      this.url,
      {
        texts: [text],
        dimensions: 736,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey,
        },
      }
    );
    if (response.status !== 200) {
      throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    return response.data.embeddings.map(Number);
  }
}
