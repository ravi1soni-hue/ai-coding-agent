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
    // Log the raw LLM content for debugging
    if (process.env.NODE_ENV !== 'production') {
      console.log('[LLM_RAW_CONTENT_CLARIFICATION]', content);
    }
    // Always remove all Markdown code block markers (handles ```json, ``` etc.)
    content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
    // Now extract the first JSON object
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      console.error('[clarificationAgent] No JSON object found in LLM output:', { content });
      throw new Error('Malformed LLM output: No JSON object found');
    }
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[clarificationAgent] JSON parse error:', e, { content: jsonMatch[0] });
      throw new Error('Malformed LLM output: ' + jsonMatch[0]);
    }
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
