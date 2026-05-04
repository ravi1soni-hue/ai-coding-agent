import path from 'path';
import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError, warn as logWarn } from '../utils/logger';
import { assertBlueprintIntegrationSafety, blueprintMissingFiles, validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';
import { reviewerAgent } from './reviewerAgent';

type GeneratedFile = { path: string; content: string };

type EventSink = {
  emit: (event: { type: string; message?: string; token?: string; filePath?: string; payload?: unknown }) => void;
};

type FrontendManifest = {
  appName?: string;
  dependencies?: Record<string, string>;
  apiResources?: Array<{ name: string; path: string; methods?: string[]; purpose?: string }>;
  components?: Array<{ path: string; name?: string; purpose?: string }>;
  styleNotes?: string;
};

type BackendManifest = {
  resources?: Array<{ name: string; routePath: string; tableName?: string; fields?: string[]; methods?: string[]; purpose?: string }>;
  tables?: Array<{ name: string; columns?: string[]; purpose?: string }>;
};

type ProjectManifest = {
  technicalSpecs: {
    stack: string;
    modelRouting: {
      orchestration: string;
      code: string;
      review: string;
    };
  };
  fileTree: string[];
  requirements: {
    frontend: FrontendManifest;
    backend?: BackendManifest;
  };
  componentRequirements: Array<{ path: string; purpose?: string; reviewerNotes?: string }>;
  project_task_queue: Array<{ id: string; kind: 'file' | 'logic'; path: string; purpose: string }>;
  blueprint?: ProjectBlueprint;
};

const FRONTEND_REQUIRED = new Set(['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css']);
const FRONTEND_ALLOWED_PREFIXES = ['src/components/', 'src/pages/'];
const BACKEND_REQUIRED = new Set(['backend/package.json', 'backend/src/index.ts', 'backend/src/db/database.ts', 'backend/db/init.sql']);
const BACKEND_ALLOWED_PREFIXES = ['backend/src/routes/', 'backend/src/middleware/'];
const MAX_COMPONENTS = 6;
const MAX_BACKEND_ROUTES = 8;
const MAX_BUILD_ATTEMPTS = 2;
const MAX_LLM_CALLS_PER_PROJECT = 20;
const BAN_LIST = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.pnpm-store', 'bun.lockb'];
const SHARED_TABLE_NAME = 'items';
const SHARED_TABLE_COLUMNS = ['id TEXT PRIMARY KEY', 'project_id TEXT NOT NULL', 'name TEXT NOT NULL', "data JSONB NOT NULL DEFAULT '{}'::jsonb", 'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'];

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_$]/g, '');
  return cleaned && /^[a-zA-Z_$]/.test(cleaned) ? cleaned : fallback;
}

function isAllowedPath(filePath: string, scope: 'frontend' | 'backend'): boolean {
  const p = normalizePath(filePath);
  if (p.includes('..') || path.isAbsolute(p)) return false;
  if (BAN_LIST.some((b) => p === b || p.startsWith(`${b}/`))) return false;
  if (p.startsWith('node_modules') || p.includes('/node_modules/')) return false;
  if (p.startsWith('dist/') || p === 'dist') return false;
  if (scope === 'frontend') return FRONTEND_REQUIRED.has(p) || FRONTEND_ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
  return BACKEND_REQUIRED.has(p) || BACKEND_ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a JSON object`);
  return value as Record<string, unknown>;
}

function stripMarkdownFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

function parseJsonSafe(content: string): any {
  const cleaned = stripMarkdownFences(content);
  try {
    return JSON.parse(cleaned);
  } catch {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  throw new Error(`No valid JSON found in LLM response. Snippet: ${cleaned.replace(/\s+/g, ' ').slice(0, 220)}`);
}

function containsPlaceholderText(value: string): boolean {
  return /(?:\bTODO\b|\bplaceholder\b|\breplace\b|\bgeneric text\b)/i.test(value);
}

function validateGeneratedFile(file: unknown, expectedPath: string | undefined, scope: 'frontend' | 'backend', label: string): GeneratedFile {
  const obj = assertObject(file, label);
  const filePath = normalizePath(String(obj.path || expectedPath || ''));
  const content = obj.content;
  if (!filePath) throw new Error(`${label}: missing path`);
  if (expectedPath && filePath !== expectedPath) throw new Error(`${label}: expected path ${expectedPath}, got ${filePath}`);
  if (!isAllowedPath(filePath, scope)) throw new Error(`${label}: invalid or disallowed path ${filePath}`);
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${label}: missing content for ${filePath}`);
  return { path: filePath, content };
}

function setFile(files: Map<string, string>, file: GeneratedFile) {
  files.set(normalizePath(file.path), file.content);
}

function sanitizeComponentPath(rawPath: string, index: number): string {
  const p = normalizePath(rawPath || '');
  if (p.startsWith('src/components/') && p.endsWith('.jsx') && !p.includes('..')) return p;
  return `src/components/GeneratedSection${index + 1}.jsx`;
}

function sanitizeRoutePath(rawPath: string, resourceName: string): string {
  const p = normalizePath(rawPath || '');
  const rawName = p.startsWith('backend/src/routes/') && p.endsWith('.ts') ? path.basename(p, path.extname(p)) : resourceName;
  const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resource';
  return `backend/src/routes/${slug}.ts`;
}

