// LLM Proxy Client for Coforge
import axios, { AxiosResponse } from 'axios';

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
  }

  async chatCompletion(messages: any[], model: string): Promise<any> {
    const response: AxiosResponse<any> = await axios.post(
      this.chatUrl,
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
      throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    return response.data;
  }

  async embedding(text: string, model: string): Promise<number[]> {
    const response: AxiosResponse<any> = await axios.post(
      this.embeddingUrl,
      {
        texts: [text],
        model,
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
      throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    return response.data.embeddings.map(Number);
  }
}
