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
    let content = completion.choices?.[0]?.message?.content || '{}';
    // Remove Markdown code block markers (```json, ```, etc.)
    content = content.replace(/```[a-zA-Z]*\s*|\n?```/g, '').trim();
    // Extract first JSON object if there's extra text
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in LLM response');
    }
    const result = JSON.parse(jsonMatch[0]);
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
