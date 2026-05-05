import path from 'path';
import { debug } from '../utils/logger';
import { LLMProxyClient } from './llmProxyClient';
import { getModelConfigForTask } from './modelRouter';
import {
  assertBlueprintIntegrationSafety,
  validateProjectBlueprint,
  type BlueprintBackendRoute,
  type BlueprintFile,
  type BlueprintState,
  type ProjectBlueprint,
  type ProjectBlueprintMetadata,
  type ProjectBlueprintStrict,
} from './blueprintContract';
import { compileStructuredSpec, validateStructuredSpec, type StructuredSpec } from './structuredSpec';

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

type BlueprintInput = {
  requirements: any;
  systemDesign?: any;
  uiSpec?: any;
  structuredSpec?: any;
  projectSpec?: any;
  projectId?: string;
  modification?: string;
  globalState?: BrainState;
  activeState?: string;
};

const BLUEPRINT_STACK = { frontend: 'react-vite', backend: 'node-ts', database: 'postgresql' } as const;

function normalizePathValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizePathValue).filter(Boolean))).sort();
}

function toBlueprintFile(pathValue: string, kind: BlueprintFile['kind'], purpose: string, dependsOn: string[] = [], mustInclude: string[] = []): BlueprintFile {
  return {
    path: normalizePathValue(pathValue),
    kind,
    purpose,
    dependsOn: uniqueSorted(dependsOn),
    mustInclude: mustInclude.length > 0 ? mustInclude : undefined,
  };
}

function generateBackendRoutes(spec: StructuredSpec): BlueprintBackendRoute[] {
  return spec.apiContracts.map((contract) => ({
    path: contract.path,
    method: contract.method,
    purpose: contract.purpose,
    requiresProjectId: contract.backendRequired,
    tableName: contract.tableName,
    queryNotes: contract.queryNotes,
  }));
}

