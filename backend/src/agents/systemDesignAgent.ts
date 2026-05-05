import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';

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
  if (!normalizedNext) return 'CLARIFICATION_REQUIRED';
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

function semanticSystemDesignScore(input: { projectSpec: unknown; result: unknown }): number {
  const text = JSON.stringify(input).toLowerCase();
  const score =
    0.52 +
    (/\breact-vite\b/.test(text) ? 0.08 : 0) +
    (/\bvercel\b/.test(text) ? 0.05 : 0) +
    (/\brailway\b/.test(text) ? 0.05 : 0) +
    (/\bpostgres\b|\bdatabase\b/.test(text) ? 0.08 : 0) +
    (/\bapi\b|\broute\b/.test(text) ? 0.08 : 0) +
    (/\bplaceholder\b|\btodo\b|\btbd\b/.test(text) ? -0.24 : 0);
  return Math.max(0, Math.min(1, score));
}

export async function systemDesignAgent(input: any): Promise<StateAwareAgentResult<any>> {
  debug('systemDesignAgent', { input });
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({ apiKey });

    const projectSpec = input.projectSpec || null;
    const backendRequired = Boolean(input?.requirements?.backend_required ?? input?.backend_required ?? projectSpec?.requirements?.backend_required);
    const authRequired = Boolean(input?.requirements?.auth_required ?? input?.auth_required ?? projectSpec?.requirements?.auth_required);

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
- For auth: include the minimum users table needed for the request`;

    const userInput = JSON.stringify({
      requirements: input.requirements || input,
      projectSpec,
      backend_required: backendRequired,
      auth_required: authRequired,
      modification: input.modification || null,
    });

    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ], model, 0.3, 0.9, 2000);

    debug('systemDesignAgent:completion', { completion });
    let content: string = completion.choices?.[0]?.message?.content || '{}';
    debug('LLM_RAW_CONTENT_SYSTEM_DESIGN', { content });

    content = content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      logError('systemDesignAgent:no-json', { content });
      throw new Error('System design: no JSON object in LLM response');
    }

    let result: any;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      logError('systemDesignAgent:parse-error', { e, content: jsonMatch[0] });
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
        activeState: consistencyScore < 0.58 ? transitionTo(input.activeState || input.globalState?.activeState || 'system_design', 'CLARIFICATION_REQUIRED') : transitionTo(input.activeState || input.globalState?.activeState || 'system_design', 'UI_SPEC'),
        domain: 'system_design',
        consistencyScore,
        transitions: [...(input.globalState?.transitions || []), `systemDesign:${String(input.activeState || input.globalState?.activeState || 'system_design')}`],
        metadata: { backendRequired, authRequired },
      },
      nextStateProposal: consistencyScore < 0.58 ? 'CLARIFICATION_REQUIRED' : 'UI_SPEC',
      consistencyScore,
      output: result,
    };
  } catch (err) {
    logError('systemDesignAgent', err);
    throw err;
  }
}
