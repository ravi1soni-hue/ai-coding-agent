import path from 'path';
import { debug } from '../utils/logger';
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
import { validateProjectConsistency, formatConsistencyIssues, type ConsistencyIssue } from './projectConsistency';
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
  const websiteType = String(requirements?.website_type || '').trim() as ProjectBlueprintStrict['projectType'];
  const validTypes: ProjectBlueprintStrict['projectType'][] = [
    'landing_page', 'dashboard', 'full_app', 'portfolio', 'ecommerce', 'marketplace',
    'crm', 'social', 'lms', 'realtime', 'api_only', 'saas', 'blog', 'directory',
  ];
  if (validTypes.includes(websiteType)) return websiteType;
  // Fallback: infer from context
  if (!backendRequired) return 'landing_page';
  return 'full_app';
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = String(currentState || '').trim();
  const normalizedNext = String(nextState || '').trim();
  if (!normalizedNext) return AgentState.NEXT_CLARIFICATION;
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('') || 'Page';
}

/**
 * Deterministic self-heal pass for blueprint consistency failures.
 *
 * The orchestrator's "retry" runs the same deterministic generator and produces
 * identical output, so retry alone cannot heal anything. Real self-healing has
 * to mutate the artifact. This pass reads the consistency report and fixes the
 * specific defect patterns it can fix without escalating to the user.
 *
 * Returns a new blueprint (validated through the contract again so we never
 * emit a malformed shape from a repair).
 */
function attemptBlueprintSelfHeal(
  blueprint: ProjectBlueprint,
  issues: ConsistencyIssue[],
  context: { requirements: any; systemDesign?: any; uiSpec?: any }
): { blueprint: ProjectBlueprint; repairs: string[] } {
  const repairs: string[] = [];
  const next: ProjectBlueprint = JSON.parse(JSON.stringify(blueprint));

  // Helper: ensure metadata.navigation.routes exists
  next.metadata = next.metadata || {};
  next.metadata.navigation = next.metadata.navigation || { type: 'react-router', routes: [] };
  next.metadata.navigation.routes = Array.isArray(next.metadata.navigation.routes) ? next.metadata.navigation.routes : [];

  for (const issue of issues) {
    // Pattern 1: missing route for system design page
    const missingRouteMatch = /blueprint missing route for system design page:\s*(.+)$/i.exec(issue.message);
    if (missingRouteMatch) {
      const pageName = missingRouteMatch[1].trim();
      const componentName = toPascalCase(pageName) + 'Page';
      const slug = pageName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const filePath = `src/components/${componentName}.jsx`;

      // Add navigation route if absent
      const hasRoute = next.metadata.navigation.routes.some((r) => r.component === componentName || r.path === `/${slug}`);
      if (!hasRoute) {
        next.metadata.navigation.routes.push({ path: `/${slug}`, component: componentName, purpose: `${pageName} page` });
      }

      // Add component file if absent
      if (!next.files.some((f) => f.path === filePath)) {
        next.files.push({
          path: filePath,
          kind: 'component',
          purpose: `Auto-generated stub for ${pageName} page (self-heal repair)`,
          dependsOn: [],
        });
      }

      // Mirror in strict.frontend.components
      if (!next.strict.frontend.components.includes(componentName)) {
        next.strict.frontend.components = [...next.strict.frontend.components, componentName].sort();
      }

      // Mirror in structuredSpec (inside strict.structure) so code generation sees it.
      const structureComponents: any[] = (next.strict as any).structure?.frontend?.components || [];
      if (!structureComponents.some((c: any) => c.name === componentName)) {
        structureComponents.push({
          name: componentName,
          filePath,
          purpose: `Auto-generated stub for ${pageName} page (self-heal repair)`,
          props: [],
          stateKeys: [],
          children: [],
          imports: [],
          exportsDefault: true,
        });
        if ((next.strict as any).structure?.frontend) {
          (next.strict as any).structure.frontend.components = structureComponents;
        }
      }

      // Wire App.jsx dependency
      const appFile = next.files.find((f) => f.path === 'src/App.jsx');
      if (appFile && !appFile.dependsOn?.includes(filePath)) {
        appFile.dependsOn = [...(appFile.dependsOn || []), filePath].sort();
      }

      repairs.push(`added route+component for missing page "${pageName}" → ${filePath}`);
      continue;
    }

    // Pattern 2: App.jsx mustInclude missing required tokens
    const mustIncludeMatch = /src\/App\.jsx mustInclude must declare (.+)$/i.exec(issue.message);
    if (mustIncludeMatch) {
      const detail = mustIncludeMatch[1].toLowerCase();
      const appFile = next.files.find((f) => f.path === 'src/App.jsx');
      if (appFile) {
        appFile.mustInclude = appFile.mustInclude || [];
        const tokensToAdd: string[] = [];
        if (/app component/.test(detail) && !appFile.mustInclude.some((t) => /^app$/i.test(t))) tokensToAdd.push('App');
        if (/router/.test(detail) && !appFile.mustInclude.some((t) => /router/i.test(t))) tokensToAdd.push('router');
        if (/(api_base|fetch)/.test(detail) && !appFile.mustInclude.some((t) => /API_BASE|fetch/i.test(t))) tokensToAdd.push('API_BASE', 'fetch');
        if (tokensToAdd.length > 0) {
          appFile.mustInclude = [...appFile.mustInclude, ...tokensToAdd];
          repairs.push(`appended App.jsx mustInclude tokens: ${tokensToAdd.join(', ')}`);
        }
      }
      continue;
    }

    // Pattern 3: missing wiring for UI component
    const componentMatch = /missing wiring for UI component:\s*(.+)$/i.exec(issue.message);
    if (componentMatch) {
      const componentName = componentMatch[1].trim();
      const filePath = `src/components/${componentName}.jsx`;
      if (!next.files.some((f) => f.path === filePath)) {
        next.files.push({
          path: filePath,
          kind: 'component',
          purpose: `Auto-wired stub for ${componentName} (self-heal repair)`,
          dependsOn: [],
        });
        if (!next.strict.frontend.components.includes(componentName)) {
          next.strict.frontend.components = [...next.strict.frontend.components, componentName].sort();
        }
        // Mirror in structuredSpec so code generation sees it.
        const structureComponents: any[] = (next.strict as any).structure?.frontend?.components || [];
        if (!structureComponents.some((c: any) => c.name === componentName)) {
          structureComponents.push({
            name: componentName,
            filePath,
            purpose: `Auto-wired stub for ${componentName} (self-heal repair)`,
            props: [],
            stateKeys: [],
            children: [],
            imports: [],
            exportsDefault: true,
          });
          if ((next.strict as any).structure?.frontend) {
            (next.strict as any).structure.frontend.components = structureComponents;
          }
        }
        repairs.push(`added missing component file ${filePath}`);
      }
      continue;
    }
  }

  // Re-validate through the contract so a repair can never produce malformed output.
  const repaired = validateProjectBlueprint(next, { requirements: context.requirements });
  return { blueprint: assertBlueprintIntegrationSafety(repaired), repairs };
}

