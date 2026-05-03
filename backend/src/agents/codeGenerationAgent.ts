import path from 'path';
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';
import { debug, error as logError, warn as logWarn } from '../utils/logger';

type GeneratedFile = { path: string; content: string };

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

const FRONTEND_REQUIRED = new Set(['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css']);
const FRONTEND_ALLOWED_PREFIXES = ['src/components/', 'src/pages/'];
const BACKEND_REQUIRED = new Set(['backend/package.json', 'backend/index.js', 'backend/db/database.js', 'backend/db/init.sql']);
const BACKEND_ALLOWED_PREFIXES = ['backend/routes/', 'backend/middleware/'];
const MAX_COMPONENTS = 6;
const MAX_BACKEND_ROUTES = 8;
const BAN_LIST = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.pnpm-store', 'bun.lockb',
];

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function stripMarkdownFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

function parseJsonSafe(content: string): any {
  const cleaned = stripMarkdownFences(content);
  try { return JSON.parse(cleaned); } catch {}
  const text = cleaned.trim();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(i, j + 1)); } catch { break; }
        }
      }
    }
  }
  throw new Error(`No valid JSON found in LLM response. Snippet: ${content.replace(/\s+/g, ' ').slice(0, 220)}`);
}

function assertObject(value: any, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// LLM call with retry
// ---------------------------------------------------------------------------

async function callWithRetry(
  llmProxy: LLMProxyClient,
  messages: Array<{ role: string; content: string }>,
  model: string,
  maxTokens: number,
  timeoutMs: number,
  maxRetries = 2,
  label = 'llmCall'
): Promise<string> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await llmProxy.chatCompletion(messages, model, 0.0, 0.9, maxTokens, timeoutMs);
      const content: string = completion.choices?.[0]?.message?.content || '';
      if (typeof content === 'string' && /^[\s]*<!doctype|<html/i.test(content)) {
        throw new Error(`${label}: LLM returned HTML error page in assistant content. Snippet: ${content.replace(/\s+/g, ' ').slice(0, 220)}`);
      }
      if (!content.trim()) throw new Error(`${label}: LLM returned empty response`);
      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logWarn(`${label}:attempt${attempt}`, { error: lastError.message, maxTokens });
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastError;
}

async function generateJson(
  llmProxy: LLMProxyClient,
  model: string,
  label: string,
  systemPrompt: string,
  userPayload: unknown,
  maxTokens: number
): Promise<any> {
  const raw = await callWithRetry(
    llmProxy,
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(userPayload) }],
    model,
    maxTokens,
    120_000,
    2,
    label
  );
  return parseJsonSafe(raw);
}

// ---------------------------------------------------------------------------
// File validation and merging
// ---------------------------------------------------------------------------

function normalizeGeneratedPath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replace(/\\/g, '/');
}

function isAllowedPath(filePath: string, scope: 'frontend' | 'backend'): boolean {
  const p = normalizeGeneratedPath(filePath);
  if (p.includes('..') || path.isAbsolute(p)) return false;
  if (BAN_LIST.some(b => p === b || p.startsWith(`${b}/`))) return false;
  if (p.startsWith('node_modules') || p.includes('/node_modules/')) return false;
  if (p.startsWith('dist/') || p === 'dist') return false;

  if (scope === 'frontend') {
    return FRONTEND_REQUIRED.has(p) || FRONTEND_ALLOWED_PREFIXES.some(prefix => p.startsWith(prefix));
  }
  return BACKEND_REQUIRED.has(p) || BACKEND_ALLOWED_PREFIXES.some(prefix => p.startsWith(prefix));
}

