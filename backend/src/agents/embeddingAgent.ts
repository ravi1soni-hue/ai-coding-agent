// Embedding Agent using LLM Proxy
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';

export async function embeddingAgent(text: string): Promise<number[]> {
  debug('embeddingAgent', { textLength: text.length });
  try {
    const [{ model, apiKey }] = getModelPriorityChain('embedding');
    const llmProxy = new LLMProxyClient({ apiKey });
    const result = await llmProxy.embedding([text], 746, model);
    debug('embeddingAgent:result', { dimensions: result[0]?.length });
    return result[0];
  } catch (err) {
    logError('embeddingAgent', err);
    throw err;
  }
}
