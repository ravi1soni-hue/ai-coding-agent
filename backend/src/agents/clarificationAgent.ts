// Clarification Agent (stub)

import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';

export async function clarificationAgent(input: any) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[clarificationAgent] called with:', input);
  }
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('clarification');
   
    const llmProxy = new LLMProxyClient({
      apiKey,
      chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
      embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
    });
   
    const systemPrompt = `Given the following structured requirements, ask ONLY blocking clarification questions (no scope expansion). Respond ONLY in JSON: { questions: string[], confirmed: boolean }.`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(input) }
    ], 'gpt-5-chat', 0.8, 0.9, 1000);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[clarificationAgent] LLM completion:', completion);
    }
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!('questions' in result) || !('confirmed' in result)) {
      throw new Error('Malformed clarificationAgent output');
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[clarificationAgent] result:', result);
    }
    return result;
  } catch (err) {
    console.error('[clarificationAgent] error:', err);
    throw err;
  }
}
