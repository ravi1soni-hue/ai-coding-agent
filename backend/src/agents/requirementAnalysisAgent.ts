// Requirement Analysis Agent

import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';

export type RequirementAnalysisOutput = {
  website_type: 'business' | 'portfolio' | 'saas' | 'ecommerce';
  pages: string[];
  backend_required: boolean;
  auth_required: boolean;
  deployment_pref: string;
};

export async function requirementAnalysisAgent(input: { user_message: string }): Promise<RequirementAnalysisOutput> {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[requirementAnalysisAgent] called with:', input);
  }
  try {
    if (!input?.user_message) throw new Error('user_message required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({
      apiKey,
      chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
      embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
    });
    const systemPrompt = `Extract structured website requirements from the following user message. Respond ONLY with valid JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref. Do NOT include any Markdown code block markers (no triple backticks or 'json'), just return raw JSON.`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.user_message }
    ], 'gpt-5-chat', 0.8, 0.9, 1000);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[requirementAnalysisAgent] LLM completion:', completion);
    }
    let content = completion.choices?.[0]?.message?.content || '{}';
    // Log the raw LLM content for debugging
    if (process.env.NODE_ENV !== 'production') {
      console.log('[LLM_RAW_CONTENT_REQUIREMENT_ANALYSIS]', content);
    }
    // Always remove all Markdown code block markers (handles ```json, ``` etc.)
    content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
    // Now extract the first JSON object
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      console.error('[requirementAnalysisAgent] No JSON object found in LLM output:', { content });
      throw new Error('Malformed LLM output: No JSON object found');
    }
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[requirementAnalysisAgent] JSON parse error:', e, { content: jsonMatch[0] });
      throw new Error('Malformed LLM output: ' + jsonMatch[0]);
    }
    if (!result.website_type || !Array.isArray(result.pages)) {
      throw new Error('Malformed requirementAnalysisAgent output');
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[requirementAnalysisAgent] result:', result);
    }
    return result;
  } catch (err) {
    console.error('[requirementAnalysisAgent] error:', err);
    throw err;
  }
}
