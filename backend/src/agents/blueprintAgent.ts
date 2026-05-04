import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import { assertBlueprintMatchesContext, validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';

type BlueprintInput = {
  requirements: any;
  systemDesign?: any;
  uiSpec?: any;
  projectSpec?: any;
  projectId?: string;
  modification?: string;
};

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

const MAX_RETRIES = 3;

const SYSTEM_PROMPT = `You are a principal full-stack architect. Return ONLY valid JSON for a PROJECT_BLUEPRINT object.

Rules:
- The blueprint must be machine-validatable with no prose, markdown fences, or comments outside the JSON.
- The top-level response MUST contain only: strict, metadata, files, dependencies, backendRoutes.
- Code generation MUST use strict only. metadata is for diagnostics, approval, and routing hints only.
- Never invent extra files. files must be the single authoritative registry of generated files.
- Every backend route must set requiresProjectId to true and describe project_id filtering.
- Every backend table/query must use shared tables with project_id columns. Never use per-project table names.
- Stack is fixed: frontend = react-vite, backend = node-ts, database = postgresql.
- All backend source files MUST be .ts files only.
- Treat projectSpec as authoritative if present. Do not invent files, routes, components, or pages outside of projectSpec, systemDesign, or uiSpec.
- If uiSpec.components is provided, every component must be represented in either navigation.routes, files, or as an explicit dependency chain from App.
- Always include App in navigation.routes as the root entry component when uiSpec is present.
- Reconcile the blueprint against projectSpec before returning JSON.
- Ignore metadata fields during code generation.

Required shape:
{
  "strict": {
    "projectType": "landing_page|dashboard|full_app",
    "modules": ["string"],
    "frontend": {
      "pages": ["string"],
      "components": ["string"],
      "routing": true,
      "stateManagement": "local|context"
    },
    "backend": {
      "required": true,
      "modules": ["string"],
      "routes": ["string"]
    },
    "database": {
      "tables": ["string"]
    },
    "structure": {
      "frontend": {},
      "backend": {}
    }
  },
  "metadata": {
    "title": "string",
    "stack": {
      "frontend": "react-vite",
      "backend": "node-ts",
      "database": "postgresql"
    },
    "buildCriticalFiles": ["package.json", "index.html", "vite.config.js", "src/main.jsx", "src/App.jsx", "src/index.css"],
    "entrypoints": {
      "frontend": ["src/main.jsx", "src/App.jsx"],
      "backend": ["backend/src/index.ts"]
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
    "invariants": [
      "Every backend query must filter by project_id",
      "The frontend must render from explicit entrypoints"
    ]
  },
  "files": [
    { "path": "package.json", "purpose": "Frontend npm package configuration", "kind": "config" },
    { "path": "index.html", "purpose": "Vite entry HTML template", "kind": "entry" },
    { "path": "vite.config.js", "purpose": "Vite build configuration", "kind": "config" },
    { "path": "src/main.jsx", "purpose": "React application entry point", "kind": "entry" },
    { "path": "src/App.jsx", "purpose": "Root React component with routing", "kind": "entry" },
    { "path": "src/index.css", "purpose": "Global styles", "kind": "style" },
    { "path": "backend/package.json", "purpose": "Backend npm package configuration", "kind": "config" },
    { "path": "backend/src/index.ts", "purpose": "TypeScript backend server entry point", "kind": "entry" },
    { "path": "backend/src/db/database.ts", "purpose": "PostgreSQL database connection pool", "kind": "utility" },
    { "path": "backend/db/init.sql", "purpose": "Database schema initialization SQL", "kind": "schema" }
  ],
  "backendRoutes": [
    {
      "path": "/api/example",
      "method": "GET",
      "purpose": "string",
      "requiresProjectId": true,
      "tableName": "items",
      "queryNotes": "Always filter by project_id"
    }
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

  if (!input.projectSpec) {
    throw new Error('Canonical projectSpec required for blueprint generation');
  }
  const projectSpec = input.projectSpec;
  const specRequirements = projectSpec?.requirements || {};
  if (input.requirements?.website_type && specRequirements.website_type && input.requirements.website_type !== specRequirements.website_type) {
    throw new Error('Blueprint input does not match canonical projectSpec requirements');
  }
  if (Array.isArray(specRequirements.pages) && Array.isArray(input.requirements?.pages)) {
    const specPages = specRequirements.pages.map((page: string) => String(page).trim()).filter(Boolean);
    const inputPages = input.requirements.pages.map((page: string) => String(page).trim()).filter(Boolean);
    for (const page of specPages) {
      if (!inputPages.includes(page)) {
        throw new Error(`Blueprint input is missing canonical page: ${page}`);
      }
    }
  }
  const userContent = JSON.stringify({
    requirements: input.requirements,
    projectSpec,
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
      const specBackendRequired = Boolean(projectSpec?.requirements?.backend_required);
      if (!specBackendRequired && (contextCheckedBlueprint.backendRoutes || []).length > 0) {
        throw new Error('Blueprint contains backend routes for a frontend-only canonical projectSpec');
      }
      if (specBackendRequired && (contextCheckedBlueprint.backendRoutes || []).length === 0) {
        throw new Error('Blueprint is missing backend routes required by the canonical projectSpec');
      }
      debug('blueprintAgent:done', {
        attempt,
        title: contextCheckedBlueprint.title,
        fileCount: (contextCheckedBlueprint.files || []).length,
        routeCount: (contextCheckedBlueprint.backendRoutes || []).length,
      });
      return contextCheckedBlueprint;
    }

    lastError = result.error;
    logError('blueprintAgent:validation-error', { attempt, error: lastError });

    if (attempt < MAX_RETRIES) {
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Your previous response failed validation with this exact error:\n\n${lastError}\n\nCorrect the issue and return the COMPLETE corrected JSON blueprint. Requirements:\n- No prose, no markdown fences, no code blocks — raw JSON only\n- Every backendRoute MUST have requiresProjectId set to boolean true (not a string)\n- files[] MUST include all 10 required paths: package.json, index.html, vite.config.js, src/main.jsx, src/App.jsx, src/index.css, backend/package.json, backend/index.js, backend/db/database.js, backend/db/init.sql\n- entrypoints.frontend MUST include ["src/main.jsx","src/App.jsx"]\n- stack.frontend MUST be exactly "react-vite", stack.backend MUST be exactly "node-express-ts"\n- navigation.routes MUST include a route with component "App"`,
      });
    }
  }

  throw new Error(`Blueprint generation failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
}
