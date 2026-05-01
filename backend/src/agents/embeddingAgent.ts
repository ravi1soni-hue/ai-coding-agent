// Embedding Agent using LLM Proxy
import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';

export async function embeddingAgent(text: string): Promise<number[]> {
  debug('embeddingAgent', { textLength: text.length });
  try {
    const { apiKey } = getModelConfigForTask('embedding');
    const llmProxy = new LLMProxyClient({ apiKey });
    // The new embedding method expects an array of texts and returns an array of arrays
    const result = await llmProxy.embedding([text], 746);
    debug('embeddingAgent:result', { dimensions: result[0]?.length });
    return result[0];
  } catch (err) {
    logError('embeddingAgent', err);
    throw err;
  }
}
