import path from 'path';

export type BlueprintFile = {
  path: string;
  purpose: string;
  exports?: string[];
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

export type BlueprintState = {
  owner: 'context' | 'zustand' | 'local';
  store: string;
  shape: Record<string, unknown>;
};

export type ProjectBlueprint = {
  title: string;
  stack: {
    frontend: 'react-vite';
    backend: 'node-express-ts';
    database: 'postgresql';
  };
  buildCriticalFiles: string[];
  entrypoints: {
    frontend: string[];
    backend: string[];
  };
  state: BlueprintState;
  navigation: {
    type: 'react-router' | 'single-page';
    routes: Array<{ path: string; component: string; purpose: string }>;
  };
  files: BlueprintFile[];
  backendRoutes: BlueprintBackendRoute[];
  invariants: string[];
};

const REQUIRED_BUILD_FILES = new Set([
  'package.json',
  'index.html',
  'vite.config.js',
  'src/main.jsx',
  'src/App.jsx',
  'src/index.css',
]);

const REQUIRED_BACKEND_FILES = new Set([
  'backend/package.json',
  'backend/index.js',
  'backend/db/database.js',
  'backend/db/init.sql',
]);

const BANNED_PLACEHOLDERS = /(TODO|placeholder|lorem ipsum|TBD|replace me|generic text)/i;

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function isAllowedBlueprintFile(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  if (normalized.includes('..')) return false;
  if (normalized.startsWith('node_modules/') || normalized.includes('/node_modules/')) return false;
  if (normalized.startsWith('dist/') || normalized.startsWith('.git/')) return false;
  return true;
}

function validateBlueprintFile(file: BlueprintFile, index: number): BlueprintFile {
  const pathValue = assertString(file.path, `files[${index}].path`);
  const purpose = assertString(file.purpose, `files[${index}].purpose`);
  if (!isAllowedBlueprintFile(pathValue)) {
    throw new Error(`files[${index}].path is not allowed: ${pathValue}`);
  }
  if (BANNED_PLACEHOLDERS.test(purpose) || BANNED_PLACEHOLDERS.test(pathValue)) {
    throw new Error(`files[${index}] contains placeholder text`);
  }
  if (!['entry', 'component', 'route', 'style', 'config', 'schema', 'utility'].includes(file.kind)) {
    throw new Error(`files[${index}].kind is invalid`);
  }
  return {
    path: normalizeFilePath(pathValue),
    purpose,
    kind: file.kind,
    exports: Array.isArray(file.exports) ? file.exports.map(String) : undefined,
    dependsOn: Array.isArray(file.dependsOn) ? file.dependsOn.map(normalizeFilePath) : undefined,
    mustInclude: Array.isArray(file.mustInclude) ? file.mustInclude.map(String) : undefined,
  };
}

export function validateProjectBlueprint(raw: unknown): ProjectBlueprint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Blueprint must be a JSON object');
  }

  const blueprint = raw as Record<string, unknown>;
  const title = assertString(blueprint.title, 'title');

  const stack = blueprint.stack as Record<string, unknown> | undefined;
  if (!stack) throw new Error('stack is required');
  if (stack.frontend !== 'react-vite' || stack.backend !== 'node-express-ts' || stack.database !== 'postgresql') {
    throw new Error('stack must declare react-vite, node-express-ts, and postgresql');
  }

  const buildCriticalFiles = assertStringArray(blueprint.buildCriticalFiles, 'buildCriticalFiles');
  for (const required of REQUIRED_BUILD_FILES) {
    if (!buildCriticalFiles.includes(required)) {
      throw new Error(`Missing required frontend build file: ${required}`);
    }
  }

  const entrypoints = blueprint.entrypoints as Record<string, unknown> | undefined;
  if (!entrypoints) throw new Error('entrypoints is required');
  const frontendEntrypoints = assertStringArray(entrypoints.frontend, 'entrypoints.frontend');
  const backendEntrypoints = assertStringArray(entrypoints.backend, 'entrypoints.backend');
  if (!frontendEntrypoints.includes('src/main.jsx') || !frontendEntrypoints.includes('src/App.jsx')) {
    throw new Error('entrypoints.frontend must include src/main.jsx and src/App.jsx');
  }
  if (!backendEntrypoints.includes('backend/index.js')) {
    throw new Error('entrypoints.backend must include backend/index.js');
  }

  const state = blueprint.state as Record<string, unknown> | undefined;
  if (!state) throw new Error('state is required');
  if (!['context', 'zustand', 'local'].includes(String(state.owner))) {
    throw new Error('state.owner must be context, zustand, or local');
  }
  const stateStore = assertString(state.store, 'state.store');
  const stateShape = state.shape;
  if (!stateShape || typeof stateShape !== 'object' || Array.isArray(stateShape)) {
    throw new Error('state.shape must be an object');
  }

  const navigation = blueprint.navigation as Record<string, unknown> | undefined;
  if (!navigation) throw new Error('navigation is required');
  if (!['react-router', 'single-page'].includes(String(navigation.type))) {
    throw new Error('navigation.type must be react-router or single-page');
  }
  const routes = Array.isArray(navigation.routes) ? navigation.routes : [];
  if (routes.length === 0) throw new Error('navigation.routes cannot be empty');

  const files = Array.isArray(blueprint.files) ? blueprint.files.map(validateBlueprintFile) : [];
  if (files.length === 0) throw new Error('files cannot be empty');

  for (const required of REQUIRED_BUILD_FILES) {
    if (!files.some((file) => file.path === required)) {
      throw new Error(`Blueprint missing required frontend file: ${required}`);
    }
  }
  for (const required of REQUIRED_BACKEND_FILES) {
    if (!files.some((file) => file.path === required)) {
      throw new Error(`Blueprint missing required backend file: ${required}`);
    }
  }

  const backendRoutes = Array.isArray(blueprint.backendRoutes) ? blueprint.backendRoutes : [];
  if (backendRoutes.length === 0) {
    throw new Error('backendRoutes cannot be empty');
  }

  for (let i = 0; i < backendRoutes.length; i += 1) {
    const route = backendRoutes[i] as Record<string, unknown>;
    const routePath = assertString(route.path, `backendRoutes[${i}].path`);
    if (!routePath.startsWith('/api/')) {
      throw new Error(`backendRoutes[${i}].path must start with /api/`);
    }
    const method = assertString(route.method, `backendRoutes[${i}].method`) as BlueprintBackendRoute['method'];
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error(`backendRoutes[${i}].method is invalid`);
    }
    if (route.requiresProjectId !== true) {
      throw new Error(`backendRoutes[${i}] must require project_id filtering`);
    }
    assertString(route.purpose, `backendRoutes[${i}].purpose`);
  }

  const invariants = assertStringArray(blueprint.invariants, 'invariants');
  if (!invariants.some((rule) => /project_id/i.test(rule))) {
    throw new Error('invariants must include a project_id isolation rule');
  }

  return {
    title,
    stack: {
      frontend: 'react-vite',
      backend: 'node-express-ts',
      database: 'postgresql',
    },
    buildCriticalFiles,
    entrypoints: {
      frontend: frontendEntrypoints,
      backend: backendEntrypoints,
    },
    state: {
      owner: state.owner as BlueprintState['owner'],
      store: stateStore,
      shape: stateShape as Record<string, unknown>,
    },
    navigation: {
      type: navigation.type as ProjectBlueprint['navigation']['type'],
      routes: routes.map((route, index) => ({
        path: assertString((route as any).path, `navigation.routes[${index}].path`),
        component: assertString((route as any).component, `navigation.routes[${index}].component`),
        purpose: assertString((route as any).purpose, `navigation.routes[${index}].purpose`),
      })),
    },
    files,
    backendRoutes: backendRoutes.map((route, index) => ({
      path: assertString((route as any).path, `backendRoutes[${index}].path`),
      method: assertString((route as any).method, `backendRoutes[${index}].method`) as BlueprintBackendRoute['method'],
      purpose: assertString((route as any).purpose, `backendRoutes[${index}].purpose`),
      requiresProjectId: (route as any).requiresProjectId === true,
      tableName: typeof (route as any).tableName === 'string' ? String((route as any).tableName) : undefined,
      queryNotes: typeof (route as any).queryNotes === 'string' ? String((route as any).queryNotes) : undefined,
    })),
    invariants,
  };
}

export function isBlueprintFileEntry(filePath: string): boolean {
  const normalized = normalizeFilePath(filePath);
  return REQUIRED_BUILD_FILES.has(normalized) || REQUIRED_BACKEND_FILES.has(normalized) || normalized.startsWith('src/components/') || normalized.startsWith('backend/routes/');
}

export function blueprintMissingFiles(blueprint: ProjectBlueprint): string[] {
  const filePaths = new Set(blueprint.files.map((file) => file.path));
  const missing: string[] = [];
  for (const required of REQUIRED_BUILD_FILES) {
    if (!filePaths.has(required)) missing.push(required);
  }
  for (const required of REQUIRED_BACKEND_FILES) {
    if (!filePaths.has(required)) missing.push(required);
  }
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
