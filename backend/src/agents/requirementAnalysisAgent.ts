import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import type { ProjectBlueprint } from './blueprintContract';

export type BrainState = {
  activeState: string;
  projectSpec?: unknown;
  blueprint?: ProjectBlueprint;
  consistencyScore?: number;
  domain?: string;
  transitions?: string[];
  metadata?: Record<string, unknown>;
};

export type StateAwareAgentResult<T> = {
  updatedState: Partial<BrainState>;
  nextStateProposal: string;
  consistencyScore: number;
  output: T;
};

export type RequirementAnalysisOutput = {
  website_type: 'business' | 'portfolio' | 'saas' | 'ecommerce';
  pages: string[];
  backend_required: boolean;
  auth_required: boolean;
  deployment_pref: string;
  notes?: string;
};

function coercePageName(page: unknown): string {
  if (page == null) return '';
  if (typeof page === 'string') return page.trim();
  if (typeof page === 'number' || typeof page === 'boolean') return String(page).trim();
  if (typeof page === 'object') {
    const obj = page as Record<string, unknown>;
    const candidate = obj.name ?? obj.title ?? obj.label ?? obj.route ?? obj.path ?? obj.slug ?? obj.id;
    if (typeof candidate === 'string') return candidate.trim();
    if (typeof candidate === 'number') return String(candidate).trim();
  }
  return '';
}

function normalizePages(pages: unknown): string[] {
  if (!Array.isArray(pages)) return [];
  return Array.from(new Set(pages.map(coercePageName).filter(Boolean).map((page) => page.replace(/\s+page\s*$/i, '').replace(/\s+/g, ' ').trim()).filter(Boolean)));
}

async function assessSemanticGap(llmProxy: LLMProxyClient, model: string, input: { userMessage: string; result: RequirementAnalysisOutput }): Promise<{ score: number; reason: string; forceFrontendOnly: boolean }> {
  const prompt = `You are assessing whether a website request and extracted requirements are semantically aligned with a frontend-only, backend-required, or mixed implementation.

Return ONLY JSON with shape:
{"score":0.0,"reason":"short reason","forceFrontendOnly":true|false}

Heuristics:
- score closer to 1.0 means strong alignment and low ambiguity.
- score closer to 0.0 means weak/contradictory requirements.
- forceFrontendOnly should be true only when the user request clearly implies a static or brochure-style frontend and does not require backend, auth, database, or server state.

User message:
${input.userMessage}

Extracted requirements:
${JSON.stringify(input.result, null, 2)}`;

  const completion = await llmProxy.chatCompletion(
    [
      { role: 'system', content: prompt },
      { role: 'user', content: input.userMessage },
    ],
    model,
    0.0,
    0.2,
    500
  );

  const content = String(completion.choices?.[0]?.message?.content || '{}').replace(/```[a-zA-Z]*\s*|```/g, '').trim();
  const parsed = JSON.parse((content.match(/{[\s\S]*}/) || ['{}'])[0]) as { score?: number; reason?: string; forceFrontendOnly?: boolean };
  return {
    score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.5,
    reason: typeof parsed.reason === 'string' ? parsed.reason : 'semantic-gap-analysis',
    forceFrontendOnly: Boolean(parsed.forceFrontendOnly),
  };
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = String(currentState || '').trim();
  const normalizedNext = String(nextState || '').trim();
  if (!normalizedNext) return 'CLARIFICATION_REQUIRED';
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

export async function requirementAnalysisAgent(input: { user_message: string; globalState?: BrainState; activeState?: string }): Promise<StateAwareAgentResult<RequirementAnalysisOutput>> {
  debug('requirementAnalysisAgent', { input });
  try {
    if (!input?.user_message) throw new Error('user_message required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({ apiKey });
    const activeState = String(input.activeState || input.globalState?.activeState || 'requirements');
    if (activeState !== 'requirements') {
      return {
        updatedState: {
          activeState,
          domain: 'requirements',
          transitions: [...(input.globalState?.transitions || []), `blocked:${activeState}`],
        },
        nextStateProposal: transitionTo(activeState, 'CLARIFICATION_REQUIRED'),
        consistencyScore: 0,
        output: {
          website_type: 'business',
          pages: ['home'],
          backend_required: false,
          auth_required: false,
          deployment_pref: 'auto',
          notes: 'Blocked until the requirements gate opens.',
        },
      };
    }

    const systemPrompt = `You are an expert requirements analyst. Convert the request into a robust website requirements object.
- Infer a safe, complete website_type and pages set.
- If the request is ambiguous, choose a safe default and add a short note.
- For clearly frontend-only requests, set backend_required to false unless backend is explicitly requested.
Respond ONLY with valid JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref, notes.
Do NOT include Markdown fences.`;
    const completion = await llmProxy.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input.user_message },
      ],
      model,
      0.4,
      0.7,
      1200
    );

    let content = String(completion.choices?.[0]?.message?.content || '{}');
    debug('LLM_RAW_CONTENT_REQUIREMENT_ANALYSIS', { content });
    content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      logError('requirementAnalysisAgent:no-json', { content });
      throw new Error('Malformed LLM output: No JSON object found');
    }

    const parsed = JSON.parse(jsonMatch[0]) as RequirementAnalysisOutput;
    const normalizedPages = normalizePages(parsed.pages).slice(0, 10);
    const result: RequirementAnalysisOutput = {
      website_type: parsed.website_type || 'business',
      pages: normalizedPages.length > 0 ? normalizedPages : ['home'],
      backend_required: Boolean(parsed.backend_required),
      auth_required: Boolean(parsed.auth_required),
      deployment_pref: parsed.deployment_pref || 'auto',
      notes: parsed.notes,
    };

    const semantic = await assessSemanticGap(llmProxy, model, { userMessage: input.user_message, result });
    const forceFrontendOnly = semantic.forceFrontendOnly && !result.backend_required && !result.auth_required;
    const alignedResult: RequirementAnalysisOutput = {
      ...result,
      backend_required: forceFrontendOnly ? false : result.backend_required,
      auth_required: forceFrontendOnly ? false : result.auth_required,
      notes: [result.notes, semantic.reason, forceFrontendOnly ? 'Semantic analysis indicates a frontend-only request.' : null].filter(Boolean).join(' ') || undefined,
    };

    const nextStateProposal = semantic.score < 0.55 ? transitionTo(activeState, 'CLARIFICATION_REQUIRED') : transitionTo(activeState, 'SYSTEM_DESIGN');
    const output: RequirementAnalysisOutput = alignedResult;

    debug('requirementAnalysisAgent:result', { output, semantic });
    return {
      updatedState: {
        activeState: nextStateProposal,
        domain: 'requirements',
        consistencyScore: semantic.score,
        transitions: [...(input.globalState?.transitions || []), `requirements:${activeState}->${nextStateProposal}`],
        metadata: { semanticReason: semantic.reason },
      },
      nextStateProposal,
      consistencyScore: semantic.score,
      output,
    };
  } catch (err) {
    logError('requirementAnalysisAgent', err);
    throw err;
  }
}
