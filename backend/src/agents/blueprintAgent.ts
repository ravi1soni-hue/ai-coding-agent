import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import { assertBlueprintMatchesContext, validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';

type BlueprintInput = {
  requirements: any;
  systemDesign?: any;
  uiSpec?: any;
  projectId?: string;
  modification?: string;
};

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const MAX_RETRIES = 3;

const SYSTEM_PROMPT = `You are a principal full-stack architect. Return ONLY valid JSON for a PROJECT_BLUEPRINT object.

Rules:
- The blueprint must be machine-validatable with no prose, markdown fences, or comments outside the JSON.
- Every backend route must set requiresProjectId to true and describe project_id filtering.
- Include exact file paths, purposes, dependencies, entrypoints, navigation, state, invariants, and backend routes.

Required shape (all fields are mandatory):
{
  "title": "string",
  "stack": {
    "frontend": "react-vite",
    "backend": "node-express-ts",
    "database": "postgresql"
  },
  "buildCriticalFiles": ["package.json", "index.html", "vite.config.js", "src/main.jsx", "src/App.jsx", "src/index.css"],
  "entrypoints": {
    "frontend": ["src/main.jsx", "src/App.jsx"],
    "backend": ["backend/index.js"]
  },
  "state": {
    "owner": "context|zustand|local",
    "store": "string",
    "shape": {}
  },
  "navigation": {
    "type": "react-router|single-page",
    "routes": [{ "path": "/", "component": "ComponentName", "purpose": "string" }]
  },
  "files": [
    { "path": "package.json", "purpose": "Frontend npm package configuration", "kind": "config" },
    { "path": "index.html", "purpose": "Vite entry HTML template", "kind": "entry" },
    { "path": "vite.config.js", "purpose": "Vite build configuration", "kind": "config" },
    { "path": "src/main.jsx", "purpose": "React application entry point", "kind": "entry" },
    { "path": "src/App.jsx", "purpose": "Root React component with routing", "kind": "entry" },
    { "path": "src/index.css", "purpose": "Global styles", "kind": "style" },
    { "path": "backend/package.json", "purpose": "Backend npm package configuration", "kind": "config" },
    { "path": "backend/index.js", "purpose": "Express server entry point", "kind": "entry" },
    { "path": "backend/db/database.js", "purpose": "PostgreSQL database connection pool", "kind": "utility" },
    { "path": "backend/db/init.sql", "purpose": "Database schema initialization SQL", "kind": "schema" }
  ],
  "backendRoutes": [
    {
      "path": "/api/example",
      "method": "GET",
      "purpose": "string",
      "requiresProjectId": true,
      "tableName": "project_example",
      "queryNotes": "Always filter by project_id"
    }
  ],
  "invariants": [
    "Every backend query must filter by project_id",
    "The frontend must render from explicit entrypoints"
  ]
}`;

function stripMarkdown(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

function extractJson(content: string): string {
  const cleaned = stripMarkdown(content);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

function tryParseBlueprint(raw: string): { blueprint: ProjectBlueprint } | { error: string } {
  let jsonStr: string;
  try {
    jsonStr = extractJson(raw);
  } catch {
    return { error: 'Could not extract JSON from response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err: any) {
    return { error: `JSON parse failed: ${err.message}` };
  }

  try {
    const blueprint = validateProjectBlueprint(parsed);
    return { blueprint };
  } catch (err: any) {
    return { error: `Blueprint validation failed: ${err.message}` };
  }
}

export async function blueprintAgent(input: BlueprintInput): Promise<ProjectBlueprint> {
  debug('blueprintAgent:start', { projectId: input.projectId });
  if (!input?.requirements) throw new Error('Blueprint input requires requirements');

  const { model, apiKey } = getModelConfigForTask('core_reasoning');
  const llmProxy = new LLMProxyClient({ apiKey });

  const userContent = JSON.stringify({
    requirements: input.requirements,
    systemDesign: input.systemDesign || null,
    uiSpec: input.uiSpec || null,
    modification: input.modification || null,
    projectId: input.projectId || null,
  });

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  let lastError = 'Unknown error';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    debug('blueprintAgent:attempt', { attempt, projectId: input.projectId });

    const completion = await llmProxy.chatCompletion(messages, model, 0.2, 0.9, 4000);
    const raw = completion.choices?.[0]?.message?.content || '';

    const result = tryParseBlueprint(raw);

    if ('blueprint' in result) {
      const contextCheckedBlueprint = assertBlueprintMatchesContext(result.blueprint, {
        requirements: input.requirements,
        uiSpec: input.uiSpec,
      });
      debug('blueprintAgent:done', {
        attempt,
        title: contextCheckedBlueprint.title,
        fileCount: contextCheckedBlueprint.files.length,
        routeCount: contextCheckedBlueprint.backendRoutes.length,
      });
      return contextCheckedBlueprint;
    }

    lastError = result.error;
    logError('blueprintAgent:validation-error', { attempt, error: lastError });

    if (attempt < MAX_RETRIES) {
      // Feed the broken output and exact error back to the LLM so it can self-correct
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Your previous response failed validation with this exact error:\n\n${lastError}\n\nFix ONLY what the error describes and return the complete corrected JSON blueprint. No prose, no markdown fences.`,
      });
    }
  }

  throw new Error(`Blueprint generation failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
}
