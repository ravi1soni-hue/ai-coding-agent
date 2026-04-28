// Embedding Agent using LLM Proxy
import { config } from '../config/env';
import { LLMProxyClient } from './llmProxyClient';

const llmProxy = new LLMProxyClient({ apiKey: config.OPENAI_API_KEY });

export async function embeddingAgent(text: string): Promise<number[]> {
  return llmProxy.embedding(text);
}
