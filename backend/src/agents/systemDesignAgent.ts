import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';

export async function systemDesignAgent(input: any) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[systemDesignAgent] called with:', input);
  }
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({
      apiKey,
      chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
      embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
    });
    const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(input) }
    ], 'gpt-5-chat', 0.8, 0.9, 1000);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[systemDesignAgent] LLM completion:', completion);
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
    if (!result.frontend || !result.backend) {
      throw new Error('Malformed systemDesignAgent output');
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[systemDesignAgent] result:', result);
    }
    return result;
  } catch (err) {
    console.error('[systemDesignAgent] error:', err);
    throw err;
  }
}