function fallbackFrontendManifest(requirements: any, uiSpec?: any): FrontendManifest {
  const rawName = typeof requirements?.userMessage === 'string'
    ? requirements.userMessage.slice(0, 60)
    : typeof requirements?.summary === 'string'
      ? requirements.summary
      : typeof requirements?.app_type === 'string'
        ? requirements.app_type
        : 'Generated App';
  const appName = String(rawName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'generated-app';

  if (Array.isArray(uiSpec?.components) && uiSpec.components.length > 0) {
    const uiSpecComponents = (uiSpec.components as Array<{ name?: string; path?: string; purpose?: string }>)
      .slice(0, MAX_COMPONENTS)
      .map((c) => {
        const name = String(c.name || '').trim() || 'Section';
        const filePath = c.path && String(c.path).startsWith('src/components/')
          ? String(c.path)
          : `src/components/${name}.jsx`;
        return { path: filePath.endsWith('.jsx') ? filePath : `${filePath}.jsx`, name, purpose: String(c.purpose || `${name} component`) };
      });
    return { appName, dependencies: {}, apiResources: [], components: uiSpecComponents, styleNotes: 'Clean responsive application UI.' };
  }

  const authRequired = Boolean(requirements?.auth_required);
  const pages = Array.isArray(requirements?.pages) ? requirements.pages : [];
  const components = [
    ...(authRequired ? [{ path: 'src/components/Login.jsx', name: 'Login', purpose: 'Authentication form for email and password login.' }] : []),
    ...pages.slice(0, 3).map((page: any, i: number) => {
      const pageLabel = typeof page === 'string' ? page : String(page?.name || page?.title || page?.path || `Page ${i + 1}`);
      const slug = pageLabel.replace(/[^a-zA-Z0-9]/g, '') || `Page${i + 1}`;
      return { path: `src/components/${slug}.jsx`, name: slug, purpose: `${pageLabel} page content and functionality.` };
    }),
  ];

  if (components.length === 0) {
    components.push(
      { path: 'src/components/Overview.jsx', name: 'Overview', purpose: 'Core user workflow overview.' },
      { path: 'src/components/Workspace.jsx', name: 'Workspace', purpose: 'Primary interactive workspace.' }
    );
  }

  return { appName, dependencies: {}, apiResources: [], components: components.slice(0, MAX_COMPONENTS), styleNotes: 'Clean responsive application UI.' };
}

function fallbackFrontendApp(manifest: FrontendManifest, components: GeneratedFile[], hasBackend = false): GeneratedFile {
  const imports = components.map((file) => `import ${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} from './${file.path.replace(/^src\//, '')}';`).join('\n');
  const componentTags = components.map((file) => `        <${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} />`).join('\n');
  const apiInit = hasBackend ? `
  const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000';
  const [apiReady, setApiReady] = React.useState(false);

  React.useEffect(() => {
    fetch(\`\${API_BASE}/api/health\`)
      .then((res) => res.json())
      .then(() => setApiReady(true))
      .catch(() => setApiReady(false));
  }, []);
` : '';

  const apiStatus = hasBackend ? `
  {!apiReady && <div className="warning">Backend not connected. Using offline mode.</div>}` : '';

  return {
    path: 'src/App.jsx',
    content: `import React from 'react';
${imports}

export default function App() {
${apiInit}
  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">${escapeJsxText(manifest.appName, 'Generated App')}</p>
        <h1>${escapeJsxText(manifest.appName, 'Your App')}</h1>
        <p>A production-ready React application.</p>
      </section>
      <section className="content-grid">
${componentTags || '        <div className="panel"><h2>Ready</h2><p>Your app scaffold is ready for iteration.</p></div>'}
      </section>
${apiStatus}
    </main>
  );
}
`
  };
}

function fallbackFrontendCss(): GeneratedFile {
  return {
    path: 'src/index.css',
    content: `* { box-sizing: border-box; }
html, body, #root { margin: 0; min-height: 100%; }
body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #111827; }
button, input, textarea, select { font: inherit; }
.app-shell { min-height: 100vh; padding: 48px clamp(20px, 5vw, 72px); }
.hero { max-width: 920px; margin: 0 auto 32px; }
.eyebrow { margin: 0 0 10px; color: #2563eb; font-weight: 700; text-transform: uppercase; font-size: 0.78rem; }
h1 { margin: 0; font-size: clamp(2rem, 6vw, 4.5rem); line-height: 1; }
.hero p:last-child { color: #4b5563; font-size: 1.08rem; line-height: 1.7; max-width: 680px; }
.content-grid { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.06); }
.panel h2 { margin: 0 0 8px; font-size: 1.08rem; }
.panel p { margin: 0; color: #4b5563; line-height: 1.6; }
.warning { max-width: 1120px; margin: 16px auto 0; padding: 12px 14px; border-radius: 8px; background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; }
`
  };
}

function normalizeImportPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\.(jsx?|tsx?)$/, '').toLowerCase();
}

function validateManifestSemantics(manifest: FrontendManifest, requirements: any, projectSpec?: any, uiSpec?: any): void {
  const components = Array.isArray(manifest.components) ? manifest.components : [];
  if (components.length === 0) throw new Error('frontendManifest: components array is empty');

  const seenNames = new Set<string>();
  for (const component of components) {
    if (!component?.path || !component?.path.startsWith('src/components/') || !component.path.endsWith('.jsx')) {
      throw new Error(`frontendManifest: invalid component path ${component?.path || '(missing)'}`);
    }
    const purpose = String(component.purpose || '');
    const name = String(component.name || '');
    if (!purpose.trim() || containsPlaceholderText(purpose) || containsPlaceholderText(name)) {
      throw new Error(`frontendManifest: invalid component metadata for ${component.path}`);
    }
    if (seenNames.has(name)) {
      throw new Error(`frontendManifest: duplicate component name ${name}`);
    }
    seenNames.add(name);
  }

  const resources = Array.isArray(manifest.apiResources) ? manifest.apiResources : [];
  for (const resource of resources) {
    if (!resource?.name || !resource?.path || !String(resource.path).startsWith('/api/')) {
      throw new Error(`frontendManifest: invalid apiResource ${resource?.name || '(missing)'}`);
    }
  }

  const appName = String(manifest.appName || requirements?.userMessage || '').trim();
  if (projectSpec?.requirements?.website_type && !appName) throw new Error('frontendManifest: invalid appName from projectSpec');
  if (!appName || containsPlaceholderText(appName)) throw new Error('frontendManifest: invalid appName');

  if (uiSpec?.components?.length) {
    const requiredNames = new Set<string>(
      uiSpec.components
        .map((component: { name?: string }) => String(component?.name || '').trim())
        .filter((name: string) => name.length > 0)
    );
    for (const requiredName of requiredNames) {
      if (!seenNames.has(requiredName)) {
        logWarn('codeGenerationAgent:manifest-missing-uispec-component', { requiredName });
      }
    }
  }
}

