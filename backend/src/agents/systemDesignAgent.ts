import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import { LLMProxyClient } from './llmProxyClient';

const llmProxy = new LLMProxyClient({ apiKey: config.OPENAI_API_KEY });

export async function systemDesignAgent(input: any) {
  try {
    if (!input) throw new Error('Input required');
    const modelId = getModelIdForTask('core_reasoning');
    const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(input) }
    ], modelId);
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!result.frontend || !result.backend) {
      throw new Error('Malformed systemDesignAgent output');
    }
    return result;
  } catch (err) {
    throw err;
  }
}
