import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';

export async function systemDesignAgent(input: any) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[systemDesignAgent] called with:', input);
  }
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({ apiKey });
    const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(input) }
    ], model, 0.8, 0.9, 1000);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[systemDesignAgent] LLM completion:', completion);
    }
    let content = completion.choices?.[0]?.message?.content || '{}';
    // Log the raw LLM content for debugging
    if (process.env.NODE_ENV !== 'production') {
      console.log('[LLM_RAW_CONTENT_SYSTEM_DESIGN]', content);
    }
    // Always remove all Markdown code block markers (handles ```json, ``` etc.)
    content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
    // Now extract the first JSON object
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      console.error('[systemDesignAgent] No JSON object found in LLM output:', { content });
      throw new Error('Malformed LLM output: No JSON object found');
    }
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[systemDesignAgent] JSON parse error:', e, { content: jsonMatch[0] });
      throw new Error('Malformed LLM output: ' + jsonMatch[0]);
    }
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
