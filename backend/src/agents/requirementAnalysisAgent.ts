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
  console.log('[requirementAnalysisAgent] called with:', input);
  try {
    if (!input?.user_message) throw new Error('user_message required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({
      apiKey,
      chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
      embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
    });
    const systemPrompt = `Extract structured website requirements from the following user message. Respond ONLY in JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref.`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.user_message }
    ], model, 0.8, 0.9, 1000);
    console.log('[requirementAnalysisAgent] LLM completion:', completion);
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!result.website_type || !Array.isArray(result.pages)) {
      throw new Error('Malformed requirementAnalysisAgent output');
    }
    console.log('[requirementAnalysisAgent] result:', result);
    return result;
  } catch (err) {
    console.error('[requirementAnalysisAgent] error:', err);
    throw err;
  }
}
