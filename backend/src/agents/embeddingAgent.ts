// Embedding Agent using LLM Proxy
import { config } from '../config/env';
import { LLMProxyClient } from './llmProxyClient';

const llmProxy = new LLMProxyClient({
  apiKey: config.OPENAI_API_KEY,
  chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
  embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/text/embeddings',
});

export async function embeddingAgent(text: string): Promise<number[]> {
  console.log('[embeddingAgent] called with:', text);
  try {
    // The new embedding method expects an array of texts and returns an array of arrays
    const result = await llmProxy.embedding([text], 746);
    console.log('[embeddingAgent] embedding result:', result);
    return result[0];
  } catch (err) {
    console.error('[embeddingAgent] error:', err);
    throw err;
  }
}
