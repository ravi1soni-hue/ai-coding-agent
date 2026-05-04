import path from 'path';

export type BlueprintFile = {
  path: string;
  purpose: string;
  dependsOn?: string[];
  kind: 'entry' | 'component' | 'route' | 'style' | 'config' | 'schema' | 'utility';
  mustInclude?: string[];
};

export type BlueprintBackendRoute = {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  purpose: string;
  requiresProjectId: boolean;
  tableName?: string;
  queryNotes?: string;
};

export type BlueprintApproval = {
  approved: boolean;
  reviewer: string;
  reviewedAt: string;
  notes: string[];
};

export type BlueprintState = {
  owner: 'context' | 'zustand' | 'local';
  store: string;
  shape: Record<string, unknown>;
};

export type ProjectBlueprintStrict = {
  projectType: 'landing_page' | 'dashboard' | 'full_app';
  modules: string[];
  frontend: {
    pages: string[];
    components: string[];
    routing: boolean;
    stateManagement: 'local' | 'context';
  };
  backend: {
    required: boolean;
    modules: string[];
    routes: string[];
  };
  database: {
    tables: string[];
  };
  structure: {
    frontend: Record<string, unknown>;
    backend: Record<string, unknown>;
  };
};

export type ProjectBlueprintMetadata = {
  title?: string;
  approved?: BlueprintApproval;
  stack?: {
    frontend: 'react-vite';
    backend: 'node-ts';
    database: 'postgresql';
  };
  buildCriticalFiles?: string[];
  entrypoints?: {
    frontend: string[];
    backend: string[];
  };
  state?: BlueprintState;
  navigation?: {
    type: 'react-router' | 'single-page';
    routes: Array<{ path: string; component: string; purpose: string }>;
  };
  invariants?: string[];
};

export type ProjectBlueprint = {
  strict: ProjectBlueprintStrict;
  metadata?: ProjectBlueprintMetadata;
  files: BlueprintFile[];
  dependencies: Record<string, string[]>;
  backendRoutes: BlueprintBackendRoute[];
  title?: string;
  approved?: BlueprintApproval;
  stack?: ProjectBlueprintMetadata['stack'];
  buildCriticalFiles?: string[];
  entrypoints?: ProjectBlueprintMetadata['entrypoints'];
  state?: BlueprintState;
  navigation?: NonNullable<ProjectBlueprintMetadata['navigation']>;
  invariants?: string[];
};

