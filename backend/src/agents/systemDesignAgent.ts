import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import { parseJsonResponse, scaledTokenBudget } from './llmUtils';
import { AgentState } from './agentStates';

export type BrainState = {
  activeState: string;
  projectSpec?: unknown;
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

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = String(currentState || '').trim();
  const normalizedNext = String(nextState || '').trim();
  if (!normalizedNext) return AgentState.NEXT_CLARIFICATION;
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

function semanticSystemDesignScore(input: { projectSpec: unknown; result: unknown }): number {
  const text = JSON.stringify(input).toLowerCase();
  // Score based on design completeness signals, not specific platform names.
  // High score = frontend defined, backend/db addressed, no stub indicators.
  const result = (input.result as any) || {};
  const hasFrontend = Boolean(result.frontend?.framework && result.frontend?.pages?.length > 0);
  const hasBackendWhenNeeded = !result.backend || Boolean(result.backend?.routes?.length > 0);
  const score =
    0.55 +
    (hasFrontend ? 0.15 : 0) +
    (hasBackendWhenNeeded ? 0.10 : 0) +
    (/\bapi\b|\broute\b|\bendpoint\b/.test(text) ? 0.08 : 0) +
    (/\bplaceholder\b|\btodo\b|\btbd\b/.test(text) ? -0.24 : 0);
  return Math.max(0, Math.min(1, score));
}

export async function systemDesignAgent(input: any): Promise<StateAwareAgentResult<any>> {
  debug('systemDesignAgent', { input });
  try {
    if (!input) throw new Error('Input required');
    const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('system_design');
    const llmProxy = new LLMProxyClient({ apiKey, projectId: input?.projectId, fallbacks });

    const projectSpec = input.projectSpec || null;
    const backendRequired = Boolean(input?.requirements?.backend_required ?? input?.backend_required ?? projectSpec?.requirements?.backend_required);
    const authRequired = Boolean(input?.requirements?.auth_required ?? input?.auth_required ?? projectSpec?.requirements?.auth_required);
    // Self-heal feedback from a downstream stage that detected divergence.
    const previousIssues: string[] = Array.isArray(input.previousIssues)
      ? input.previousIssues.filter((s: unknown) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
      : [];
    const feedbackBlock = previousIssues.length > 0
      ? `\n\nFEEDBACK FROM A PREVIOUS ATTEMPT — your earlier output failed downstream consistency checks. Address each item; do not repeat the same mistakes:\n${previousIssues.map((m) => `- ${m}`).join('\n')}\n`
      : '';

    const systemPrompt = `You are a software architect. Design a complete technical architecture for the given requirements.

Project spec context, if available:
${JSON.stringify(projectSpec, null, 2)}

Respond ONLY in JSON with this exact shape (no markdown fences):
{
  "frontend": {
    "framework": "react-vite",
    "pages": ["PageName1", "PageName2"],
    "components": ["ComponentName1"],
    "styling": "css"
  },
  "backend": ${backendRequired ? `{
    "framework": "express",
    "routes": ["/api/resource"],
    "middleware": ["cors", "json"],
    "features": ["feature description"]
  }` : 'null'},
  "database": ${backendRequired ? `{
    "type": "postgresql",
    "tables": [
      {
        "name": "tablename",
        "columns": [
          {"name": "id", "type": "SERIAL PRIMARY KEY"},
          {"name": "field", "type": "VARCHAR(255) NOT NULL"},
          {"name": "created_at", "type": "TIMESTAMP DEFAULT NOW()"}
        ]
      }
    ]
  }` : 'null'},
  "auth": ${authRequired ? `{
    "type": "jwt",
    "strategy": "email_password",
    "tables": ["users with password_hash column"]
  }` : 'null'},
  "hosting": {
    "frontend": "vercel",
    "backend": ${backendRequired ? '"railway"' : 'null'}
  }
}

RULES:
- frontend.framework must always be "react-vite"
- hosting.frontend must always be "vercel"
- hosting.backend must always be "railway" when backend is needed, else null
- If backend_required is false: set backend, database to null
- If auth_required is false: set auth to null
- database.tables must list tables needed for the request with the columns that are actually used
- Include created_at/updated_at timestamps on tables that need them
- For auth: include the minimum users table needed for the request${feedbackBlock}`;

    const userInput = JSON.stringify({
      requirements: input.requirements || input,
      projectSpec,
      backend_required: backendRequired,
      auth_required: authRequired,
      modification: input.modification || null,
    });

    const pageCount = Array.isArray(input.requirements?.pages) ? input.requirements.pages.length : 4;
    const backendBonus = backendRequired ? 2000 : 0;
    const systemDesignTokens = scaledTokenBudget(pageCount, 600, 4000 + backendBonus, 14000).initial;
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ], model, 0.3, 0.9, systemDesignTokens);

    debug('systemDesignAgent:completion', { completion });
    const rawContent: string = completion.choices?.[0]?.message?.content || '{}';
    debug('LLM_RAW_CONTENT_SYSTEM_DESIGN', { content: rawContent });

    let result: any;
    try {
      result = parseJsonResponse(rawContent);
    } catch (e) {
      logError('systemDesignAgent:parse-error', { e, snippet: rawContent.slice(0, 200) });
      throw new Error('System design: malformed JSON from LLM');
    }

    if (!result || typeof result !== 'object' || !result.frontend) {
      throw new Error('System design: missing frontend field');
    }

    // Enforce invariants
    if (!result.frontend.framework) result.frontend.framework = 'react-vite';
    if (!backendRequired) { result.backend = null; result.database = null; }
    if (!authRequired && !result.auth) result.auth = null;

    if (!result.hosting || typeof result.hosting !== 'object') {
      result.hosting = {
        frontend: 'vercel',
        backend: backendRequired ? 'railway' : null,
      };
    }
    result.hosting.frontend = 'vercel';
    if (backendRequired) result.hosting.backend = 'railway';

    if (backendRequired && !result.backend) {
      throw new Error('System design: backend required but backend field is null');
    }

    const consistencyScore = semanticSystemDesignScore({ projectSpec, result });

    debug('systemDesignAgent:result', { result, consistencyScore });
    return {
      updatedState: {
        activeState: consistencyScore < 0.58 ? transitionTo(input.activeState || input.globalState?.activeState || AgentState.SYSTEM_DESIGN, AgentState.NEXT_CLARIFICATION) : transitionTo(input.activeState || input.globalState?.activeState || AgentState.SYSTEM_DESIGN, AgentState.NEXT_UI_SPEC),
        domain: 'system_design',
        consistencyScore,
        transitions: [...(input.globalState?.transitions || []), `systemDesign:${String(input.activeState || input.globalState?.activeState || AgentState.SYSTEM_DESIGN)}`],
        metadata: { backendRequired, authRequired },
      },
      nextStateProposal: consistencyScore < 0.58 ? AgentState.NEXT_CLARIFICATION : AgentState.NEXT_UI_SPEC,
      consistencyScore,
      output: result,
    };
  } catch (err) {
    logError('systemDesignAgent', err);
    throw err;
  }
}
