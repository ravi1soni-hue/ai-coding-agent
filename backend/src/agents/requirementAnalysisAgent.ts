// Requirement Analysis Agent

import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import { LLMProxyClient } from './llmProxyClient';

const llmProxy = new LLMProxyClient({
  apiKey: config.OPENAI_API_KEY,
  chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
  embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
});

export type RequirementAnalysisOutput = {
  website_type: 'business' | 'portfolio' | 'saas' | 'ecommerce';
  pages: string[];
  backend_required: boolean;
  auth_required: boolean;
  deployment_pref: string;
};

export async function requirementAnalysisAgent(input: { user_message: string }): Promise<RequirementAnalysisOutput> {
  try {
    if (!input?.user_message) throw new Error('user_message required');
    const modelId = getModelIdForTask('core_reasoning');
    const systemPrompt = `Extract structured website requirements from the following user message. Respond ONLY in JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref.`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.user_message }
    ], modelId);
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!result.website_type || !Array.isArray(result.pages)) {
      throw new Error('Malformed requirementAnalysisAgent output');
    }
    return result;
  } catch (err) {
    throw err;
  }
}