const REQUIRED_STRICT_FIELDS = ['projectType', 'modules', 'frontend', 'backend', 'database', 'structure'] as const;
const REQUIRED_BUILD_FILES = ['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css'] as const;
const REQUIRED_BACKEND_FILES = ['backend/package.json', 'backend/src/index.ts', 'backend/src/db/database.ts', 'backend/db/init.sql'] as const;
const BLUEPRINT_PROJECT_TYPES = new Set(['landing_page', 'dashboard', 'full_app']);
const BLUEPRINT_STATE_MANAGEMENT = new Set(['local', 'context']);
const BLUEPRINT_NAVIGATION_TYPES = new Set(['react-router', 'single-page']);
const BLUEPRINT_STACK = { frontend: 'react-vite', backend: 'node-ts', database: 'postgresql' } as const;
const BANNED_PLACEHOLDERS = /(TODO|placeholder|lorem ipsum|TBD|replace me|generic text)/i;
const ALLOWED_PATHS = /^(package\.json|index\.html|vite\.config\.js|src\/|backend\/)/;

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${label} must be an array of non-empty strings`);
  return value.map((item) => item.trim());
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function isAllowedBlueprintFile(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  if (normalized.includes('..')) return false;
  if (normalized.startsWith('node_modules/') || normalized.includes('/node_modules/')) return false;
  if (normalized.startsWith('dist/') || normalized.startsWith('.git/')) return false;
  return ALLOWED_PATHS.test(normalized);
}

function validateBlueprintFile(file: BlueprintFile, index: number): BlueprintFile {
  const pathValue = assertString(file.path, `files[${index}].path`);
  const purpose = assertString(file.purpose, `files[${index}].purpose`);
  if (!isAllowedBlueprintFile(pathValue)) throw new Error(`files[${index}].path is not allowed: ${pathValue}`);
  if (BANNED_PLACEHOLDERS.test(pathValue) || BANNED_PLACEHOLDERS.test(purpose)) throw new Error(`files[${index}] contains placeholder text`);
  if (!['entry', 'component', 'route', 'style', 'config', 'schema', 'utility'].includes(file.kind)) throw new Error(`files[${index}].kind is invalid`);
  return {
    path: normalizeFilePath(pathValue),
    purpose,
    kind: file.kind,
    dependsOn: Array.isArray(file.dependsOn) ? file.dependsOn.map(normalizeFilePath) : undefined,
    mustInclude: Array.isArray(file.mustInclude) ? file.mustInclude.map(String) : undefined,
  };
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeFilePath(value)).filter(Boolean))).sort();
}

function resultNavigation(value: unknown): NonNullable<ProjectBlueprintMetadata['navigation']> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const navigation = value as Record<string, unknown>;
  return {
    type: String(navigation.type) as 'react-router' | 'single-page',
    routes: Array.isArray(navigation.routes)
      ? navigation.routes.map((route: unknown, index: number) => ({
          path: assertString((route as Record<string, unknown>).path, `metadata.navigation.routes[${index}].path`),
          component: assertString((route as Record<string, unknown>).component, `metadata.navigation.routes[${index}].component`),
          purpose: assertString((route as Record<string, unknown>).purpose, `metadata.navigation.routes[${index}].purpose`),
        }))
      : [],
  };
}

export function validateProjectBlueprint(raw: unknown, context?: { requirements?: { backend_required?: boolean; auth_required?: boolean } }): ProjectBlueprint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Blueprint must be a JSON object');
  const blueprint = raw as Record<string, unknown>;
  const strict = assertRecord(blueprint.strict, 'strict');
  const metadata = blueprint.metadata ? assertRecord(blueprint.metadata, 'metadata') : undefined;

  for (const field of REQUIRED_STRICT_FIELDS) {
    if (!(field in strict)) throw new Error(`strict.${field} is required`);
  }

  const projectType = assertString(strict.projectType, 'strict.projectType');
  if (!BLUEPRINT_PROJECT_TYPES.has(projectType)) throw new Error('strict.projectType must be landing_page, dashboard, or full_app');
  const modules = assertStringArray(strict.modules, 'strict.modules');
  const frontend = assertRecord(strict.frontend, 'strict.frontend');
  const backend = assertRecord(strict.backend, 'strict.backend');
  const database = assertRecord(strict.database, 'strict.database');
  const structure = assertRecord(strict.structure, 'strict.structure');

  const pages = assertStringArray(frontend.pages, 'strict.frontend.pages');
  const components = assertStringArray(frontend.components, 'strict.frontend.components');
  if (typeof frontend.routing !== 'boolean') throw new Error('strict.frontend.routing must be boolean');
  if (!BLUEPRINT_STATE_MANAGEMENT.has(String(frontend.stateManagement))) throw new Error('strict.frontend.stateManagement must be local or context');

  if (typeof backend.required !== 'boolean') throw new Error('strict.backend.required must be boolean');
  const backendModules = assertStringArray(backend.modules, 'strict.backend.modules');
  const backendRouteStrings = assertStringArray(backend.routes, 'strict.backend.routes');
  const tables = assertStringArray(database.tables, 'strict.database.tables');
  if (typeof structure.frontend !== 'object' || Array.isArray(structure.frontend)) throw new Error('strict.structure.frontend must be an object');
  if (typeof structure.backend !== 'object' || Array.isArray(structure.backend)) throw new Error('strict.structure.backend must be an object');

  const buildCriticalFiles = metadata?.buildCriticalFiles ? assertStringArray(metadata.buildCriticalFiles, 'metadata.buildCriticalFiles') : [...REQUIRED_BUILD_FILES];
  for (const required of REQUIRED_BUILD_FILES) if (!buildCriticalFiles.includes(required)) throw new Error(`Missing required frontend build file: ${required}`);

  const stack = metadata?.stack ? assertRecord(metadata.stack, 'metadata.stack') : undefined;
  if (stack && (stack.frontend !== BLUEPRINT_STACK.frontend || stack.backend !== BLUEPRINT_STACK.backend || stack.database !== BLUEPRINT_STACK.database)) {
    throw new Error('metadata.stack must declare react-vite, node-ts, and postgresql');
  }

  const entrypoints = metadata?.entrypoints ? assertRecord(metadata.entrypoints, 'metadata.entrypoints') : undefined;
  if (entrypoints) {
    const frontendEntrypoints = assertStringArray(entrypoints.frontend, 'metadata.entrypoints.frontend');
    const backendEntrypoints = assertStringArray(entrypoints.backend, 'metadata.entrypoints.backend');
    if (!frontendEntrypoints.includes('src/main.jsx') || !frontendEntrypoints.includes('src/App.jsx')) throw new Error('metadata.entrypoints.frontend must include src/main.jsx and src/App.jsx');
    if (backend.required && !backendEntrypoints.includes('backend/src/index.ts')) throw new Error('metadata.entrypoints.backend must include backend/src/index.ts');
  }

  if (!pages.length) throw new Error('strict.frontend.pages cannot be empty');
  if (!components.length) throw new Error('strict.frontend.components cannot be empty');
  if (!modules.length) throw new Error('strict.modules cannot be empty');
  if (backend.required && !backendModules.length) throw new Error('strict.backend.modules cannot be empty when backend.required is true');
  if (backend.required && !backendRouteStrings.length) throw new Error('strict.backend.routes cannot be empty when backend.required is true');
  if (!tables.length) throw new Error('strict.database.tables cannot be empty');

  const invariants = metadata?.invariants ? assertStringArray(metadata.invariants, 'metadata.invariants') : [];
  if (invariants.length > 0 && !invariants.some((rule) => /project_id/i.test(rule))) throw new Error('metadata.invariants must include a project_id isolation rule');

  const navigation = metadata?.navigation ? assertRecord(metadata.navigation, 'metadata.navigation') : undefined;
  if (navigation && !BLUEPRINT_NAVIGATION_TYPES.has(String(navigation.type))) throw new Error('metadata.navigation.type must be react-router or single-page');

  const files = Array.isArray(blueprint.files) ? blueprint.files.map(validateBlueprintFile) : [];
  const filePaths = dedupeSorted(files.map((file) => file.path));
  if (filePaths.length !== files.length) throw new Error('Blueprint files must be unique');
  for (const required of REQUIRED_BUILD_FILES) if (!filePaths.includes(required)) throw new Error(`Blueprint files missing required frontend file: ${required}`);
  for (const required of REQUIRED_BACKEND_FILES) if (backend.required && !filePaths.includes(required)) throw new Error(`Blueprint files missing required backend file: ${required}`);

  const dependencies = assertRecord(blueprint.dependencies ?? {}, 'dependencies');
  for (const [fileName, deps] of Object.entries(dependencies)) {
    if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string' || !dep.trim())) throw new Error(`dependencies.${fileName} must be an array of strings`);
  }

  const backendRoutes = Array.isArray(blueprint.backendRoutes)
    ? blueprint.backendRoutes.map((route: any, index: number) => ({
        path: assertString(route.path, `backendRoutes[${index}].path`),
        method: assertString(route.method, `backendRoutes[${index}].method`) as BlueprintBackendRoute['method'],
        purpose: assertString(route.purpose, `backendRoutes[${index}].purpose`),
        requiresProjectId: route.requiresProjectId === true,
        tableName: typeof route.tableName === 'string' ? route.tableName : undefined,
        queryNotes: typeof route.queryNotes === 'string' ? route.queryNotes : undefined,
      }))
    : [];

  return {
    strict: {
      projectType: projectType as ProjectBlueprintStrict['projectType'],
      modules,
      frontend: {
        pages,
        components,
        routing: frontend.routing,
        stateManagement: frontend.stateManagement as ProjectBlueprintStrict['frontend']['stateManagement'],
      },
      backend: {
        required: backend.required,
        modules: backendModules,
        routes: backendRouteStrings,
      },
      database: { tables },
      structure: {
        frontend: structure.frontend as Record<string, unknown>,
        backend: structure.backend as Record<string, unknown>,
      },
    },
    metadata: metadata
      ? {
          title: typeof metadata.title === 'string' ? metadata.title : undefined,
          approved: metadata.approved as BlueprintApproval | undefined,
          stack: stack ? { frontend: BLUEPRINT_STACK.frontend, backend: BLUEPRINT_STACK.backend, database: BLUEPRINT_STACK.database } : undefined,
          buildCriticalFiles,
          entrypoints: entrypoints
            ? {
                frontend: assertStringArray((metadata.entrypoints as Record<string, unknown>).frontend, 'metadata.entrypoints.frontend'),
                backend: assertStringArray((metadata.entrypoints as Record<string, unknown>).backend, 'metadata.entrypoints.backend'),
              }
            : undefined,
          state: metadata.state as BlueprintState | undefined,
          navigation: resultNavigation(metadata.navigation),
          invariants,
        }
      : undefined,
    files,
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([key, value]) => [normalizeFilePath(key), dedupeSorted(value as string[])])),
    backendRoutes,
    title: typeof metadata?.title === 'string' ? metadata.title : undefined,
    approved: metadata?.approved as BlueprintApproval | undefined,
    stack: metadata?.stack ? { frontend: BLUEPRINT_STACK.frontend, backend: BLUEPRINT_STACK.backend, database: BLUEPRINT_STACK.database } : undefined,
    buildCriticalFiles,
    entrypoints: metadata?.entrypoints
      ? {
          frontend: assertStringArray((metadata.entrypoints as Record<string, unknown>).frontend, 'metadata.entrypoints.frontend'),
          backend: assertStringArray((metadata.entrypoints as Record<string, unknown>).backend, 'metadata.entrypoints.backend'),
        }
      : undefined,
    state: metadata?.state as BlueprintState | undefined,
    navigation: resultNavigation(metadata?.navigation),
    invariants,
  };
}

export function blueprintMissingFiles(blueprint: ProjectBlueprint, options?: { requirements?: { backend_required?: boolean; auth_required?: boolean } }): string[] {
  const filePaths = new Set(blueprint.files.map((file) => file.path));
  const missing: string[] = [];
  for (const required of REQUIRED_BUILD_FILES) if (!filePaths.has(required)) missing.push(required);
  const backendRequired = Boolean(options?.requirements?.backend_required || options?.requirements?.auth_required);
  if (backendRequired) for (const required of REQUIRED_BACKEND_FILES) if (!filePaths.has(required)) missing.push(required);
  return missing;
}

export function blueprintTopLevelPaths(blueprint: ProjectBlueprint): string[] {
  const paths = new Set<string>();
  for (const file of blueprint.files) {
    const normalized = normalizeFilePath(file.path);
    paths.add(normalized);
    const dir = path.dirname(normalized);
    if (dir && dir !== '.') paths.add(dir);
  }
  return Array.from(paths).sort();
}

export function assertBlueprintIntegrationSafety(blueprint: ProjectBlueprint): ProjectBlueprint {
  const filePaths = new Set(blueprint.files.map((file) => file.path));
  const navigationRoutes = blueprint.metadata?.navigation?.routes || [];
  for (const route of navigationRoutes) {
    if (route.component === 'App' && !filePaths.has('src/App.jsx')) throw new Error('Blueprint missing src/App.jsx');
  }
  for (const [fileName, deps] of Object.entries(blueprint.dependencies)) {
    for (const dep of deps) if (!filePaths.has(dep)) throw new Error(`dependencies.${fileName} references missing file: ${dep}`);
  }
  if (!filePaths.has('src/App.jsx')) throw new Error('Blueprint missing src/App.jsx');
  if (!filePaths.has('src/index.css')) throw new Error('Blueprint missing src/index.css');
  return blueprint;
}

export function assertBlueprintMatchesContext(
  blueprint: ProjectBlueprint,
  context: { requirements?: { backend_required?: boolean; auth_required?: boolean; pages?: string[]; website_type?: string }; uiSpec?: { components?: Array<{ name: string; path: string }> } }
): ProjectBlueprint {
  const requirements = context.requirements || {};
  if (Array.isArray(requirements.pages) && requirements.pages.length > 0) {
    const blueprintRoutes = blueprint.metadata?.navigation?.routes || [];
    const blueprintPaths = blueprintRoutes.map((route) => route.path);
    const pageHints = requirements.pages.map((page) => `/${String(page).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`).filter((item) => item !== '/');
    if (!blueprintPaths.includes('/') && !blueprintPaths.some((routePath) => pageHints.includes(routePath))) throw new Error('Blueprint navigation does not reflect the requested pages');
  }
  if (requirements.backend_required && !blueprint.backendRoutes.some((route) => route.path.startsWith('/api/'))) throw new Error('Blueprint is missing backend API routes for a backend-required request');
  if (context.uiSpec?.components?.length) {
    const blueprintFilePaths = new Set(blueprint.files.map((file) => file.path));
    for (const component of context.uiSpec.components) {
      const expectedPath = component.path.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!blueprintFilePaths.has(expectedPath)) throw new Error(`Blueprint is missing UI spec component wiring for ${component.name}`);
    }
  }
  return blueprint;
}