function deriveProjectType(requirements: any, backendRequired: boolean): ProjectBlueprintStrict['projectType'] {
  const websiteType = String(requirements?.website_type || '').trim();
  if (websiteType === 'landing_page') return 'landing_page';
  if (websiteType === 'dashboard') return 'dashboard';
  return backendRequired ? 'full_app' : 'landing_page';
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = String(currentState || '').trim();
  const normalizedNext = String(nextState || '').trim();
  if (!normalizedNext) return 'CLARIFICATION_REQUIRED';
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

function semanticBlueprintScore(input: { structuredSpec: StructuredSpec; requirements: any; systemDesign?: any; uiSpec?: any }): number {
  const text = JSON.stringify(input).toLowerCase();
  const score =
    0.45 +
    (/\bproject_id\b/.test(text) ? 0.08 : 0) +
    (/\bapp\.jsx\b|\bindex\.css\b|\bmain\.jsx\b/.test(text) ? 0.08 : 0) +
    (/\bapi\b|\broute\b|\bendpoint\b/.test(text) ? 0.08 : 0) +
    (/\bcomponent\b|\bjsx\b/.test(text) ? 0.08 : 0) +
    (/\bplaceholder\b|\btodo\b|\btbd\b/.test(text) ? -0.25 : 0);
  return Math.max(0, Math.min(1, score));
}

export function generateBlueprint(structuredSpec: StructuredSpec, systemDesign: any, requirements: any): ProjectBlueprint {
  const rootComponent = structuredSpec.componentSchema.find((component) => component.name === 'App');
  const generatedComponents = structuredSpec.componentSchema.filter((component) => component.name !== 'App');
  const componentFiles = generatedComponents.map((component) =>
    toBlueprintFile(
      component.filePath,
      'component',
      component.purpose,
      component.imports.length > 0 ? component.imports.map((dep) => dep) : component.children.map((child) => `src/components/${child}.jsx`)
    )
  );

  const appDependencies = uniqueSorted([
    ...componentFiles.map((file) => file.path),
    ...structuredSpec.filePlan.filter((file) => file.path !== 'src/App.jsx').map((file) => file.path),
  ]);

  const files: BlueprintFile[] = [
    toBlueprintFile('package.json', 'config', 'Frontend package manifest'),
    toBlueprintFile('index.html', 'entry', 'Frontend HTML entry', ['package.json']),
    toBlueprintFile('vite.config.js', 'config', 'Vite configuration', ['package.json']),
    toBlueprintFile('src/main.jsx', 'entry', 'React bootstrap', ['src/App.jsx', 'src/index.css']),
    toBlueprintFile('src/App.jsx', 'entry', 'Application composition root', appDependencies, ['App']),
    toBlueprintFile('src/index.css', 'style', 'Global stylesheet', ['src/App.jsx']),
    ...componentFiles,
  ];

  if (structuredSpec.backend_required) {
    files.push(
      toBlueprintFile('backend/package.json', 'config', 'Backend package manifest'),
      toBlueprintFile('backend/src/index.ts', 'entry', 'Backend server entry', ['backend/src/db/database.ts', ...structuredSpec.apiContracts.map((api) => api.routeFile)]),
      toBlueprintFile('backend/src/db/database.ts', 'utility', 'Database access helper'),
      toBlueprintFile('backend/db/init.sql', 'schema', 'Database schema initialization')
    );
    for (const route of structuredSpec.apiContracts) {
      files.push(toBlueprintFile(route.routeFile, 'route', route.purpose, ['backend/src/db/database.ts']));
    }
  }

  const dependencies: Record<string, string[]> = Object.fromEntries(
    structuredSpec.filePlan.map((entry) => [entry.path, uniqueSorted(entry.dependsOn)])
  );

  const requirementPages = Array.isArray(requirements?.pages)
    ? requirements.pages
        .map((page: unknown) => String(page).trim())
        .filter(Boolean)
    : [];
  const layoutPages = structuredSpec.layoutTree.children
    .filter((node) => node.type === 'page' || node.type === 'route' || generatedComponents.some((component) => component.name === node.component))
    .map((node) => node.component)
    .filter((name) => name !== 'App');
  const frontendPages = uniqueSorted([...layoutPages, ...requirementPages]);
  const frontendComponents = uniqueSorted([rootComponent?.name || 'App', ...generatedComponents.map((component) => component.name)]);
  const backendModules = structuredSpec.backend_required ? structuredSpec.apiContracts.map((route) => path.basename(route.routeFile, '.ts')) : [];

  const strict: ProjectBlueprintStrict = {
    projectType: deriveProjectType(requirements, structuredSpec.backend_required),
    modules: uniqueSorted([...(frontendPages.length > 0 ? frontendPages : ['App']), ...backendModules]),
    frontend: {
      pages: frontendPages.length > 0 ? frontendPages : ['App'],
      components: frontendComponents,
      routing: true,
      stateManagement: 'context',
    },
    backend: {
      required: structuredSpec.backend_required,
      modules: backendModules,
      routes: structuredSpec.apiContracts.map((route) => route.path),
    },
    database: {
      tables: structuredSpec.backend_required
        ? uniqueSorted(structuredSpec.apiContracts.map((c) => c.tableName).filter((t): t is string => Boolean(t)))
        : [],
    },
    structure: {
      frontend: {
        layoutTree: structuredSpec.layoutTree,
        components: structuredSpec.componentSchema,
      },
      backend: structuredSpec.backend_required
        ? {
            routes: structuredSpec.apiContracts,
          }
        : {},
    },
  };

  const metadata: ProjectBlueprintMetadata = {
    title: String(requirements?.userMessage || 'Generated Project').slice(0, 120),
    stack: BLUEPRINT_STACK,
    buildCriticalFiles: ['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css'],
    entrypoints: {
      frontend: ['src/main.jsx', 'src/App.jsx'],
      backend: structuredSpec.backend_required ? ['backend/src/index.ts'] : [],
    },
    state: {
      owner: 'context',
      store: 'appState',
      shape: {},
    },
    navigation: {
      type: 'react-router',
      routes: [
        { path: '/', component: 'App', purpose: 'Application root' },
        ...structuredSpec.layoutTree.children.map((child) => ({
          path: `/${child.component.toLowerCase()}`,
          component: child.component,
          purpose: child.name,
        })),
      ],
    },
    invariants: [
      'Every backend query must filter by project_id',
      'The frontend must render from explicit entrypoints',
    ],
  };

  const blueprint: ProjectBlueprint = validateProjectBlueprint(
    {
      strict,
      metadata,
      files,
      dependencies,
      backendRoutes: generateBackendRoutes(structuredSpec),
      title: metadata.title,
      stack: metadata.stack,
      buildCriticalFiles: metadata.buildCriticalFiles,
      entrypoints: metadata.entrypoints,
      state: metadata.state as BlueprintState,
      navigation: metadata.navigation,
      invariants: metadata.invariants,
    },
    { requirements }
  );

  return assertBlueprintIntegrationSafety(blueprint);
}

export async function blueprintAgent(input: BlueprintInput): Promise<StateAwareAgentResult<ProjectBlueprint>> {
  debug('blueprintAgent:start', { projectId: input.projectId });
  if (!input?.requirements) throw new Error('Blueprint input requires requirements');

  const activeState = String(input.activeState || input.globalState?.activeState || 'blueprint');
  if (!['blueprint', 'ui_spec', 'system_design', 'execution_plan'].includes(activeState)) {
    const fallbackBlueprint = generateBlueprint(
      input.structuredSpec
        ? validateStructuredSpec(input.structuredSpec)
        : compileStructuredSpec({ uiSpec: input.uiSpec, systemDesign: input.systemDesign, requirements: input.requirements }),
      input.systemDesign,
      input.requirements
    );
    return {
      updatedState: {
        activeState,
        domain: 'blueprint',
        consistencyScore: 0,
        transitions: [...(input.globalState?.transitions || []), `blocked:${activeState}`],
      },
      nextStateProposal: transitionTo(activeState, 'CLARIFICATION_REQUIRED'),
      consistencyScore: 0,
      output: fallbackBlueprint,
    };
  }

  const structuredSpec = input.structuredSpec
    ? validateStructuredSpec(input.structuredSpec)
    : compileStructuredSpec({
        uiSpec: input.uiSpec,
        systemDesign: input.systemDesign,
        requirements: input.requirements,
      });

  const blueprint = generateBlueprint(structuredSpec, input.systemDesign, input.requirements);
  const semanticScore = semanticBlueprintScore({ structuredSpec, requirements: input.requirements, systemDesign: input.systemDesign, uiSpec: input.uiSpec });

  debug('blueprintAgent:done', { projectId: input.projectId, fileCount: blueprint.files.length, routeCount: blueprint.backendRoutes.length, semanticScore });

  return {
    updatedState: {
      activeState: transitionTo(activeState, semanticScore < 0.55 ? 'CLARIFICATION_REQUIRED' : 'UI_SPEC'),
      domain: 'blueprint',
      consistencyScore: semanticScore,
      transitions: [...(input.globalState?.transitions || []), `blueprint:${activeState}`],
      metadata: { projectId: input.projectId },
    },
    nextStateProposal: semanticScore < 0.55 ? 'CLARIFICATION_REQUIRED' : 'UI_SPEC',
    consistencyScore: semanticScore,
    output: blueprint,
  };
}
