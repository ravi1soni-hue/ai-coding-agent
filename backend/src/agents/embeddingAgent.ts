// Embedding Agent using LLM Proxy
import { config } from '../config/env';
import { LLMProxyClient } from './llmProxyClient';

const llmProxy = new LLMProxyClient({
  apiKey: config.OPENAI_API_KEY,
  chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
  embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/text/embeddings',
});

const EMBEDDING_MODEL_NAME = config.EMBEDDING_MODEL_ID || 'text-embeddings';

export async function embeddingAgent(text: string): Promise<number[]> {
  return llmProxy.embedding(text, EMBEDDING_MODEL_NAME);
}