function validateGeneratedFile(file: any, expectedPath: string | undefined, scope: 'frontend' | 'backend', label: string): GeneratedFile {
  const obj = assertObject(file, label);
  const filePath = normalizeGeneratedPath(String(obj.path || expectedPath || ''));
  const content = obj.content;
  if (!filePath) throw new Error(`${label}: missing path`);
  if (expectedPath && filePath !== expectedPath) throw new Error(`${label}: expected path ${expectedPath}, got ${filePath}`);
  if (!isAllowedPath(filePath, scope)) throw new Error(`${label}: invalid or disallowed path ${filePath}`);
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${label}: missing content for ${filePath}`);
  return { path: filePath, content };
}

function setFile(files: Map<string, string>, file: GeneratedFile) {
  files.set(normalizeGeneratedPath(file.path), file.content);
}

function filterAndNormalizeFiles(files: GeneratedFile[]): GeneratedFile[] {
  const seen = new Map<string, string>();
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    const p = normalizeGeneratedPath(f.path);
    const scope = p.startsWith('backend/') ? 'backend' : 'frontend';
    if (!isAllowedPath(p, scope)) continue;
    seen.set(p, f.content);
  }
  return Array.from(seen.entries()).map(([path, content]) => ({ path, content }));
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_$]/g, '');
  return cleaned && /^[a-zA-Z_$]/.test(cleaned) ? cleaned : fallback;
}

function sanitizeComponentPath(rawPath: string, index: number): string {
  const p = normalizeGeneratedPath(rawPath || '');
  if (p.startsWith('src/components/') && p.endsWith('.jsx') && !p.includes('..')) return p;
  return `src/components/GeneratedSection${index + 1}.jsx`;
}

function sanitizeRoutePath(rawPath: string, resourceName: string): string {
  const p = normalizeGeneratedPath(rawPath || '');
  const rawName = p.startsWith('backend/routes/') && p.endsWith('.js')
    ? path.basename(p, '.js')
    : resourceName;
  const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resource';
  return `backend/routes/${slug}.js`;
}

function escapeJsxText(value: string | undefined, fallback: string): string {
  return String(value || fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Deterministic scaffolds
// ---------------------------------------------------------------------------

function frontendScaffold(manifest: FrontendManifest): GeneratedFile[] {
  const dependencies = {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
    ...(manifest.dependencies || {}),
  };
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
        devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.20' },
      }, null, 2),
    },
    {
      path: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${manifest.appName || 'Generated App'}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'vite.config.js',
      content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    },
    {
      path: 'src/main.jsx',
      content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
    },
  ];
}

function backendScaffold(manifest: BackendManifest, tablePrefix: string): GeneratedFile[] {
  const resources = (manifest.resources || []).slice(0, MAX_BACKEND_ROUTES);
  const imports: string[] = [];
  const mounts: string[] = [];

  resources.forEach((resource, index) => {
    const routeFile = sanitizeRoutePath(`backend/routes/${resource.name || `resource-${index + 1}`}.js`, resource.name || `resource-${index + 1}`);
    const varName = sanitizeIdentifier(`${resource.name || `resource${index + 1}`}Router`, `resource${index + 1}Router`);
    imports.push(`import ${varName} from './routes/${path.basename(routeFile)}';`);
    mounts.push(`app.use('${resource.routePath || `/api/${resource.name || `resource-${index + 1}`}`}', ${varName});`);
  });

  return [
    {
      path: 'backend/package.json',
      content: JSON.stringify({
        name: 'generated-backend',
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { start: 'node index.js', build: 'echo done' },
        dependencies: { express: '^4.19.0', pg: '^8.20.0', cors: '^2.8.5' },
      }, null, 2),
    },
    {
      path: 'backend/db/database.js',
      content: `import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';

export const pool = new Pool(connectionString ? { connectionString } : {});

export function query(sql, params = []) {
  return pool.query(sql, params);
}
`,
    },
    {
      path: 'backend/index.js',
      content: `import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from './db/database.js';
${imports.join('\n')}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

${mounts.join('\n')}

async function initDb() {
  try {
    const sql = readFileSync(join(__dirname, 'db/init.sql'), 'utf8');
    if (sql.trim()) await query(sql);
    console.log('DB initialized');
  } catch (error) {
    console.warn('DB init warning:', error.message);
  }
}

app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', tablePrefix: '${tablePrefix}' });
  } catch (error) {
    res.status(200).json({ status: 'ok', db: 'unavailable', error: error.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

initDb().then(() => app.listen(port, () => console.log(\`Backend on port \${port}\`)));
`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Frontend staged generation
// ---------------------------------------------------------------------------

async function generateFrontendManifest(
  systemDesign: any,
  requirements: any,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string
): Promise<FrontendManifest> {
  const systemPrompt = `Create a compact implementation manifest for a React + Vite app.
Return ONLY JSON with:
{
  "appName": "short-kebab-name",
  "dependencies": {"package": "version"},
  "apiResources": [{"name":"string","path":"/api/name","methods":["GET"],"purpose":"string"}],
  "components": [{"path":"src/components/Name.jsx","name":"Name","purpose":"string"}],
  "styleNotes": "short string"
}
Rules:
- Keep components to at most ${MAX_COMPONENTS}.
- Include only dependencies that are truly needed beyond react/react-dom.
- Use only Vite-safe React code; no Tailwind/shadcn unless explicitly required.
- No file contents.`;

  const parsed = await generateJson(llmProxy, model, 'frontendManifest', systemPrompt, {
    requirements,
    frontendDesign: systemDesign?.frontend || null,
    authDesign: systemDesign?.auth || null,
    hasBackend: Boolean(systemDesign?.backend),
    backendDesign: systemDesign?.backend || null,
    modification: modification || null,
  }, 1800);

  const manifest = assertObject(parsed, 'frontendManifest') as FrontendManifest;
  const components = Array.isArray(manifest.components) ? manifest.components : [];
  manifest.components = components
    .slice(0, MAX_COMPONENTS)
    .map((component, index) => ({
      ...component,
      path: sanitizeComponentPath(component?.path || '', index),
      name: sanitizeIdentifier(component?.name || `GeneratedSection${index + 1}`, `GeneratedSection${index + 1}`),
    }));
  manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
  return manifest;
}

async function generateFrontendComponent(
  component: { path: string; name?: string; purpose?: string },
  manifest: FrontendManifest,
  requirements: any,
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile> {
  const expectedPath = sanitizeComponentPath(component.path, 0);
  const componentName = sanitizeIdentifier(component.name || path.basename(expectedPath, '.jsx'), path.basename(expectedPath, '.jsx'));
  const systemPrompt = `Generate one small React component file.
Return ONLY JSON: {"path":"${expectedPath}","content":"complete file content"}
Rules:
- Export default function ${componentName}().
- No external imports except React if needed.
- Keep it focused and under 180 lines.
- Use CSS class names; styles belong in src/index.css.
- No markdown, no explanations.`;

  const parsed = await generateJson(llmProxy, model, `frontendComponent:${expectedPath}`, systemPrompt, {
    component,
    appName: manifest.appName,
    requirements,
  }, 2200);
  return validateGeneratedFile(parsed, expectedPath, 'frontend', `frontendComponent:${expectedPath}`);
}

async function generateFrontendApp(
  manifest: FrontendManifest,
  requirements: any,
  systemDesign: any,
  modification: string | undefined,
  componentFiles: GeneratedFile[],
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile> {
  const imports = componentFiles.map((file) => {
    const name = sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection');
    const relative = `./${file.path.replace(/^src\//, '')}`;
    return { name, importLine: `import ${name} from '${relative}';` };
  });
  const systemPrompt = `Generate src/App.jsx for a React + Vite app.
Return ONLY JSON: {"path":"src/App.jsx","content":"complete file content"}
Rules:
- Use functional React components.
- Import generated components exactly as provided.
- Use const API_BASE = import.meta.env.VITE_API_BASE_URL || ''; when making backend calls.
- Do not hardcode localhost.
- Keep the file under 260 lines.
- No markdown, no explanations.`;

  const parsed = await generateJson(llmProxy, model, 'frontendApp', systemPrompt, {
    requirements,
    frontendDesign: systemDesign?.frontend || null,
    backendDesign: systemDesign?.backend || null,
    authDesign: systemDesign?.auth || null,
    manifest,
    componentImports: imports,
    modification: modification || null,
  }, 3200);
  return validateGeneratedFile(parsed, 'src/App.jsx', 'frontend', 'frontendApp');
}

async function generateFrontendCss(
  manifest: FrontendManifest,
  requirements: any,
  appFile: GeneratedFile,
  componentFiles: GeneratedFile[],
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile> {
  const systemPrompt = `Generate src/index.css for the React app.
Return ONLY JSON: {"path":"src/index.css","content":"complete CSS"}
Rules:
- Include base reset for body/#root.
- Style class names used by App/components.
- Keep it responsive.
- No external font imports.
- Keep under 260 lines.
- No markdown, no explanations.`;

  const parsed = await generateJson(llmProxy, model, 'frontendCss', systemPrompt, {
    manifest,
    requirements,
    appSnippet: appFile.content.slice(0, 4000),
    componentSnippets: componentFiles.map(f => ({ path: f.path, content: f.content.slice(0, 1800) })),
  }, 2600);
  return validateGeneratedFile(parsed, 'src/index.css', 'frontend', 'frontendCss');
}

function fallbackFrontendApp(manifest: FrontendManifest, components: GeneratedFile[]): GeneratedFile {
  const imports = components.map(file => {
    const name = sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection');
    return `import ${name} from './${file.path.replace(/^src\//, '')}';`;
  }).join('\n');
  const componentTags = components.map(file => {
    const name = sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection');
    return `        <${name} />`;
  }).join('\n');
  return {
    path: 'src/App.jsx',
    content: `import React from 'react';
${imports}

export default function App() {
  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">${escapeJsxText(manifest.appName, 'Generated App')}</p>
        <h1>${escapeJsxText(manifest.appName, 'Your generated app')}</h1>
        <p>Built from your requirements with a focused, production-ready React interface.</p>
      </section>
      <section className="content-grid">
${componentTags || '        <div className="panel"><h2>Ready</h2><p>Your app scaffold is ready for iteration.</p></div>'}
      </section>
    </main>
  );
}
`,
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
.eyebrow { margin: 0 0 10px; color: #2563eb; font-weight: 700; text-transform: uppercase; font-size: 0.78rem; letter-spacing: 0; }
h1 { margin: 0; font-size: clamp(2rem, 6vw, 4.5rem); line-height: 1; letter-spacing: 0; }
.hero p:last-child { color: #4b5563; font-size: 1.08rem; line-height: 1.7; max-width: 680px; }
.content-grid { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.06); }
.panel h2 { margin: 0 0 8px; font-size: 1.08rem; }
.panel p { margin: 0; color: #4b5563; line-height: 1.6; }
`,
  };
}

function fallbackFrontendManifest(requirements: any): FrontendManifest {
  const summary = typeof requirements?.summary === 'string'
    ? requirements.summary
    : typeof requirements?.app_type === 'string'
      ? requirements.app_type
      : 'Generated App';
  return {
    appName: String(summary).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'generated-app',
    dependencies: {},
    apiResources: [],
    components: [
      { path: 'src/components/Overview.jsx', name: 'Overview', purpose: 'Summarize the core user workflow.' },
      { path: 'src/components/Workspace.jsx', name: 'Workspace', purpose: 'Present the primary interactive area.' },
    ],
    styleNotes: 'Clean responsive application UI.',
  };
}

async function generateFrontendFiles(
  systemDesign: any,
  requirements: any,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile[]> {
  const partial = new Map<string, string>();
  let manifest: FrontendManifest;
  try {
    manifest = await generateFrontendManifest(systemDesign, requirements, modification, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:frontend-manifest-fallback', { error: (err as Error).message });
    manifest = fallbackFrontendManifest(requirements);
  }
  frontendScaffold(manifest).forEach(file => setFile(partial, file));
  debug('codeGenerationAgent:frontend-scaffold', { fileCount: partial.size, components: manifest.components?.length || 0 });

  const componentFiles: GeneratedFile[] = [];
  for (const component of manifest.components || []) {
    try {
      const file = await generateFrontendComponent(component, manifest, requirements, llmProxy, model);
      setFile(partial, file);
      componentFiles.push(file);
    } catch (err) {
      logWarn('codeGenerationAgent:component-fallback', { path: component.path, error: (err as Error).message });
      const fallback: GeneratedFile = {
        path: sanitizeComponentPath(component.path, componentFiles.length),
        content: `import React from 'react';

export default function ${sanitizeIdentifier(component.name || path.basename(component.path, '.jsx'), 'GeneratedSection')}() {
  return (
    <article className="panel">
      <h2>${escapeJsxText(component.name, 'Feature')}</h2>
      <p>${escapeJsxText(component.purpose, 'This section is ready for project-specific content.')}</p>
    </article>
  );
}
`,
      };
      setFile(partial, fallback);
      componentFiles.push(fallback);
    }
  }

  let appFile: GeneratedFile;
  try {
    appFile = await generateFrontendApp(manifest, requirements, systemDesign, modification, componentFiles, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:app-fallback', { error: (err as Error).message, partialFiles: partial.size });
    appFile = fallbackFrontendApp(manifest, componentFiles);
  }
  setFile(partial, appFile);

  let cssFile: GeneratedFile;
  try {
    cssFile = await generateFrontendCss(manifest, requirements, appFile, componentFiles, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:css-fallback', { error: (err as Error).message, partialFiles: partial.size });
    cssFile = fallbackFrontendCss();
  }
  setFile(partial, cssFile);

  return Array.from(partial.entries()).map(([filePath, content]) => ({ path: filePath, content }));
}

// ---------------------------------------------------------------------------
// Backend staged generation
// ---------------------------------------------------------------------------

async function generateBackendManifest(
  systemDesign: any,
  requirements: any,
  tablePrefix: string,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string
): Promise<BackendManifest> {
  const systemPrompt = `Create a compact backend implementation manifest for Node + Express + Postgres.
Return ONLY JSON:
{
  "resources":[{"name":"items","routePath":"/api/items","tableName":"${tablePrefix}items","fields":["id TEXT PRIMARY KEY"],"methods":["GET","POST"],"purpose":"string"}],
  "tables":[{"name":"${tablePrefix}items","columns":["id TEXT PRIMARY KEY"],"purpose":"string"}]
}
Rules:
- Table names must start with "${tablePrefix}".
- Keep resources to at most ${MAX_BACKEND_ROUTES}.
- No file contents.`;

  const parsed = await generateJson(llmProxy, model, 'backendManifest', systemPrompt, {
    requirements,
    backendDesign: systemDesign?.backend || null,
    databaseDesign: systemDesign?.database || null,
    authDesign: systemDesign?.auth || null,
    tablePrefix,
    modification: modification || null,
  }, 1800);
  const manifest = assertObject(parsed, 'backendManifest') as BackendManifest;
  manifest.resources = Array.isArray(manifest.resources) ? manifest.resources.slice(0, MAX_BACKEND_ROUTES) : [];
  manifest.tables = Array.isArray(manifest.tables) ? manifest.tables : [];
  return manifest;
}

async function generateBackendInitSql(
  manifest: BackendManifest,
  tablePrefix: string,
  requirements: any,
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile> {
  const systemPrompt = `Generate backend/db/init.sql.
Return ONLY JSON: {"path":"backend/db/init.sql","content":"complete SQL"}
Rules:
- Use CREATE TABLE IF NOT EXISTS.
- Every table name must start with "${tablePrefix}".
- Use Postgres-compatible SQL.
- Keep it concise.
- No markdown, no explanations.`;

  const parsed = await generateJson(llmProxy, model, 'backendInitSql', systemPrompt, {
    manifest,
    requirements,
    tablePrefix,
  }, 2200);
  const file = validateGeneratedFile(parsed, 'backend/db/init.sql', 'backend', 'backendInitSql');
  if (!file.content.includes(tablePrefix)) {
    throw new Error(`backendInitSql: SQL does not include required table prefix ${tablePrefix}`);
  }
  return file;
}

async function generateBackendRoute(
  resource: NonNullable<BackendManifest['resources']>[number],
  routePath: string,
  tablePrefix: string,
  requirements: any,
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile> {
  const expectedPath = sanitizeRoutePath('', resource.name || 'resource');
  const systemPrompt = `Generate one Express router file.
Return ONLY JSON: {"path":"${expectedPath}","content":"complete JS file"}
Rules:
- Use import { query } from '../db/database.js';
- Export default router.
- Include try/catch around async handlers.
- Use router.get('/', ...), router.post('/', ...), router.put('/:id', ...), router.delete('/:id', ...) as needed.
- Use only tables starting with "${tablePrefix}".
- Keep under 240 lines.
- No markdown, no explanations.`;

  const parsed = await generateJson(llmProxy, model, `backendRoute:${expectedPath}`, systemPrompt, {
    resource,
    routePath,
    requirements,
    tablePrefix,
  }, 3000);
  return validateGeneratedFile(parsed, expectedPath, 'backend', `backendRoute:${expectedPath}`);
}

function fallbackInitSql(manifest: BackendManifest, tablePrefix: string): GeneratedFile {
  const resources = manifest.resources && manifest.resources.length > 0
    ? manifest.resources
    : [{ name: 'items', tableName: `${tablePrefix}items` }];
  const statements = resources.map(resource => {
    const table = String(resource.tableName || `${tablePrefix}${resource.name || 'items'}`).replace(/[^a-zA-Z0-9_]/g, '_');
    const safeTable = table.startsWith(tablePrefix) ? table : `${tablePrefix}${table}`;
    return `CREATE TABLE IF NOT EXISTS ${safeTable} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;
  }).join('\n\n');
  return { path: 'backend/db/init.sql', content: `${statements}\n` };
}

function fallbackRoute(resource: NonNullable<BackendManifest['resources']>[number], tablePrefix: string): GeneratedFile {
  const routeFile = sanitizeRoutePath('', resource.name || 'items');
  const table = String(resource.tableName || `${tablePrefix}${resource.name || 'items'}`).replace(/[^a-zA-Z0-9_]/g, '_');
  const safeTable = table.startsWith(tablePrefix) ? table : `${tablePrefix}${table}`;
  return {
    path: routeFile,
    content: `import express from 'express';
import { randomUUID } from 'crypto';
import { query } from '../db/database.js';

const router = express.Router();
const tableName = '${safeTable}';

router.get('/', async (req, res, next) => {
  try {
    const result = await query(\`SELECT * FROM \${tableName} ORDER BY created_at DESC LIMIT 100\`);
    res.json({ items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const id = randomUUID();
    const name = req.body?.name || 'Untitled';
    const data = req.body || {};
    const result = await query(
      \`INSERT INTO \${tableName} (id, name, data) VALUES ($1, $2, $3) RETURNING *\`,
      [id, name, data]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

export default router;
`,
  };
}

function fallbackBackendManifest(tablePrefix: string): BackendManifest {
  return {
    resources: [
      { name: 'items', routePath: '/api/items', tableName: `${tablePrefix}items`, methods: ['GET', 'POST'], purpose: 'Default project data resource.' },
    ],
    tables: [
      { name: `${tablePrefix}items`, columns: ['id TEXT PRIMARY KEY', 'name TEXT NOT NULL', 'data JSONB'], purpose: 'Default project data table.' },
    ],
  };
}

async function generateBackendFiles(
  systemDesign: any,
  requirements: any,
  projectId: string,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile[]> {
  const partial = new Map<string, string>();
  const safeId = projectId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
  const tablePrefix = `proj_${safeId}_`;
  let manifest: BackendManifest;
  try {
    manifest = await generateBackendManifest(systemDesign, requirements, tablePrefix, modification, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:backend-manifest-fallback', { error: (err as Error).message });
    manifest = fallbackBackendManifest(tablePrefix);
  }

  if (!manifest.resources || manifest.resources.length === 0) {
    manifest.resources = [{ name: 'items', routePath: '/api/items', tableName: `${tablePrefix}items`, methods: ['GET', 'POST'] }];
  }
  manifest.resources = manifest.resources.map((resource, index) => ({
    ...resource,
    name: resource.name || `resource${index + 1}`,
    routePath: resource.routePath || `/api/${resource.name || `resource-${index + 1}`}`,
    tableName: String(resource.tableName || `${tablePrefix}${resource.name || `resource${index + 1}`}`).startsWith(tablePrefix)
      ? String(resource.tableName || `${tablePrefix}${resource.name || `resource${index + 1}`}`)
      : `${tablePrefix}${String(resource.tableName || resource.name || `resource${index + 1}`).replace(/[^a-zA-Z0-9_]/g, '_')}`,
  }));

  backendScaffold(manifest, tablePrefix).forEach(file => setFile(partial, file));
  debug('codeGenerationAgent:backend-scaffold', { fileCount: partial.size, routes: manifest.resources.length });

  let initSql: GeneratedFile;
  try {
    initSql = await generateBackendInitSql(manifest, tablePrefix, requirements, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:init-sql-fallback', { error: (err as Error).message });
    initSql = fallbackInitSql(manifest, tablePrefix);
  }
  setFile(partial, initSql);

  for (const resource of manifest.resources) {
    try {
      const route = await generateBackendRoute(resource, resource.routePath || '/', tablePrefix, requirements, llmProxy, model);
      setFile(partial, route);
    } catch (err) {
      logWarn('codeGenerationAgent:route-fallback', { resource: resource.name, error: (err as Error).message });
      setFile(partial, fallbackRoute(resource, tablePrefix));
    }
  }

  return Array.from(partial.entries()).map(([filePath, content]) => ({ path: filePath, content }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function codeGenerationAgent(input: any) {
  debug('codeGenerationAgent:start', { projectId: input?.projectId });
  if (!input) throw new Error('codeGenerationAgent: input required');

  const { model, apiKey } = getModelConfigForTask('code_generation');
  const llmProxy = new LLMProxyClient({ apiKey });

  let retrievedPatches: string[] = [];
  try {
    const basis = JSON.stringify({
      systemDesign: input.systemDesign,
      requirements: input.requirements,
    });
    const embedding = await embeddingAgent(basis);
    if (Array.isArray(embedding) && embedding.length > 0) {
      const similar = await searchVectors({
        user_id: input.user_id || input.userId || 'unknown',
        task: 'code_patch',
        embedding,
        topK: 2,
      });
      retrievedPatches = similar.map((r: any) => r.metadata?.patch).filter(Boolean);
    }
  } catch {
    // RAG failure is non-fatal
  }

  const hasBackend = Boolean(input.systemDesign?.backend);
  const projectId: string = input.projectId || 'unknown';

  debug('codeGenerationAgent:frontend-start', { projectId });
  let frontendFiles: GeneratedFile[];
  try {
    frontendFiles = await generateFrontendFiles(
      input.systemDesign,
      input.requirements,
      input.modification,
      llmProxy,
      model
    );
  } catch (err) {
    logError('codeGenerationAgent:frontend-failed', err);
    throw new Error(`Frontend code generation failed: ${(err as Error).message}`);
  }

  let backendFiles: GeneratedFile[] = [];
  if (hasBackend) {
    debug('codeGenerationAgent:backend-start', { projectId });
    try {
      backendFiles = await generateBackendFiles(
        input.systemDesign,
        input.requirements,
        projectId,
        input.modification,
        llmProxy,
        model
      );
    } catch (err) {
      logError('codeGenerationAgent:backend-failed', err);
      throw new Error(`Backend code generation failed: ${(err as Error).message}`);
    }
  }

  const allFiles = filterAndNormalizeFiles([...frontendFiles, ...backendFiles]);

  const hasFrontendPkg = allFiles.some(f => f.path === 'package.json');
  const hasApp = allFiles.some(f => f.path === 'src/App.jsx');
  const hasCss = allFiles.some(f => f.path === 'src/index.css');
  if (!hasFrontendPkg || !hasApp || !hasCss) {
    logError('codeGenerationAgent:missing-required-frontend-files', { hasFrontendPkg, hasApp, hasCss, fileCount: allFiles.length });
    throw new Error('Code generation did not produce the required frontend scaffold.');
  }
  if (hasBackend) {
    const missingBackend = Array.from(BACKEND_REQUIRED).filter(required => !allFiles.some(f => f.path === required));
    if (missingBackend.length > 0) {
      throw new Error(`Code generation did not produce required backend files: ${missingBackend.join(', ')}`);
    }
  }

  debug('codeGenerationAgent:done', {
    projectId,
    fileCount: allFiles.length,
    hasBackend,
    frontendCount: frontendFiles.length,
    backendCount: backendFiles.length,
    retrievedPatches: retrievedPatches.length,
  });

  return {
    files: allFiles,
    patch: '',
    hasBackend,
    projectId,
    generationMode: 'staged',
  };
}
