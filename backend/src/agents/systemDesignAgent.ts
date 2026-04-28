import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import { LLMProxyClient } from './llmProxyClient';

const llmProxy = new LLMProxyClient({
  apiKey: config.OPENAI_API_KEY,
  chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
  embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
});

export async function systemDesignAgent(input: any) {
  console.log('[systemDesignAgent] called with:', input);
  try {
    if (!input) throw new Error('Input required');
    const modelId = getModelIdForTask('core_reasoning');
    const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(input) }
    ], modelId, 0.8, 0.9, 1000);
    console.log('[systemDesignAgent] LLM completion:', completion);
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!result.frontend || !result.backend) {
      throw new Error('Malformed systemDesignAgent output');
    }
    console.log('[systemDesignAgent] result:', result);
    return result;
  } catch (err) {
    console.error('[systemDesignAgent] error:', err);
    throw err;
  }
}
