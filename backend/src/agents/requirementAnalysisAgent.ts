import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import type { ProjectBlueprint } from './blueprintContract';
import { parseJsonResponse } from './llmUtils';
import { AgentState } from './agentStates';

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
  website_type: 'business' | 'portfolio' | 'saas' | 'ecommerce' | 'marketplace' | 'dashboard' | 'blog' | 'landing_page' | 'crm' | 'lms' | 'social' | 'realtime' | 'directory' | 'api_only';
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

function extractSemanticFields(parsed: any): { score: number; reason: string; forceFrontendOnly: boolean } {
  return {
    score: typeof parsed.semantic_score === 'number' ? Math.max(0, Math.min(1, parsed.semantic_score)) : 0.75,
    reason: typeof parsed.semantic_reason === 'string' ? parsed.semantic_reason : 'inline-semantic-analysis',
    forceFrontendOnly: Boolean(parsed.force_frontend_only),
  };
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = String(currentState || '').trim();
  const normalizedNext = String(nextState || '').trim();
  if (!normalizedNext) return AgentState.NEXT_CLARIFICATION;
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

export async function requirementAnalysisAgent(input: { user_message: string; projectId?: string; globalState?: BrainState; activeState?: string }): Promise<StateAwareAgentResult<RequirementAnalysisOutput>> {
  debug('requirementAnalysisAgent', { input });
  try {
    if (!input?.user_message) throw new Error('user_message required');
    const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('requirement_analysis');
    const llmProxy = new LLMProxyClient({ apiKey, projectId: input.projectId, fallbacks });
    const activeState = String(input.activeState || input.globalState?.activeState || AgentState.REQUIREMENTS);
    if (activeState !== AgentState.REQUIREMENTS) {
      return {
        updatedState: {
          activeState,
          domain: 'requirements',
          transitions: [...(input.globalState?.transitions || []), `blocked:${activeState}`],
        },
        nextStateProposal: transitionTo(activeState, AgentState.NEXT_CLARIFICATION),
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
- website_type must be one of: business, portfolio, saas, ecommerce, marketplace, dashboard, blog, landing_page, crm, lms, social, realtime, directory, api_only.
- If the request is ambiguous, choose a safe default and add a short note.
- Set backend_required to true if the request mentions ANY server-side capability. Treat the following as backend signals (non-exhaustive): user accounts/login/auth, admin panel, roles/permissions, database/persistence, CRUD on any entity, API or endpoints, file/image upload, payments/checkout/orders, bookings/reservations, contact-form submissions stored anywhere, comments/likes/follows, notifications/email, chat/messaging/real-time, search over user-generated data, dashboards over dynamic data, multi-user collaboration, scheduling, content moderation, analytics ingestion, OAuth/SSO, webhooks.
- Set backend_required to false ONLY for purely static / informational sites where every page renders from build-time content (typical: landing page, brochure, single-page portfolio with no contact-form storage, pricing page with no checkout, static blog without comments).
- IMPORTANT: A request can mention "portfolio", "landing page", or any "site" keyword and STILL be a full-stack app — e.g. "portfolio + admin panel to manage projects", "landing page with email signup stored in a database", "blog with comments". Decide backend_required from the FUNCTIONAL capabilities described, not from the surface noun.
- Only set auth_required to true if login/authentication/user accounts are explicitly requested.
- pages can include up to 20 pages — list all requested pages, do not truncate.

Also include these three semantic alignment fields in the same JSON object:
- semantic_score: number 0.0–1.0. Closer to 1.0 = clear, unambiguous request. Closer to 0.0 = vague or contradictory.
- semantic_reason: one short sentence explaining the score.
- force_frontend_only: true if the request is clearly a static site, landing page, portfolio, brochure, or informational site with no backend needs; false otherwise.

Respond ONLY with valid JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref, notes, semantic_score, semantic_reason, force_frontend_only.
Do NOT include Markdown fences.`;
    async function runRequirementAnalysisOnce(system: string, temperature: number): Promise<RequirementAnalysisOutput> {
      const completion = await llmProxy.chatCompletion(
        [
          { role: 'system', content: system },
          { role: 'user', content: input.user_message },
        ],
        model,
        0.0,
        temperature,
        1200
      );

      let content = String(completion.choices?.[0]?.message?.content || '{}');
      debug('LLM_RAW_CONTENT_REQUIREMENT_ANALYSIS', { content });
      content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();

      // Extract the widest JSON object substring
      const jsonMatch = content.match(/{[\s\S]*}/);
      if (!jsonMatch) {
        logError('requirementAnalysisAgent:no-json', { content });
        throw new Error('Malformed LLM output: No JSON object found');
      }

      // Parse with repair attempts
      return parseJsonResponse(jsonMatch[0]);
    }

    let parsed: RequirementAnalysisOutput;
    try {
      parsed = await runRequirementAnalysisOnce(systemPrompt, 0.4);
    } catch (e) {
      // One retry with stricter JSON-only instructions + lower randomness.
      const retryPrompt = `${systemPrompt}
Return ONLY JSON. No trailing commas. No extra keys. Do not include any text before/after the JSON object.`;
      parsed = await runRequirementAnalysisOnce(retryPrompt, 0.15);
    }
    const normalizedPages = normalizePages(parsed.pages).slice(0, 20);
    const result: RequirementAnalysisOutput = {
      website_type: parsed.website_type || 'business',
      pages: normalizedPages.length > 0 ? normalizedPages : ['home'],
      backend_required: Boolean(parsed.backend_required),
      auth_required: Boolean(parsed.auth_required),
      deployment_pref: parsed.deployment_pref || 'auto',
      notes: parsed.notes,
    };

    const semantic = extractSemanticFields(parsed);
    // force_frontend_only is a SOFT hint: only downgrade when the model itself
    // did not already detect backend signals. Never override an explicit
    // backend_required=true (e.g. user asked for admin panel, auth, DB CRUD on
    // a "portfolio" — the keyword must not silently kill those needs).
    const forceFrontendOnly = semantic.forceFrontendOnly && !result.backend_required && !result.auth_required;
    const alignedResult: RequirementAnalysisOutput = {
      ...result,
      backend_required: forceFrontendOnly ? false : result.backend_required,
      auth_required: forceFrontendOnly ? false : result.auth_required,
      notes: [result.notes, semantic.reason, forceFrontendOnly ? 'Semantic analysis indicates a frontend-only request.' : null].filter(Boolean).join(' ') || undefined,
    };

    const nextStateProposal = semantic.score < 0.55 ? transitionTo(activeState, AgentState.NEXT_CLARIFICATION) : transitionTo(activeState, AgentState.NEXT_SYSTEM_DESIGN);
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
