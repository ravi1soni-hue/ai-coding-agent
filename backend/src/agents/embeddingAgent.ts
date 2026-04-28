// Embedding Agent using LLM Proxy
import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';

export async function embeddingAgent(text: string): Promise<number[]> {
  console.log('[embeddingAgent] called with:', text);
  try {
    const { apiKey } = getModelConfigForTask('embedding');
    const llmProxy = new LLMProxyClient({
      apiKey,
    });
    // The new embedding method expects an array of texts and returns an array of arrays
    const result = await llmProxy.embedding([text], 746);
    console.log('[embeddingAgent] embedding result:', result);
    return result[0];
  } catch (err) {
    console.error('[embeddingAgent] error:', err);
    throw err;
  }
}
