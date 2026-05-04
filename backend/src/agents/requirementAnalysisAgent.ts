// Requirement Analysis Agent

import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';

export type RequirementAnalysisOutput = {
  website_type: 'business' | 'portfolio' | 'saas' | 'ecommerce';
  pages: string[];
  backend_required: boolean;
  auth_required: boolean;
  deployment_pref: string;
  notes?: string;
};

function shouldForceFrontendOnly(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const frontendSignals = [
    'pricing page',
    'landing page',
    'marketing page',
    'static page',
    'frontend-focused',
    'front-end focused',
    'client side',
    'client-side',
    'without backend',
    'no backend',
    'mock data',
    'static content',
  ];
  const backendSignals = ['api', 'backend', 'database', 'auth', 'login', 'signup', 'webhook', 'admin panel', 'server'];
  return frontendSignals.some((signal) => text.includes(signal)) && !backendSignals.some((signal) => text.includes(signal));
}

export async function requirementAnalysisAgent(input: { user_message: string }): Promise<RequirementAnalysisOutput> {
  debug('requirementAnalysisAgent', { input });
  try {
    if (!input?.user_message) throw new Error('user_message required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({ apiKey });
    const systemPrompt = `You are an expert requirements analyst. The user may ask for any type of website, web application, or related feature. Your job is to convert that request into a robust website requirements object.
- If the user message is broad or vague, infer a reasonable website_type and pages set.
- If the user asks for a feature that is better suited to a web application, still map it to a web-based product.
- If the request is ambiguous, do not fail silently; choose a safe default and add a short note explaining your assumption.
- For marketing pages, pricing pages, landing pages, and other clearly frontend-only requests, set backend_required to false unless the user explicitly asks for backend functionality.
Respond ONLY with valid JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref, notes.
Do NOT include any Markdown code block markers (no triple backticks or 'json'), just return raw JSON.`;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input.user_message }
    ], model, 0.8, 0.9, 1000);
    debug('requirementAnalysisAgent:completion', { completion });
    let content = completion.choices?.[0]?.message?.content || '{}';
    debug('LLM_RAW_CONTENT_REQUIREMENT_ANALYSIS', { content });
    content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      logError('requirementAnalysisAgent:no-json', { content });
      throw new Error('Malformed LLM output: No JSON object found');
    }
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      logError('requirementAnalysisAgent:parse-error', { e, content: jsonMatch[0] });
      throw new Error('Malformed LLM output: ' + jsonMatch[0]);
    }
    if (!result.website_type || !Array.isArray(result.pages)) {
      throw new Error('Malformed requirementAnalysisAgent output');
    }

    if (shouldForceFrontendOnly(input.user_message)) {
      result.backend_required = false;
      result.auth_required = false;
      result.notes = [result.notes, 'Normalized to frontend-only because the request is clearly static/client-side.'].filter(Boolean).join(' ');
    }

    debug('requirementAnalysisAgent:result', { result });
    return result;
  } catch (err) {
    logError('requirementAnalysisAgent', err);
    throw err;
  }
}
