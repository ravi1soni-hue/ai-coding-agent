import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import { validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';

type BlueprintInput = {
  requirements: any;
  systemDesign?: any;
  uiSpec?: any;
  projectId?: string;
  modification?: string;
};

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

export async function blueprintAgent(input: BlueprintInput): Promise<ProjectBlueprint> {
  debug('blueprintAgent:start', { projectId: input.projectId });
  if (!input?.requirements) throw new Error('Blueprint input requires requirements');

  const { model, apiKey } = getModelConfigForTask('core_reasoning');
  const llmProxy = new LLMProxyClient({ apiKey });

  const systemPrompt = `You are a principal full-stack architect. Return ONLY valid JSON for a PROJECT_BLUEPRINT object.

Rules:
- The blueprint must be machine-validatable.
- Include build-critical React/Vite files and backend Node/Express/TypeScript files.
- Every backend route must set requiresProjectId to true and describe project_id filtering.
- Include exact file paths, purposes, dependencies, entrypoints, navigation, state, invariants, and backend routes.
- Do not include markdown fences, prose, or comments.

Required shape:
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
    "routes": [
      { "path": "/", "component": "ComponentName", "purpose": "string" }
    ]
  },
  "files": [
    {
      "path": "src/components/Component.jsx",
      "purpose": "string",
      "kind": "component",
      "exports": ["default"],
      "dependsOn": ["src/App.jsx"],
      "mustInclude": ["useState", "fetch"]
    }
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
}

Always include all required files.`;

  const completion = await llmProxy.chatCompletion(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          requirements: input.requirements,
          systemDesign: input.systemDesign || null,
          uiSpec: input.uiSpec || null,
          modification: input.modification || null,
          projectId: input.projectId || null,
        }),
      },
    ],
    model,
    0.2,
    0.9,
    2600,
  );

  let content = completion.choices?.[0]?.message?.content || '';
  content = extractJson(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logError('blueprintAgent:parse-error', { err, content: content.slice(0, 2000) });
    throw new Error('Blueprint agent returned malformed JSON');
  }

  const blueprint = validateProjectBlueprint(parsed);
  debug('blueprintAgent:done', {
    title: blueprint.title,
    fileCount: blueprint.files.length,
    routeCount: blueprint.backendRoutes.length,
  });
  return blueprint;
}