function validateAppImports(appContent: string, componentFiles: GeneratedFile[], blueprint?: ProjectBlueprint, uiSpec?: any): void {
  const importPattern = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](.+?)['"];?$/gm;
  const declaredImports = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(appContent)) !== null) declaredImports.set(match[1], match[2]);

  for (const file of componentFiles) {
    const componentName = sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection');
    const expectedImportPath = `./${file.path.replace(/^src\//, '')}`;
    const importedPath = declaredImports.get(componentName);
    if (!importedPath) throw new Error(`frontendApp: missing import for ${componentName}`);
    if (normalizeImportPath(importedPath) !== normalizeImportPath(expectedImportPath)) {
      throw new Error(`frontendApp: import path mismatch for ${componentName} (expected ${expectedImportPath}, got ${importedPath})`);
    }
    const usagePattern = new RegExp(`<${componentName}(\\s|/|>)`);
    if (!usagePattern.test(appContent)) throw new Error(`frontendApp: missing rendered usage for ${componentName}`);
  }

  if (uiSpec?.components?.length) {
    for (const component of uiSpec.components) {
      const requiredName = String(component?.name || '').trim();
      if (requiredName) {
        const usagePattern = new RegExp(`<${requiredName}(\\s|/|>)`);
        if (!usagePattern.test(appContent)) {
          logWarn('codeGenerationAgent:app-missing-uispec-render', { requiredName });
        }
      }
    }
  }

  const blueprintNavigation = blueprint?.navigation;
  if (blueprintNavigation) {
    const declaredRoutes = new Set(blueprintNavigation.routes.map((route: { component: string }) => route.component));
    const rootComponentNames = new Set(componentFiles.map((file) => sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')));
    for (const route of blueprintNavigation.routes) {
      if (route.component !== 'App' && !rootComponentNames.has(route.component) && !declaredImports.has(route.component)) {
        throw new Error(`frontendApp: blueprint navigation references unknown component ${route.component}`);
      }
    }
    if (blueprintNavigation.routes.length > 0 && !declaredRoutes.has('App')) {
      throw new Error('frontendApp: blueprint navigation must include App as the root route component');
    }
  }

  if (containsPlaceholderText(appContent)) throw new Error('frontendApp: placeholder text detected');
}

function buildProjectManifest(frontend: FrontendManifest, backend: BackendManifest | undefined, modelRouting: ProjectManifest['technicalSpecs']['modelRouting']): ProjectManifest {
  const fileTree = [
    'package.json',
    'index.html',
    'vite.config.js',
    'src/main.jsx',
    'src/App.jsx',
    'src/index.css',
    ...(frontend.components || []).map((c) => sanitizeComponentPath(c.path || '', 0)),
    ...(backend ? ['backend/package.json', 'backend/src/index.ts', 'backend/src/db/database.ts', 'backend/db/init.sql', ...((backend.resources || []).map((r) => sanitizeRoutePath(`backend/src/routes/${r.name}.ts`, r.name || 'resource')))] : []),
  ];
  const componentRequirements = (frontend.components || []).map((component) => ({
    path: sanitizeComponentPath(component.path || '', 0),
    purpose: component.purpose || '',
    reviewerNotes: 'Must be a standalone React component and remain under 180 lines.',
  }));
  const queue = fileTree.map((pathName, index) => ({ id: `task-${index + 1}`, kind: 'file' as const, path: pathName, purpose: `Generate or verify ${pathName}` }));
  return {
    technicalSpecs: { stack: 'React 18 + Vite + Node/Express', modelRouting },
    fileTree,
    requirements: { frontend, backend },
    componentRequirements,
    project_task_queue: queue,
  };
}

function generateBackendManifest(systemDesign: any, requirements: any, llmProxy: LLMProxyClient, model: string): Promise<BackendManifest> {
  const userMessage = String(requirements?.userMessage || '').slice(0, 400);
  const systemPrompt = `Create a backend implementation manifest for Node.js + TypeScript + Express + Postgres for this app: "${userMessage}". Return ONLY JSON with shape: {"resources":[{"name":"...","routePath":"/api/...","tableName":"items","fields":[],"methods":[],"purpose":"..."}],"tables":[{"name":"items","columns":[],"purpose":"..."}]}. Use only shared tables with project_id columns. Never emit per-project table names.`;
  return generateJson(llmProxy, model, 'backendManifest', systemPrompt, { requirements, userDescription: userMessage, backendDesign: systemDesign?.backend || null, sharedTable: SHARED_TABLE_NAME, modification: null }, 1800)
    .then((parsed) => parseBackendManifest(parsed));
}

function parseBackendManifest(raw: unknown): BackendManifest {
  const manifest = assertObject(raw, 'backendManifest') as BackendManifest;
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const normalizedResources = resources.slice(0, MAX_BACKEND_ROUTES).map((resource, index) => {
    const name = String(resource?.name || `resource${index + 1}`);
    const routePath = String(resource?.routePath || `/api/${name}`);
    return {
      ...resource,
      name,
      routePath: routePath.startsWith('/api/') ? routePath : `/api/${name}`,
      tableName: SHARED_TABLE_NAME,
      methods: Array.isArray(resource?.methods) && resource.methods.length > 0 ? resource.methods : ['GET', 'POST'],
      purpose: String(resource?.purpose || `Data operations for ${name}`),
    };
  });

  const tables = Array.isArray(manifest.tables) ? manifest.tables : [];
  const normalizedTables = tables.slice(0, MAX_BACKEND_ROUTES).map((table) => ({
    ...table,
    name: SHARED_TABLE_NAME,
    columns: Array.isArray(table?.columns) && table.columns.length > 0 ? table.columns : SHARED_TABLE_COLUMNS,
    purpose: String(table?.purpose || 'Shared storage for project-scoped data'),
  }));

  return { resources: normalizedResources, tables: normalizedTables };
}

function sanitizeComponentName(rawName: string, index: number): string {
  return sanitizeIdentifier(rawName || `GeneratedSection${index + 1}`, `GeneratedSection${index + 1}`);
}

function frontendScaffold(manifest: FrontendManifest): GeneratedFile[] {
  const dependencies = { react: '^18.3.1', 'react-dom': '^18.3.1', ...(manifest.dependencies || {}) };
  delete (dependencies as Record<string, string>).vite;
  delete (dependencies as Record<string, string>)['@vitejs/plugin-react'];
  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: (manifest.appName || 'generated-project').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'generated-project',
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies,
        devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.20' }
      }, null, 2)
    },
    {
      path: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${manifest.appName || 'Generated App'}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`
    },
    {
      path: 'vite.config.js',
      content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
`
    },
    {
      path: 'src/main.jsx',
      content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
`
    },
  ];
}

function backendScaffold(): GeneratedFile[] {
  const packageJson = {
    name: 'generated-backend',
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'ts-node src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js',
    },
    dependencies: {
      express: '^4.19.0',
      pg: '^8.20.0',
      cors: '^2.8.5',
      dotenv: '^17.4.2',
    },
    devDependencies: {
      'ts-node': '^10.9.2',
      typescript: '^5.4.0',
      '@types/express': '^5.0.0',
      '@types/node': '^22.0.0',
      '@types/cors': '^2.8.17',
    },
  };

  return [
    {
      path: 'backend/package.json',
      content: JSON.stringify(packageJson, null, 2),
    },
    {
      path: 'backend/src/db/database.ts',
      content: `import { Pool } from 'pg';

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
export const pool = new Pool(connectionString ? { connectionString } : {});

export function query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query<T>(sql, params);
}
`,
    },
    {
      path: 'backend/src/index.ts',
      content: `import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './db/database.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

