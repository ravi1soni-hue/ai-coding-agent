import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';

export async function systemDesignAgent(input: any) {
  debug('systemDesignAgent', { input });
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('core_reasoning');
    const llmProxy = new LLMProxyClient({ apiKey });

    const backendRequired = Boolean(input?.requirements?.backend_required ?? input?.backend_required);
    const authRequired = Boolean(input?.requirements?.auth_required ?? input?.auth_required);

    const systemPrompt = `You are a software architect. Design a complete technical architecture for the given requirements.

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
- database.tables must list ALL tables needed with ALL columns (be specific and complete)
- Include created_at/updated_at timestamps on tables that need them
- For auth: always include a users table with id, email, password_hash, created_at`;

    const userInput = JSON.stringify({
      requirements: input.requirements || input,
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

    debug('systemDesignAgent:result', { result });
    return result;
  } catch (err) {
    logError('systemDesignAgent', err);
    throw err;
  }
}