function semanticBlueprintScore(input: { structuredSpec: StructuredSpec; requirements: any; systemDesign?: any; uiSpec?: any }): number {
  const { structuredSpec, requirements } = input;
  // Score based on structural completeness of the spec, not specific file/platform names.
  const hasComponents = Array.isArray(structuredSpec?.componentSchema) && structuredSpec.componentSchema.length > 0;
  const hasFilePlan = Array.isArray(structuredSpec?.filePlan) && structuredSpec.filePlan.length > 0;
  const hasPages = Array.isArray(requirements?.pages) && requirements.pages.length > 0;
  const hasApiContracts = Array.isArray(structuredSpec?.apiContracts) && structuredSpec.apiContracts.length > 0;
  const text = JSON.stringify(input).toLowerCase();
  const score =
    0.50 +
    (hasComponents ? 0.12 : 0) +
    (hasFilePlan ? 0.10 : 0) +
    (hasPages ? 0.08 : 0) +
    (hasApiContracts ? 0.06 : 0) +
    (/\bplaceholder\b|\btodo\b|\btbd\b/.test(text) ? -0.25 : 0);
  return Math.max(0, Math.min(1, score));
}

export function generateBlueprint(structuredSpec: StructuredSpec, _systemDesign: any, requirements: any, uiSpec?: any): ProjectBlueprint {
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

  // App.jsx mustInclude must reflect what App.jsx actually wires. The downstream
  // consistency validator and code generator both read this list as a contract.
  const appMustInclude: string[] = ['App'];
  // Multi-page composition implies a router. Single-page (single root '/' route)
  // landing pages do not, so we don't lie about it.
  const layoutChildCount = structuredSpec.layoutTree.children.length;
  if (layoutChildCount > 0) appMustInclude.push('router');
  if (structuredSpec.backend_required) {
    appMustInclude.push('API_BASE', 'fetch');
  }

  const files: BlueprintFile[] = [
    toBlueprintFile('package.json', 'config', 'Frontend package manifest'),
    toBlueprintFile('index.html', 'entry', 'Frontend HTML entry', ['package.json']),
    toBlueprintFile('vite.config.js', 'config', 'Vite configuration', ['package.json']),
    toBlueprintFile('src/main.jsx', 'entry', 'React bootstrap', ['src/App.jsx', 'src/index.css']),
    toBlueprintFile('src/App.jsx', 'entry', 'Application composition root', appDependencies, appMustInclude),
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

  const uiNavStrategy = String(uiSpec?.navigationStrategy || uiSpec?.layoutStructure?.navigationStrategy || '').toLowerCase();
  const derivedRouting = uiNavStrategy.includes('router') || uiNavStrategy.includes('route') || frontendPages.length > 1;
  const uiStateStrategy = String(uiSpec?.stateManagementStrategy || uiSpec?.layoutStructure?.stateManagement || '').toLowerCase();
  const derivedStateManagement: 'local' | 'context' | 'zustand' = uiStateStrategy.includes('zustand') ? 'zustand' : uiStateStrategy.includes('context') ? 'context' : 'local';

  const strict: ProjectBlueprintStrict = {
    projectType: deriveProjectType(requirements, structuredSpec.backend_required),
    modules: uniqueSorted([...(frontendPages.length > 0 ? frontendPages : ['App']), ...backendModules]),
    frontend: {
      pages: frontendPages.length > 0 ? frontendPages : ['App'],
      components: frontendComponents,
      routing: derivedRouting,
      stateManagement: derivedStateManagement,
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
        ...structuredSpec.layoutTree.children
          .filter((child) => child.type === 'page' || child.type === 'route')
          .map((child) => ({
            path: `/${child.component.toLowerCase().replace(/page$/, '')}`,
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

  const activeState = String(input.activeState || input.globalState?.activeState || AgentState.BLUEPRINT);
  if (![AgentState.BLUEPRINT, AgentState.UI_SPEC, AgentState.SYSTEM_DESIGN, AgentState.EXECUTION_PLAN].includes(activeState as any)) {
    const fallbackBlueprint = generateBlueprint(
      input.structuredSpec
        ? validateStructuredSpec(input.structuredSpec)
        : compileStructuredSpec({ uiSpec: input.uiSpec, systemDesign: input.systemDesign, requirements: input.requirements }),
      input.systemDesign,
      input.requirements,
      input.uiSpec
    );
    return {
      updatedState: {
        activeState,
        domain: 'blueprint',
        consistencyScore: 0,
        transitions: [...(input.globalState?.transitions || []), `blocked:${activeState}`],
      },
      nextStateProposal: transitionTo(activeState, AgentState.NEXT_CLARIFICATION),
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

  let blueprint = generateBlueprint(structuredSpec, input.systemDesign, input.requirements, input.uiSpec);

  // Self-heal loop: validate the blueprint against the same cross-stage rules the
  // orchestrator will run, and apply deterministic repairs for fixable defects.
  // We bound the loop because a repair pass that doesn't reduce the issue count
  // is hopeless and we'd rather fail loudly than spin.
  const projectSpecForCheck = (input.projectSpec || { projectId: input.projectId, userMessage: '', requirements: input.requirements }) as any;
  let lastIssueCount = Infinity;
  for (let pass = 0; pass < 3; pass += 1) {
    const report = validateProjectConsistency({
      projectSpec: projectSpecForCheck,
      requirementAnalysis: input.requirements,
      systemDesign: input.systemDesign,
      uiSpec: input.uiSpec,
      blueprint,
      activeStage: 'blueprint',
    });
    if (report.ok) break;
    if (report.issues.length >= lastIssueCount) {
      // Repairs aren't converging — retrying the deterministic generator produces
      // identical output, so tag the error as non-retriable so the orchestrator
      // escalates upstream (re-run systemDesign/uiSpec) instead of looping here.
      const err = new Error(`Blueprint self-heal stalled after ${pass} pass(es):\n${formatConsistencyIssues(report)}`);
      (err as any).nonRetriable = true;
      throw err;
    }
    lastIssueCount = report.issues.length;
    const { blueprint: repaired, repairs } = attemptBlueprintSelfHeal(blueprint, report.issues, {
      requirements: input.requirements,
      systemDesign: input.systemDesign,
      uiSpec: input.uiSpec,
    });
    blueprint = repaired;
    debug('blueprintAgent:self_heal', { projectId: input.projectId, pass, repairs, remainingIssues: report.issues.length });
    if (repairs.length === 0) {
      const err = new Error(`Blueprint validation failed with no applicable self-heal:\n${formatConsistencyIssues(report)}`);
      (err as any).nonRetriable = true;
      throw err;
    }
  }

  const semanticScore = semanticBlueprintScore({ structuredSpec, requirements: input.requirements, systemDesign: input.systemDesign, uiSpec: input.uiSpec });

  debug('blueprintAgent:done', { projectId: input.projectId, fileCount: blueprint.files.length, routeCount: blueprint.backendRoutes.length, semanticScore });

  // High score → advance to CODE_GENERATION. Low score → loop back upstream
  // (UI_SPEC is the closest upstream stage; clarification is too far back).
  const proposal = semanticScore < 0.55 ? AgentState.NEXT_UI_SPEC : AgentState.NEXT_CODE_GENERATION;
  return {
    updatedState: {
      activeState: transitionTo(activeState, proposal),
      domain: 'blueprint',
      consistencyScore: semanticScore,
      transitions: [...(input.globalState?.transitions || []), `blueprint:${activeState}`],
      metadata: { projectId: input.projectId },
    },
    nextStateProposal: proposal,
    consistencyScore: semanticScore,
    output: blueprint,
  };
}