async function initDb() {
  try {
    const sql = readFileSync(path.join(__dirname, '../db/init.sql'), 'utf8');
    if (sql.trim()) await query(sql);
  } catch (error) {
    console.warn('DB init warning:', error instanceof Error ? error.message : String(error));
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (error) {
    res.status(200).json({ status: 'ok', db: 'unavailable', error: error instanceof Error ? error.message : String(error) });
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

initDb().then(() => app.listen(port, () => console.log(\`Backend on port \${port}\`)));
`,
    },
    {
      path: 'backend/db/init.sql',
      content: `CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`,
    },
  ];
}

function backendRouteFile(resource: NonNullable<BackendManifest['resources']>[number]): GeneratedFile {
  const routeFile = sanitizeRoutePath('', resource.name || 'resource');
  return {
    path: routeFile,
    content: `import express from 'express';
import { randomUUID } from 'crypto';
import { query } from '../db/database.ts';

const router = express.Router();
const tableName = '${SHARED_TABLE_NAME}';

router.get('/', async (req, res, next) => {
  try {
    const projectId = String(req.query.project_id || req.query.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    const result = await query(\`SELECT * FROM \${tableName} WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100\`, [projectId]);
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    const id = randomUUID();
    const name = String(req.body?.name || 'Untitled');
    const data = req.body || {};
    const result = await query(\`INSERT INTO \${tableName} (id, project_id, name, data) VALUES ($1, $2, $3, $4) RETURNING *\`, [id, projectId, name, data]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

export default router;
`
  };
}

function fallbackBackendManifest(): BackendManifest {
  return {
    resources: [
      {
        name: 'items',
        routePath: '/api/items',
        tableName: SHARED_TABLE_NAME,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        purpose: 'Default project data resource.'
      }
    ],
    tables: [
      {
        name: SHARED_TABLE_NAME,
        columns: SHARED_TABLE_COLUMNS,
        purpose: 'Shared project-scoped data table.'
      }
    ]
  };
}

async function generateJson(
  llmProxy: LLMProxyClient,
  model: string,
  label: string,
  systemPrompt: string,
  userPayload: unknown,
  maxTokens: number
): Promise<any> {
  let lastRaw = '';
  for (let jsonAttempt = 1; jsonAttempt <= 3; jsonAttempt++) {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ];
    if (jsonAttempt > 1 && lastRaw) {
      messages.push({ role: 'assistant', content: lastRaw.slice(0, 1200) });
      messages.push({ role: 'user', content: 'Return ONLY a valid JSON object. If you included prose or code fences, remove them. Do not wrap in markdown.' });
    }
    try {
      const completion = await llmProxy.chatCompletion(messages, model, 0.0, 0.9, maxTokens, 60_000);
      const content: string = completion.choices?.[0]?.message?.content || '';
      if (!content.trim()) throw new Error(`${label}: LLM returned empty response`);
      lastRaw = content;
      return parseJsonSafe(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`${label}:json-attempt-failed:${jsonAttempt}`, { error: message, rawSnippet: lastRaw.slice(0, 240) });
      if (jsonAttempt === 3) throw err;
    }
  }
  throw new Error(`${label}: all JSON self-heal attempts exhausted`);
}

async function generateFrontendManifest(systemDesign: any, requirements: any, modification: string | undefined, llmProxy: LLMProxyClient, model: string, uiSpec?: any): Promise<FrontendManifest> {
  const userMessage = String(requirements?.userMessage || '');
  const clarificationAnswers = requirements?.clarificationAnswers || {};
  const pages = Array.isArray(requirements?.pages) ? requirements.pages : [];
  const authRequired = Boolean(requirements?.auth_required);
  const uiSpecComponentHint = Array.isArray(uiSpec?.components) && uiSpec.components.length > 0
    ? `\n- The following components MUST appear in the components array with EXACTLY these names: ${(uiSpec.components as Array<{ name?: string }>).map((c) => c.name).filter(Boolean).join(', ')}`
    : '';

  const systemPrompt = `You are a React app architect. Generate a detailed implementation manifest for the app described by the user.

Return ONLY valid JSON with this exact shape (no markdown fences):
{
  "appName": "string",
  "dependencies": {},
  "apiResources": [],
  "components": [
    { "path": "src/components/ComponentName.jsx", "name": "ComponentName", "purpose": "what this component does" }
  ],
  "styleNotes": "string"
}

RULES:
- Always include 2-4 components in the components array that directly implement the user's requested features
- Component paths MUST start with src/components/ and end with .jsx
- If auth is required, include a Login/Auth component${authRequired ? ' — always include authentication UI' : ''}
- If there are specific pages requested (${pages.join(', ')}), map each to a component
- Base components on the user's actual description, not generic placeholders${uiSpecComponentHint}`;

  const parsed = await generateJson(llmProxy, model, 'frontendManifest', systemPrompt, {
    userDescription: userMessage,
    requirements,
    clarificationAnswers,
    frontendDesign: systemDesign?.frontend || null,
    uiSpecComponents: uiSpec?.components || null,
    modification: modification || null,
  }, 1800);

  const manifest = assertObject(parsed, 'frontendManifest') as FrontendManifest;
  let components = Array.isArray(manifest.components) ? manifest.components : [];
  if (components.length === 0) {
    const fallback = fallbackFrontendManifest(requirements, uiSpec);
    components = fallback.components || [];
    if (!manifest.appName) manifest.appName = fallback.appName;
  }

  const normalizedComponents = components.map((component, index) => {
    const fallbackName = `GeneratedSection${index + 1}`;
    const safeName = sanitizeIdentifier(component?.name || fallbackName, fallbackName);
    return {
      ...component,
      path: sanitizeComponentPath(component?.path || '', index),
      name: safeName,
    };
  });

  manifest.components = normalizedComponents;
  manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};

  if (Array.isArray(uiSpec?.components) && uiSpec.components.length > 0) {
    const manifestNames = new Set(manifest.components.map((c: any) => String(c.name || '')));
    const missing = (uiSpec.components as Array<{ name?: string; path?: string; purpose?: string }>)
      .filter((c) => c.name && !manifestNames.has(c.name));
    if (missing.length > 0) {
      const extra = missing.map((c) => ({
        path: `src/components/${c.name}.jsx`,
        name: c.name!,
        purpose: String(c.purpose || `${c.name} component`),
      }));
      manifest.components = [...manifest.components, ...extra];
      logWarn('codeGenerationAgent:manifest-reconciled-uispec', { added: extra.map((c) => c.name) });
    }
  }

  if (manifest.components.length > MAX_COMPONENTS && !Array.isArray(uiSpec?.components)) {
    manifest.components = manifest.components.slice(0, MAX_COMPONENTS);
  }

  return manifest;
}

async function generateFrontendComponent(
  component: { path: string; name?: string; purpose?: string },
  manifest: FrontendManifest,
  requirements: any,
  llmProxy: LLMProxyClient,
  model: string,
  uiSpec?: any,
  generatedDependencies?: Map<string, string>
): Promise<GeneratedFile> {
  const expectedPath = sanitizeComponentPath(component.path, 0);
  const componentName = sanitizeIdentifier(component.name || path.basename(expectedPath, '.jsx'), path.basename(expectedPath, '.jsx'));
  const userMessage = String(requirements?.userMessage || '').slice(0, 400);
  const componentSpec = uiSpec?.components?.find((c: any) => c.name === componentName);
  const dependencyCode = componentSpec?.dependencies
    ?.map((dep: string) => ({ dep, code: generatedDependencies?.get(dep)?.slice(0, 500) }))
    .filter((d: any) => d.code) || [];

  const systemPrompt = `Generate one production-quality React component for: "${userMessage || manifest.appName}".
Component purpose: ${component.purpose || componentName}
Component name: ${componentName}

${componentSpec ? `Props interface:
${JSON.stringify(componentSpec.props, null, 2)}

Render logic: ${componentSpec.renderLogic}
` : ''}

${dependencyCode.length > 0 ? `Already-generated dependencies (reference these imports):
${dependencyCode.map((d: any) => `${d.dep}: ${d.code}`).join('\n---\n')}
` : ''}

Return ONLY JSON: {"path":"${expectedPath}","content":"complete, implementation-ready JSX file with real content matching the purpose, not a stub"}

CRITICAL RULES:
- Component MUST be 100% functional and meaningful, NOT a stub or placeholder
- MUST include proper JSX structure with actual content/functionality matching the purpose
- MUST have all necessary imports
- MUST export as: export default function ${componentName}() { ... }
- If component needs state: use useState with meaningful initial values
- If component needs effects: use useEffect with proper dependencies
- If component is a leaf (no children): implement full feature
- If component is a parent: properly compose child components using correct imports
- No comments like "TODO" or "placeholder"`;

  const parsed = await generateJson(
    llmProxy,
    model,
    `frontendComponent:${expectedPath}`,
    systemPrompt,
    {
      component,
      appName: manifest.appName,
      requirements,
      componentName,
      userDescription: userMessage,
      componentSpec,
      dependencyCode: dependencyCode.length > 0 ? dependencyCode : undefined,
    },
    2400
  );

  return validateGeneratedFile(parsed, expectedPath, 'frontend', `frontendComponent:${expectedPath}`);
}

async function generateFrontendApp(
  manifest: FrontendManifest,
  requirements: any,
  systemDesign: any,
  modification: string | undefined,
  componentFiles: GeneratedFile[],
  llmProxy: LLMProxyClient,
  model: string,
  uiSpec?: any
): Promise<GeneratedFile> {
  const backendRequired = Boolean(systemDesign?.backend);
  const imports = componentFiles.map((file) => ({
    name: sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection'),
    importLine: `import ${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} from './${file.path.replace(/^src\//, '')}';`,
  }));
  const userMessage = String(requirements?.userMessage || '').slice(0, 500);
  const layoutInfo = uiSpec?.layoutStructure || {};

  const systemPrompt = `Generate src/App.jsx for a React + Vite app: "${userMessage || manifest.appName}".

App root structure: ${layoutInfo.appRoot || 'Main app wrapper'}
State management: ${layoutInfo.stateManagement || 'Props drilling'}
Navigation: ${layoutInfo.navigationStrategy || 'Single page'}

Component imports available:
${imports.map((i) => i.importLine).join('\n')}

${backendRequired ? `Backend is required. Initialize API_BASE constant:
const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000';

Include proper error handling for fetch calls and fallback UI states.
` : ''}

Return ONLY JSON: {"path":"src/App.jsx","content":"complete, fully-functional App.jsx file"}

CRITICAL RULES:
- App MUST be 100% functional, not a stub
- MUST properly compose all imported components
- MUST have real layout structure matching the purpose
- MUST handle state (useState, useEffect) for actual data flow
- ${backendRequired ? 'MUST initialize API_BASE and use it for all backend calls\nMUST handle loading/error states\nMUST have proper error boundaries' : 'MUST NOT try to use any backend API'}
- MUST export as: export default function App() { ... }
- Component composition must match the generation order: ${(uiSpec?.generationOrder || []).join(' -> ') || 'all components'}
- No stub code, no TODOs, no placeholders`;

  const parsed = await generateJson(
    llmProxy,
    model,
    'frontendApp',
    systemPrompt,
    {
      requirements,
      userDescription: userMessage,
      frontendDesign: systemDesign?.frontend || null,
      manifest,
      componentImports: imports,
      modification: modification || null,
      layoutInfo,
      backendRequired,
      uiSpec: uiSpec ? { generationOrder: uiSpec.generationOrder, navigationStrategy: uiSpec.navigationStrategy, stateManagementStrategy: uiSpec.stateManagementStrategy } : undefined,
    },
    3500
  );

  const appFile = validateGeneratedFile(parsed, 'src/App.jsx', 'frontend', 'frontendApp');
  const hasImports = imports.length > 0 && imports.some((i) => appFile.content.includes(i.name));
  const hasExport = appFile.content.includes('export default function App');
  const hasRender = appFile.content.includes('return (') || appFile.content.includes('return <');
  const hasApiBase = backendRequired ? appFile.content.includes('API_BASE') || appFile.content.includes('fetch') || appFile.content.includes('http') : true;

  if (!hasExport || !hasRender || !hasImports || !hasApiBase) {
    logWarn('frontendApp:semantic-check-failed', { hasExport, hasRender, hasImports, hasApiBase, backendRequired });
  }

  return appFile;
}

async function generateFrontendCss(manifest: FrontendManifest, requirements: any, appFile: GeneratedFile, componentFiles: GeneratedFile[], llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const userMessage = String(requirements?.userMessage || '').slice(0, 300);
  const systemPrompt = `Generate src/index.css for this React app: "${userMessage || manifest.appName}". Match the visual style to the app's purpose. Return ONLY JSON: {"path":"src/index.css","content":"complete CSS"}`;
  const parsed = await generateJson(llmProxy, model, 'frontendCss', systemPrompt, { manifest, requirements, appSnippet: appFile.content.slice(0, 4000), componentSnippets: componentFiles.map((f) => ({ path: f.path, content: f.content.slice(0, 1800) })) }, 2600);
  return validateGeneratedFile(parsed, 'src/index.css', 'frontend', 'frontendCss');
}

function backendRouteFallbackFiles(manifest: BackendManifest): GeneratedFile[] {
  const tables = Array.isArray(manifest.tables) && manifest.tables.length > 0 ? manifest.tables : [{ name: SHARED_TABLE_NAME, columns: SHARED_TABLE_COLUMNS }];
  return [
    ...backendScaffold(),
    {
      path: 'backend/db/init.sql',
      content: tables
        .map((table) => {
          const safeTable = String(table.name || SHARED_TABLE_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
          const columns = Array.isArray(table.columns) && table.columns.length > 0 ? table.columns.join(',\n  ') : SHARED_TABLE_COLUMNS.join(',\n  ');
          return `CREATE TABLE IF NOT EXISTS ${safeTable} (\n  ${columns}\n);`;
        })
        .join('\n\n') + '\n',
    },
  ];
}

function buildBackendFilesFromManifest(manifest: BackendManifest): GeneratedFile[] {
  const files = backendRouteFallbackFiles(manifest);
  const resources = (manifest.resources || []).slice(0, MAX_BACKEND_ROUTES);
  for (const resource of resources) {
    files.push(backendRouteFile(resource));
  }
  return files;
}

async function generateBackendInitSql(manifest: BackendManifest, requirements: any, llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const parsed = await generateJson(llmProxy, model, 'backendInitSql', 'Generate backend/db/init.sql. Return ONLY JSON.', { manifest, requirements, sharedTable: SHARED_TABLE_NAME }, 2200);
  const file = validateGeneratedFile(parsed, 'backend/db/init.sql', 'backend', 'backendInitSql');
  if (!/project_id/i.test(file.content) || !file.content.includes(SHARED_TABLE_NAME)) throw new Error(`backendInitSql: SQL must define shared table ${SHARED_TABLE_NAME} with project_id`);
  return file;
}

async function generateBackendFiles(systemDesign: any, requirements: any, projectId: string, modification: string | undefined, llmProxy: LLMProxyClient, model: string, events?: EventSink, blueprint?: ProjectBlueprint): Promise<GeneratedFile[]> {
  const partial = new Map<string, string>();
  if (!blueprint) throw new Error('codeGenerationAgent: validated blueprint is required before backend generation');
  const missingBlueprintFiles = blueprintMissingFiles(blueprint);
  if (missingBlueprintFiles.length > 0) throw new Error(`Validated blueprint is missing required files: ${missingBlueprintFiles.join(', ')}`);

  let manifest: BackendManifest;

  try {
    manifest = await generateBackendManifest(systemDesign, requirements, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:backend-manifest-fallback', { error: (err as Error).message });
    manifest = fallbackBackendManifest();
  }

  const backendFallbackFiles = buildBackendFilesFromManifest(manifest);
  backendFallbackFiles.forEach((file) => setFile(partial, file));
  events?.emit({ type: 'FILE_WRITTEN', filePath: 'backend/package.json', message: 'Generated backend scaffold: package.json', payload: { path: 'backend/package.json', content: partial.get('backend/package.json') ?? '' } });
  events?.emit({ type: 'FILE_WRITTEN', filePath: 'backend/src/db/database.ts', message: 'Generated backend scaffold: db/database.ts', payload: { path: 'backend/src/db/database.ts', content: partial.get('backend/src/db/database.ts') ?? '' } });
  events?.emit({ type: 'FILE_WRITTEN', filePath: 'backend/src/index.ts', message: 'Generated backend scaffold: src/index.ts', payload: { path: 'backend/src/index.ts', content: partial.get('backend/src/index.ts') ?? '' } });

  const artifactResults = await Promise.all([
    (async () => {
      try {
        const f = await generateBackendInitSql(manifest, requirements, llmProxy, model);
        setFile(partial, f);
        events?.emit({ type: 'FILE_WRITTEN', filePath: f.path, message: `Wrote ${f.path}`, payload: { path: f.path, content: f.content } });
        return { kind: 'sql', ok: true, path: f.path };
      } catch (err) {
        logWarn('codeGenerationAgent:init-sql-fallback', { error: (err as Error).message });
        const f = backendFallbackFiles.find((file) => file.path === 'backend/db/init.sql');
        if (f) {
          setFile(partial, f);
          events?.emit({ type: 'FILE_WRITTEN', filePath: f.path, message: `Wrote fallback ${f.path}`, payload: { path: f.path, content: f.content } });
        }
        return { kind: 'sql', ok: false, path: 'backend/db/init.sql', error: (err as Error).message };
      }
    })(),
    ...(manifest.resources || []).map((resource) => (async () => {
      const expectedPath = sanitizeRoutePath('', resource.name || 'resource');
      try {
        const route = backendRouteFile(resource);
        setFile(partial, route);
        events?.emit({ type: 'FILE_WRITTEN', filePath: route.path, message: `Wrote ${route.path}`, payload: { path: route.path, content: route.content } });
        return { kind: 'route', ok: true, path: route.path, resource: resource.name, expectedPath };
      } catch (err) {
        logWarn('codeGenerationAgent:route-fallback', { resource: resource.name, expectedPath, error: (err as Error).message });
        const route = backendRouteFallbackFiles(manifest).find((file) => file.path === expectedPath) || backendRouteFile(resource);
        setFile(partial, route);
        events?.emit({ type: 'FILE_WRITTEN', filePath: route.path, message: `Wrote fallback ${route.path}`, payload: { path: route.path, content: route.content } });
        return { kind: 'route', ok: false, path: route.path, resource: resource.name, expectedPath, error: (err as Error).message };
      }
    })()),
  ]);

  const failedArtifacts = artifactResults.filter((r) => !r.ok).map((r: any) => `${r.kind}:${r.expectedPath || r.path}${r.error ? ` (${r.error})` : ''}`);
  if (failedArtifacts.length > 0) {
    logWarn('codeGenerationAgent:backend-artifact-fallbacks', { failedArtifacts });
  }

  const files = Array.from(partial.entries()).map(([filePath, content]) => ({ path: filePath, content }));
  const missingRequired = Array.from(BACKEND_REQUIRED).filter((required) => !files.some((f) => f.path === required));
  if (missingRequired.length > 0) {
    logWarn('codeGenerationAgent:backend-missing-required', { missingRequired, files: files.map((f) => f.path) });
    for (const fallback of backendFallbackFiles) {
      if (!files.some((f) => f.path === fallback.path)) files.push(fallback);
    }
  }

  return files;
}

export async function codeGenerationAgent(input: any) {
  debug('codeGenerationAgent:start', { projectId: input?.projectId });
  if (!input) throw new Error('codeGenerationAgent: input required');
  const rawBlueprint = input.blueprint ? validateProjectBlueprint(input.blueprint, { requirements: input.requirements }) : undefined;
  if (!rawBlueprint) throw new Error('codeGenerationAgent: validated blueprint is required before code generation');
  const reviewedBlueprint = rawBlueprint.approved?.approved ? rawBlueprint : await reviewerAgent({ blueprint: rawBlueprint, reviewerName: 'Code Generation Gate' });
  if (!reviewedBlueprint.approved?.approved) {
    throw new Error(`codeGenerationAgent: blueprint approval required before code generation${reviewedBlueprint.approved?.notes?.length ? `: ${reviewedBlueprint.approved.notes.join('; ')}` : ''}`);
  }
  const blueprint = assertBlueprintIntegrationSafety(reviewedBlueprint);

  const { model, apiKey } = getModelConfigForTask('code_generation');
  const llmProxy = new LLMProxyClient({ apiKey });
  const events: EventSink | undefined = typeof input.emitEvent === 'function' ? { emit: input.emitEvent } : undefined;

  const retrievedPatches: string[] = [];

  const hasBackend = Boolean(input.projectSpec?.requirements?.backend_required ?? input.systemDesign?.backend);
  const projectId: string = input.projectId || 'unknown';
  const uiSpec = input.uiSpec;

  debug('codeGenerationAgent:parallel-start', { projectId, hasBackend, hasUISpec: !!uiSpec });
  const manifestOut: { value?: ProjectManifest } = {};

  const [frontendResult, backendResult] = await Promise.allSettled([
    Promise.resolve([] as GeneratedFile[]),
    hasBackend ? generateBackendFiles(input.systemDesign, input.requirements, projectId, input.modification, llmProxy, model, events, blueprint) : Promise.resolve([] as GeneratedFile[]),
  ]);

  const frontendFiles = frontendResult.status === 'fulfilled' ? frontendResult.value : [];

  const backendFiles = backendResult.status === 'fulfilled'
    ? backendResult.value
    : (() => {
        logError('codeGenerationAgent:backend-failed', backendResult.reason);
        throw new Error(`Backend code generation failed: ${(backendResult.reason as Error)?.message || String(backendResult.reason)}`);
      })();

  const projectManifest = manifestOut.value;

  const fileMap = new Map([...frontendFiles, ...backendFiles].map((f) => [normalizePath(f.path), f.content]));

  for (const required of ['package.json', 'src/App.jsx', 'src/index.css'] as const) {
    if (!fileMap.has(required)) {
      logWarn('codeGenerationAgent:repair-missing', { path: required });
      events?.emit({ type: 'AGENT_THINKING', message: `Repairing missing file: ${required}` });
      if (required === 'src/App.jsx') {
        const repairedApp = fallbackFrontendApp(fallbackFrontendManifest(input.requirements, uiSpec), frontendFiles.filter((f) => f.path.startsWith('src/components/')), hasBackend);
        fileMap.set(required, repairedApp.content);
        events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Fallback repair for ${required}`, payload: { path: required, content: repairedApp.content } });
      } else if (required === 'src/index.css') {
        const fallback = fallbackFrontendCss();
        fileMap.set(required, fallback.content);
        events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Fallback repair for ${required}`, payload: { path: required, content: fallback.content } });
      } else if (required === 'package.json') {
        const pkgFile = frontendScaffold(fallbackFrontendManifest(input.requirements, uiSpec)).find((f) => f.path === 'package.json');
        if (pkgFile) {
          fileMap.set(required, pkgFile.content);
          events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Fallback repair for ${required}`, payload: { path: required, content: pkgFile.content } });
        }
      }
    }
  }

  if (hasBackend) {
    const backendFallbackFiles = backendRouteFallbackFiles(fallbackBackendManifest());
    for (const required of Array.from(BACKEND_REQUIRED)) {
      if (!fileMap.has(required)) {
        logWarn('codeGenerationAgent:repair-missing-backend', { path: required });
        const fallback = backendFallbackFiles.find((f) => f.path === required);
        if (fallback) {
          fileMap.set(required, fallback.content);
          events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Repaired missing backend file: ${required}`, payload: { path: required, content: fallback.content } });
        }
      }
    }
  }

  const appContent = fileMap.get('src/App.jsx') ?? '';
  if (appContent.length < 200) {
    logWarn('codeGenerationAgent:repair-stub-app', { contentLength: appContent.length });
    const frontendManifest = fallbackFrontendManifest(input.requirements, uiSpec);
    const componentFiles = frontendFiles.filter((f: GeneratedFile) => f.path.startsWith('src/components/'));
    const repairedStubApp = fallbackFrontendApp(frontendManifest, componentFiles, hasBackend);
    fileMap.set('src/App.jsx', repairedStubApp.content);
    events?.emit({ type: 'FILE_WRITTEN', filePath: 'src/App.jsx', message: 'Repaired stub App.jsx', payload: { path: 'src/App.jsx', content: repairedStubApp.content } });
  }

  const allFiles = Array.from(fileMap.entries()).map(([pathName, content]) => ({ path: pathName, content }));

  debug('codeGenerationAgent:done', {
    projectId,
    fileCount: allFiles.length,
    hasBackend,
    frontendCount: frontendFiles.length,
    backendCount: backendFiles.length,
    retrievedPatches: retrievedPatches.length,
    hasUISpec: !!uiSpec,
  });

  return {
    files: allFiles,
    patch: '',
    hasBackend,
    projectId,
    generationMode: 'spec-aware-dependency-ordered',
    project_task_queue: projectManifest?.project_task_queue || [],
  };
}

function escapeJsxText(value: string | undefined, fallback: string): string {
  return String(value || fallback)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}
