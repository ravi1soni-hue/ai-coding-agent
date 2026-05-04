import path from 'path';
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';
import { debug, error as logError, warn as logWarn } from '../utils/logger';
import { assertBlueprintIntegrationSafety, blueprintMissingFiles, validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';
import { reviewerAgent } from './reviewerAgent';

type GeneratedFile = { path: string; content: string };

type FrontendManifest = {
  appName?: string;
  dependencies?: Record<string, string>;
  apiResources?: Array<{ name: string; path: string; methods?: string[]; purpose?: string }>;
  components?: Array<{ path: string; name?: string; purpose?: string }>;
  styleNotes?: string;
};

type GenerationMetrics = {
  fallbackCount: number;
  fallbackReasons: string[];
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

type EventSink = {
  emit: (event: { type: string; message?: string; token?: string; filePath?: string; payload?: any }) => void;
};

const FRONTEND_REQUIRED = new Set(['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css']);
const FRONTEND_ALLOWED_PREFIXES = ['src/components/', 'src/pages/'];
const BACKEND_REQUIRED = new Set(['backend/package.json', 'backend/index.js', 'backend/db/database.js', 'backend/db/init.sql']);
const BACKEND_ALLOWED_PREFIXES = ['backend/routes/', 'backend/middleware/'];
const MAX_COMPONENTS = 6;
const MAX_BACKEND_ROUTES = 8;
const BAN_LIST = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.pnpm-store', 'bun.lockb'];

function stripMarkdownFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

function extractJsonObject(content: string): string | null {
  const cleaned = stripMarkdownFences(content);
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return null;
}

function parseJsonSafe(content: string): any {
  const cleaned = stripMarkdownFences(content);
  try { return JSON.parse(cleaned); } catch {}
  const extracted = extractJsonObject(cleaned);
  if (extracted) {
    try { return JSON.parse(extracted); } catch {}
  }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = cleaned.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(slice); } catch {}
    const compact = slice
      .replace(/:\s*'([^']*)'/g, (_, value) => `: "${value.replace(/"/g, '\\"')}"`)
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(compact); } catch {}
  }
  const candidateLines = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  for (let i = 0; i < candidateLines.length; i += 1) {
    const joined = candidateLines.slice(i).join('\n');
    const start = joined.indexOf('{');
    const end = joined.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(joined.slice(start, end + 1)); } catch {}
    }
  }
  throw new Error(`No valid JSON found in LLM response. Snippet: ${content.replace(/\s+/g, ' ').slice(0, 220)}`);
}

function assertObject(value: any, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected a JSON object`);
  return value;
}

function containsPlaceholderText(value: string): boolean {
  return /(?:\bTODO\b|\bplaceholder\b|\breplace\b|\bgeneric text\b)/i.test(value);
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
  if (projectSpec?.requirements?.website_type && !appName) {
    throw new Error('frontendManifest: invalid appName from projectSpec');
  }
  if (!appName || containsPlaceholderText(appName)) {
    throw new Error('frontendManifest: invalid appName');
  }

  if (uiSpec?.components?.length) {
    const requiredNames = new Set<string>(
      uiSpec.components
        .map((component: { name?: string }) => String(component?.name || '').trim())
        .filter((name: string) => name.length > 0)
    );
    for (const requiredName of requiredNames) {
      if (!seenNames.has(requiredName)) {
        // Warn only — a manifest name mismatch should not trigger the fallback cascade.
        // validateAppImports enforces the authoritative component-wiring check after generation.
        logWarn('codeGenerationAgent:manifest-missing-uispec-component', { requiredName });
      }
    }
  }
}

function normalizeImportPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\.(jsx?|tsx?)$/, '').toLowerCase();
}

function validateAppImports(appContent: string, componentFiles: GeneratedFile[], blueprint?: ProjectBlueprint, uiSpec?: any): void {
  const importPattern = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](.+?)['"];?$/gm;
  const declaredImports = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(appContent)) !== null) {
    declaredImports.set(match[1], match[2]);
  }

  for (const file of componentFiles) {
    const componentName = sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection');
    const expectedImportPath = `./${file.path.replace(/^src\//, '')}`;
    const importedPath = declaredImports.get(componentName);
    if (!importedPath) {
      throw new Error(`frontendApp: missing import for ${componentName}`);
    }
    // Normalize both paths before comparing — LLM may omit .jsx extension or vary casing
    if (normalizeImportPath(importedPath) !== normalizeImportPath(expectedImportPath)) {
      throw new Error(`frontendApp: import path mismatch for ${componentName} (expected ${expectedImportPath}, got ${importedPath})`);
    }
    const usagePattern = new RegExp(`<${componentName}(\\s|/|>)`);
    if (!usagePattern.test(appContent)) {
      throw new Error(`frontendApp: missing rendered usage for ${componentName}`);
    }
  }

  // uiSpec component render check: only warn — LLM may render them conditionally or compose differently
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

  if (blueprint) {
    const declaredRoutes = new Set(blueprint.navigation.routes.map((route) => route.component));
    const rootComponentNames = new Set(componentFiles.map((file) => sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')));
    for (const route of blueprint.navigation.routes) {
      if (route.component !== 'App' && !rootComponentNames.has(route.component) && !declaredImports.has(route.component)) {
        throw new Error(`frontendApp: blueprint navigation references unknown component ${route.component}`);
      }
    }
    if (blueprint.navigation.routes.length > 0 && !declaredRoutes.has('App')) {
      throw new Error('frontendApp: blueprint navigation must include App as the root route component');
    }
  }

  if (containsPlaceholderText(appContent)) {
    throw new Error('frontendApp: placeholder text detected');
  }
}

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
      if (/^[\s]*<!doctype|<html/i.test(content)) throw new Error(`${label}: LLM returned HTML error page`);
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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
      lastRaw = await callWithRetry(llmProxy, messages, model, maxTokens, 60_000, 2, label);
      return parseJsonSafe(lastRaw);
    } catch (err) {
      const message = (err as Error).message;
      logWarn(`${label}:json-attempt-failed:${jsonAttempt}`, { error: message, rawSnippet: lastRaw.slice(0, 240) });
      if (jsonAttempt === 3) throw err;
      await new Promise(r => setTimeout(r, 700 * jsonAttempt));
    }
  }
  throw new Error(`${label}: all JSON self-heal attempts exhausted`);
}

function parseBackendManifest(raw: unknown, tablePrefix: string): BackendManifest {
  const manifest = assertObject(raw, 'backendManifest') as BackendManifest;
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const normalizedResources = resources.slice(0, MAX_BACKEND_ROUTES).map((resource, index) => {
    const name = String(resource?.name || `resource${index + 1}`);
    const routePath = String(resource?.routePath || `/api/${name}`);
    const tableName = String(resource?.tableName || `${tablePrefix}${name}`);
    return {
      ...resource,
      name,
      routePath: routePath.startsWith('/api/') ? routePath : `/api/${name}`,
      tableName: tableName.startsWith(tablePrefix) ? tableName : `${tablePrefix}${tableName.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      methods: Array.isArray(resource?.methods) && resource.methods.length > 0 ? resource.methods : ['GET', 'POST'],
      purpose: String(resource?.purpose || `Data operations for ${name}`),
    };
  });

  const tables = Array.isArray(manifest.tables) ? manifest.tables : [];
  const normalizedTables = tables.slice(0, MAX_BACKEND_ROUTES).map((table, index) => {
    const name = String(table?.name || `${tablePrefix}table${index + 1}`);
    return {
      ...table,
      name: name.startsWith(tablePrefix) ? name : `${tablePrefix}${name.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      columns: Array.isArray(table?.columns) && table.columns.length > 0 ? table.columns : ['id TEXT PRIMARY KEY', 'name TEXT NOT NULL', 'data JSONB NOT NULL DEFAULT \'{}\'::jsonb'],
      purpose: String(table?.purpose || `Storage for ${name}`),
    };
  });

  return { resources: normalizedResources, tables: normalizedTables };
}

function normalizeGeneratedPath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replace(/\\/g, '/');
}

function isAllowedPath(filePath: string, scope: 'frontend' | 'backend'): boolean {
  const p = normalizeGeneratedPath(filePath);
  if (p.includes('..') || path.isAbsolute(p)) return false;
  if (BAN_LIST.some(b => p === b || p.startsWith(`${b}/`))) return false;
  if (p.startsWith('node_modules') || p.includes('/node_modules/')) return false;
  if (p.startsWith('dist/') || p === 'dist') return false;
  if (scope === 'frontend') return FRONTEND_REQUIRED.has(p) || FRONTEND_ALLOWED_PREFIXES.some(prefix => p.startsWith(prefix));
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

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_$]/g, '');
  return cleaned && /^[a-zA-Z_$]/.test(cleaned) ? cleaned : fallback;
}

function failClosed(reason: string): never {
  throw new Error(reason);
}

function sanitizeComponentPath(rawPath: string, index: number): string {
  const p = normalizeGeneratedPath(rawPath || '');
  if (p.startsWith('src/components/') && p.endsWith('.jsx') && !p.includes('..')) return p;
  return `src/components/GeneratedSection${index + 1}.jsx`;
}

function sanitizeRoutePath(rawPath: string, resourceName: string): string {
  const p = normalizeGeneratedPath(rawPath || '');
  const rawName = p.startsWith('backend/routes/') && p.endsWith('.js') ? path.basename(p, '.js') : resourceName;
  const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resource';
  return `backend/routes/${slug}.js`;
}

function escapeJsxText(value: string | undefined, fallback: string): string {
  return String(value || fallback)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

function reviewFileAgainstManifest(file: GeneratedFile, manifest: ProjectManifest): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  if (!manifest.fileTree.includes(file.path)) notes.push(`File path ${file.path} is not in the manifest file tree.`);
  if (file.path === 'src/App.jsx' && !file.content.includes('API_BASE')) notes.push('App should use API_BASE for backend calls.');
  if (file.path === 'src/index.css' && !file.content.includes('body')) notes.push('CSS should include base styles.');
  if (file.path.startsWith('src/components/') && !file.content.includes('export default function')) notes.push('Component must export a default function.');
  return { ok: notes.length === 0, notes };
}

function buildProjectManifest(frontend: FrontendManifest, backend: BackendManifest | undefined, modelRouting: ProjectManifest['technicalSpecs']['modelRouting']): ProjectManifest {
  const fileTree = [
    'package.json',
    'index.html',
    'vite.config.js',
    'src/main.jsx',
    'src/App.jsx',
    'src/index.css',
    ...(frontend.components || []).map(c => sanitizeComponentPath(c.path || '', 0)),
    ...(backend ? ['backend/package.json', 'backend/index.js', 'backend/db/database.js', 'backend/db/init.sql', ...((backend.resources || []).map(r => sanitizeRoutePath(`backend/routes/${r.name}.js`, r.name || 'resource')))] : []),
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

function frontendScaffold(manifest: FrontendManifest): GeneratedFile[] {
  const dependencies = { react: '^18.3.1', 'react-dom': '^18.3.1', ...(manifest.dependencies || {}) };
  delete (dependencies as Record<string, string>).vite;
  delete (dependencies as Record<string, string>)['@vitejs/plugin-react'];
  return [
    { path: 'package.json', content: JSON.stringify({ name: (manifest.appName || 'generated-project').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'generated-project', private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies, devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.20' } }, null, 2) },
    { path: 'index.html', content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${manifest.appName || 'Generated App'}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>` },
    { path: 'vite.config.js', content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n` },
    { path: 'src/main.jsx', content: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\ncreateRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);\n` },
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
    { path: 'backend/package.json', content: JSON.stringify({ name: 'generated-backend', version: '0.1.0', private: true, type: 'module', scripts: { start: 'node index.js', build: 'echo done' }, dependencies: { express: '^4.19.0', pg: '^8.20.0', cors: '^2.8.5' } }, null, 2) },
    { path: 'backend/db/database.js', content: `import pg from 'pg';\nconst { Pool } = pg;\nconst connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';\nexport const pool = new Pool(connectionString ? { connectionString } : {});\nexport function query(sql, params = []) { return pool.query(sql, params); }\n` },
    { path: 'backend/index.js', content: `import express from 'express';\nimport cors from 'cors';\nimport { readFileSync } from 'fs';\nimport { fileURLToPath } from 'url';\nimport { dirname, join } from 'path';\nimport { query } from './db/database.js';\n${imports.join('\n')}\nconst __filename = fileURLToPath(import.meta.url);\nconst __dirname = dirname(__filename);\nconst app = express();\nconst port = process.env.PORT || 3000;\napp.use(cors({ origin: '*' }));\napp.use(express.json());\n${mounts.join('\n')}\nasync function initDb() { try { const sql = readFileSync(join(__dirname, 'db/init.sql'), 'utf8'); if (sql.trim()) await query(sql); } catch (error) { console.warn('DB init warning:', error.message); } }\napp.get('/api/health', async (req, res) => { try { await query('SELECT 1'); res.json({ status: 'ok', db: 'connected', tablePrefix: '${tablePrefix}' }); } catch (error) { res.status(200).json({ status: 'ok', db: 'unavailable', error: error.message }); } });\napp.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });\ninitDb().then(() => app.listen(port, () => console.log(\`Backend on port \${port}\`)));\n` },
  ];
}

async function generateFrontendManifest(systemDesign: any, requirements: any, modification: string | undefined, llmProxy: LLMProxyClient, model: string, uiSpec?: any): Promise<FrontendManifest> {
  const userMessage = String(requirements?.userMessage || '');
  const clarificationAnswers = requirements?.clarificationAnswers || {};
  const pages = Array.isArray(requirements?.pages) ? requirements.pages : [];
  const authRequired = Boolean(requirements?.auth_required);

  // If uiSpec defines exact component names, include them in the prompt so the LLM uses matching names.
  const uiSpecComponentHint = Array.isArray(uiSpec?.components) && uiSpec.components.length > 0
    ? `\n- The following components MUST appear in the components array with EXACTLY these names: ${(uiSpec.components as Array<{ name?: string }>).map(c => c.name).filter(Boolean).join(', ')}`
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
  manifest.components = components.slice(0, MAX_COMPONENTS).map((component, index) => ({ ...component, path: sanitizeComponentPath(component?.path || '', index), name: sanitizeIdentifier(component?.name || `GeneratedSection${index + 1}`, `GeneratedSection${index + 1}`) }));
  manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};

  // Post-reconcile: if uiSpec components were provided, ensure every uiSpec name appears in the manifest.
  // This prevents the LLM from silently renaming a component (e.g. "Toggle" instead of "PricingToggle").
  if (Array.isArray(uiSpec?.components) && uiSpec.components.length > 0) {
    const manifestNames = new Set(manifest.components.map((c: any) => String(c.name || '')));
    const missing = (uiSpec.components as Array<{ name?: string; path?: string; purpose?: string }>)
      .filter(c => c.name && !manifestNames.has(c.name));
    if (missing.length > 0) {
      const extra = missing.map(c => ({
        path: `src/components/${c.name}.jsx`,
        name: c.name!,
        purpose: String(c.purpose || `${c.name} component`),
      }));
      manifest.components = [...manifest.components, ...extra].slice(0, MAX_COMPONENTS);
      logWarn('codeGenerationAgent:manifest-reconciled-uispec', { added: extra.map(c => c.name) });
    }
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
  
  // Get component spec if using UISpec
  const componentSpec = uiSpec?.components?.find((c: any) => c.name === componentName);
  const dependencyCode = componentSpec?.dependencies
    ?.map((dep: string) => ({ dep, code: generatedDependencies?.get(dep)?.slice(0, 500) }))
    .filter((d: any) => d.code)
    || [];
  
  const systemPrompt = `Generate one production-quality React component for: "${userMessage || manifest.appName}".
Component purpose: ${component.purpose || componentName}
Component name: ${componentName}

${componentSpec ? `Props interface:
${JSON.stringify(componentSpec.props, null, 2)}

Render logic: ${componentSpec.renderLogic}
` : ''}

${dependencyCode.length > 0 ? `\nAlready-generated dependencies (reference these imports):
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
${imports.map(i => i.importLine).join('\n')}

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
  
  // Semantic review: validate App.jsx has proper structure
  const hasImports = imports.length > 0 && imports.some(i => appFile.content.includes(i.name));
  const hasExport = appFile.content.includes('export default function App');
  const hasRender = appFile.content.includes('return (') || appFile.content.includes('return <');
  const hasApiBase = backendRequired ? appFile.content.includes('API_BASE') || appFile.content.includes('fetch') || appFile.content.includes('http') : true;
  
  if (!hasExport || !hasRender || !hasImports || !hasApiBase) {
    // Log issues but allow it - will be caught in build phase
    logWarn('frontendApp:semantic-check-failed', {
      hasExport,
      hasRender,
      hasImports,
      hasApiBase,
      backendRequired,
    });
  }
  
  return appFile;
}

async function generateFrontendCss(manifest: FrontendManifest, requirements: any, appFile: GeneratedFile, componentFiles: GeneratedFile[], llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const userMessage = String(requirements?.userMessage || '').slice(0, 300);
  const systemPrompt = `Generate src/index.css for this React app: "${userMessage || manifest.appName}". Match the visual style to the app's purpose. Return ONLY JSON: {"path":"src/index.css","content":"complete CSS"}`;
  const parsed = await generateJson(llmProxy, model, 'frontendCss', systemPrompt, { manifest, requirements, appSnippet: appFile.content.slice(0, 4000), componentSnippets: componentFiles.map(f => ({ path: f.path, content: f.content.slice(0, 1800) })) }, 2600);
  return validateGeneratedFile(parsed, 'src/index.css', 'frontend', 'frontendCss');
}

function fallbackFrontendApp(manifest: FrontendManifest, components: GeneratedFile[], hasBackend: boolean = false): GeneratedFile {
  const imports = components.map(file => `import ${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} from './${file.path.replace(/^src\//, '')}';`).join('\n');
  const componentTags = components.map(file => `        <${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} />`).join('\n');
  
  const apiInit = hasBackend ? `
  // Backend API configuration
  const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000';
  const [apiReady, setApiReady] = React.useState(false);
  
  React.useEffect(() => {
    // Check backend connectivity
    fetch(\`\${API_BASE}/api/health\`)
      .then(res => res.json())
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
  return { path: 'src/index.css', content: `* { box-sizing: border-box; }\nhtml, body, #root { margin: 0; min-height: 100%; }\nbody { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #111827; }\nbutton, input, textarea, select { font: inherit; }\n.app-shell { min-height: 100vh; padding: 48px clamp(20px, 5vw, 72px); }\n.hero { max-width: 920px; margin: 0 auto 32px; }\n.eyebrow { margin: 0 0 10px; color: #2563eb; font-weight: 700; text-transform: uppercase; font-size: 0.78rem; }\nh1 { margin: 0; font-size: clamp(2rem, 6vw, 4.5rem); line-height: 1; }\n.hero p:last-child { color: #4b5563; font-size: 1.08rem; line-height: 1.7; max-width: 680px; }\n.content-grid { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }\n.panel { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.06); }\n.panel h2 { margin: 0 0 8px; font-size: 1.08rem; }\n.panel p { margin: 0; color: #4b5563; line-height: 1.6; }\n` };
}

function fallbackFrontendManifest(requirements: any, uiSpec?: any): FrontendManifest {
  const rawName = typeof requirements?.userMessage === 'string' ? requirements.userMessage.slice(0, 60)
    : typeof requirements?.summary === 'string' ? requirements.summary
    : typeof requirements?.app_type === 'string' ? requirements.app_type : 'Generated App';
  const appName = String(rawName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'generated-app';

  // When uiSpec components are available, use them directly — preserves component names
  // so downstream validateAppImports checks against the same names used in generation.
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

async function generateFrontendFiles(
  systemDesign: any,
  requirements: any,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string,
  events?: EventSink,
  manifestOut?: { value?: ProjectManifest },
  uiSpec?: any,
  blueprint?: ProjectBlueprint,
  projectSpec?: any
): Promise<GeneratedFile[]> {
  const partial = new Map<string, string>();
  const metrics: GenerationMetrics = { fallbackCount: 0, fallbackReasons: [] };
  let manifest: FrontendManifest;
  try {
    manifest = await generateFrontendManifest(systemDesign, requirements, modification, llmProxy, model, uiSpec);
    validateManifestSemantics(manifest, requirements, projectSpec, uiSpec);
  } catch (err) {
    metrics.fallbackCount += 1;
    metrics.fallbackReasons.push(`frontend-manifest:${String((err as any)?.message || err)}`);
    logWarn('codeGenerationAgent:frontend-manifest-fallback', { error: (err as Error).message });
    manifest = fallbackFrontendManifest(requirements, uiSpec);
  }
  const projectManifest = buildProjectManifest(manifest, undefined, {
    orchestration: getModelConfigForTask('agent_orchestration').model,
    code: model,
    review: getModelConfigForTask('clarification').model,
  });
  if (!blueprint) throw new Error('codeGenerationAgent: validated blueprint is required before code generation');
  const missingBlueprintFiles = blueprintMissingFiles(blueprint, { requirements });
  if (missingBlueprintFiles.length > 0) {
    throw new Error(`Validated blueprint is missing required files: ${missingBlueprintFiles.join(', ')}`);
  }
  projectManifest.blueprint = blueprint;
  manifestOut && (manifestOut.value = projectManifest);
  events?.emit({ type: 'PLANNING_COMPLETE', message: 'Frontend planning complete', payload: { fileCount: projectManifest.fileTree.length } });

  frontendScaffold(manifest).forEach(file => setFile(partial, file));
  events?.emit({ type: 'AGENT_THINKING', message: 'Generated frontend manifest and scaffold' });

  // Dependency-ordered component generation (leaf components first)
  const generatedComponents = new Map<string, string>(); // component name -> generated code
  const componentFiles: GeneratedFile[] = [];

  if (uiSpec && Array.isArray(uiSpec.generationOrder) && uiSpec.generationOrder.length > 0) {
    // Use UISpec generation order (leaf-first)
    events?.emit({ type: 'AGENT_THINKING', message: `Generating components in dependency order: ${uiSpec.generationOrder.slice(0, 3).join(' -> ')}...` });
    
    for (const componentName of uiSpec.generationOrder) {
      const componentSpec = uiSpec.components?.find((c: any) => c.name === componentName);
      const componentManifestItem = manifest.components?.find((c: any) => c.name === componentName) ||
        { name: componentName, path: `src/components/${componentName}.jsx`, purpose: `${componentName} component` };
      
      try {
        const file = await generateFrontendComponent(
          componentManifestItem,
          manifest,
          requirements,
          llmProxy,
          model,
          uiSpec,
          generatedComponents
        );
        generatedComponents.set(componentName, file.content);
        setFile(partial, file);
        componentFiles.push(file);
        events?.emit({ type: 'FILE_WRITTEN', filePath: file.path, message: `Generated ${componentName} (dependency-aware)`, payload: { path: file.path, content: file.content } });
      } catch (err) {
        logWarn('codeGenerationAgent:component-generation-failed', { componentName, error: (err as Error).message });
        failClosed(`Frontend component generation failed for ${componentName}: ${(err as Error).message}`);
      }
    }
  } else {
    // Fallback to concurrent generation if no UISpec
    events?.emit({ type: 'AGENT_THINKING', message: 'Generating components concurrently' });
    const generatedFilesArray = await mapWithConcurrency(
      manifest.components || [],
      4,
      async (component, index) => {
        try {
          const file = await generateFrontendComponent(component, manifest, requirements, llmProxy, model, uiSpec, generatedComponents);
          generatedComponents.set(component.name || `Component${index}`, file.content);
          setFile(partial, file);
          events?.emit({ type: 'FILE_WRITTEN', filePath: file.path, message: `Wrote ${file.path}`, payload: { path: file.path, content: file.content } });
          return file;
        } catch (err) {
          logWarn('codeGenerationAgent:component-fallback', { path: component.path, error: (err as Error).message });
          failClosed(`Frontend component generation failed for ${component.path}: ${(err as Error).message}`);
        }
      }
    );
    componentFiles.push(...generatedFilesArray);
  }

  // Generate App.jsx with full context of all generated components
  let appFile: GeneratedFile;
  const backendRequired = Boolean(systemDesign?.backend);
  try {
    appFile = await generateFrontendApp(manifest, requirements, systemDesign, modification, componentFiles, llmProxy, model, uiSpec);
    validateAppImports(appFile.content, componentFiles, blueprint, uiSpec);
  } catch (err) {
    failClosed(`frontend App generation failed: ${(err as Error).message}`);
  }
  setFile(partial, appFile);
  events?.emit({ type: 'FILE_WRITTEN', filePath: appFile.path, message: `Wrote ${appFile.path}`, payload: { path: appFile.path, content: appFile.content } });

  // Generate CSS
  let cssFile: GeneratedFile;
  try {
    cssFile = await generateFrontendCss(manifest, requirements, appFile, componentFiles, llmProxy, model);
  } catch (err) {
    failClosed(`frontend CSS generation failed: ${(err as Error).message}`);
  }

  if (metrics.fallbackCount > 0) {
    logWarn('codeGenerationAgent:frontend-fallbacks', { fallbackCount: metrics.fallbackCount, reasons: metrics.fallbackReasons });
  }
  setFile(partial, cssFile);
  events?.emit({ type: 'FILE_WRITTEN', filePath: cssFile.path, message: `Wrote ${cssFile.path}`, payload: { path: cssFile.path, content: cssFile.content } });

  return Array.from(partial.entries()).map(([filePath, content]) => ({ path: filePath, content }));
}

async function generateBackendManifest(systemDesign: any, requirements: any, tablePrefix: string, modification: string | undefined, llmProxy: LLMProxyClient, model: string): Promise<BackendManifest> {
  const userMessage = String(requirements?.userMessage || '').slice(0, 400);
  const systemPrompt = `Create a backend implementation manifest for Node + Express + Postgres for this app: "${userMessage}". Return ONLY JSON with shape: {"resources":[{"name":"...","routePath":"/api/...","tableName":"...","fields":[],"methods":[],"purpose":"..."}],"tables":[{"name":"...","columns":[],"purpose":"..."}]}`;
  const parsed = await generateJson(llmProxy, model, 'backendManifest', systemPrompt, { requirements, userDescription: userMessage, backendDesign: systemDesign?.backend || null, tablePrefix, modification: modification || null }, 1800);
  return parseBackendManifest(parsed, tablePrefix);
}

async function generateBackendInitSql(manifest: BackendManifest, tablePrefix: string, requirements: any, llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const parsed = await generateJson(llmProxy, model, 'backendInitSql', 'Generate backend/db/init.sql. Return ONLY JSON.', { manifest, requirements, tablePrefix }, 2200);
  const file = validateGeneratedFile(parsed, 'backend/db/init.sql', 'backend', 'backendInitSql');
  if (!file.content.includes(tablePrefix)) throw new Error(`backendInitSql: SQL does not include required table prefix ${tablePrefix}`);
  return file;
}

function fallbackBackendFiles(tablePrefix: string): GeneratedFile[] {
  return [
    {
      path: 'backend/package.json',
      content: JSON.stringify({
        name: 'generated-backend',
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          start: 'node index.js',
          build: 'echo done',
        },
        dependencies: {
          express: '^4.19.0',
          pg: '^8.20.0',
          cors: '^2.8.5',
        },
      }, null, 2),
    },
    {
      path: 'backend/db/database.js',
      content: `import pg from 'pg';\nconst { Pool } = pg;\nconst connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';\nexport const pool = new Pool(connectionString ? { connectionString } : {});\nexport function query(sql, params = []) { return pool.query(sql, params); }\n`,
    },
    {
      path: 'backend/index.js',
      content: `import express from 'express';\nimport cors from 'cors';\nimport { readFileSync } from 'fs';\nimport { fileURLToPath } from 'url';\nimport { dirname, join } from 'path';\nimport { query } from './db/database.js';\nimport itemsRouter from './routes/items.js';\nconst __filename = fileURLToPath(import.meta.url);\nconst __dirname = dirname(__filename);\nconst app = express();\nconst port = process.env.PORT || 3000;\napp.use(cors({ origin: '*' }));\napp.use(express.json());\napp.use('/api/items', itemsRouter);\nasync function initDb() { try { const sql = readFileSync(join(__dirname, 'db/init.sql'), 'utf8'); if (sql.trim()) await query(sql); } catch (error) { console.warn('DB init warning:', error.message); } }\napp.get('/api/health', async (req, res) => { try { await query('SELECT 1'); res.json({ status: 'ok', db: 'connected', tablePrefix: '${tablePrefix}' }); } catch (error) { res.status(200).json({ status: 'ok', db: 'unavailable', error: error.message }); } });\napp.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });\ninitDb().then(() => app.listen(port, () => console.log(\`Backend on port \${port}\`)));\n`,
    },
    {
      path: 'backend/routes/items.js',
      content: `import express from 'express';\nimport { randomUUID } from 'crypto';\nimport { query } from '../db/database.js';\nconst router = express.Router();\nconst tableName = '${tablePrefix}items';\nrouter.get('/', async (req, res, next) => { try { const result = await query(\`SELECT * FROM ${tablePrefix}items ORDER BY created_at DESC LIMIT 100\`); res.json({ items: result.rows }); } catch (error) { next(error); } });\nrouter.post('/', async (req, res, next) => { try { const id = randomUUID(); const name = req.body?.name || 'Untitled'; const data = req.body || {}; const result = await query(\`INSERT INTO ${tablePrefix}items (id, name, data) VALUES ($1, $2, $3) RETURNING *\`, [id, name, data]); res.status(201).json(result.rows[0]); } catch (error) { next(error); } });\nexport default router;\n`,
    },
    {
      path: 'backend/db/init.sql',
      content: `CREATE TABLE IF NOT EXISTS ${tablePrefix}items (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  data JSONB NOT NULL DEFAULT '{}'::jsonb,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);\n`,
    },
  ];
}

async function generateBackendRoute(resource: NonNullable<BackendManifest['resources']>[number], routePath: string, tablePrefix: string, requirements: any, llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const expectedPath = sanitizeRoutePath('', resource.name || 'resource');
  const parsed = await generateJson(llmProxy, model, `backendRoute:${expectedPath}`, 'Generate one Express router file. Return ONLY JSON.', { resource, routePath, requirements, tablePrefix }, 3000);
  return validateGeneratedFile(parsed, expectedPath, 'backend', `backendRoute:${expectedPath}`);
}

function fallbackInitSql(manifest: BackendManifest, tablePrefix: string): GeneratedFile {
  const resources = manifest.resources && manifest.resources.length > 0 ? manifest.resources : [{ name: 'items', tableName: `${tablePrefix}items` }];
  const statements = resources.map(resource => {
    const table = String(resource.tableName || `${tablePrefix}${resource.name || 'items'}`).replace(/[^a-zA-Z0-9_]/g, '_');
    const safeTable = table.startsWith(tablePrefix) ? table : `${tablePrefix}${table}`;
    return `CREATE TABLE IF NOT EXISTS ${safeTable} (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  data JSONB NOT NULL DEFAULT '{}'::jsonb,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);`;
  }).join('\n\n');
  return { path: 'backend/db/init.sql', content: `${statements}\n` };
}

function fallbackRoute(resource: NonNullable<BackendManifest['resources']>[number], tablePrefix: string): GeneratedFile {
  const routeFile = sanitizeRoutePath('', resource.name || 'items');
  const table = String(resource.tableName || `${tablePrefix}${resource.name || 'items'}`).replace(/[^a-zA-Z0-9_]/g, '_');
  const safeTable = table.startsWith(tablePrefix) ? table : `${tablePrefix}${table}`;
  return { path: routeFile, content: `import express from 'express';\nimport { randomUUID } from 'crypto';\nimport { query } from '../db/database.js';\nconst router = express.Router();\nconst tableName = '${safeTable}';\nrouter.get('/', async (req, res, next) => { try { const result = await query(\`SELECT * FROM \${tableName} ORDER BY created_at DESC LIMIT 100\`); res.json({ items: result.rows }); } catch (error) { next(error); } });\nrouter.post('/', async (req, res, next) => { try { const id = randomUUID(); const name = req.body?.name || 'Untitled'; const data = req.body || {}; const result = await query(\`INSERT INTO \${tableName} (id, name, data) VALUES ($1, $2, $3) RETURNING *\`, [id, name, data]); res.status(201).json(result.rows[0]); } catch (error) { next(error); } });\nexport default router;\n` };
}

function fallbackBackendManifest(tablePrefix: string): BackendManifest {
  return {
    resources: [
      {
        name: 'items',
        routePath: '/api/items',
        tableName: `${tablePrefix}items`,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        purpose: 'Default project data resource.',
      },
    ],
    tables: [
      {
        name: `${tablePrefix}items`,
        columns: ['id TEXT PRIMARY KEY', 'name TEXT NOT NULL', 'data JSONB NOT NULL DEFAULT \'{}\'::jsonb'],
        purpose: 'Default project data table.',
      },
    ],
  };
}

async function generateBackendFiles(systemDesign: any, requirements: any, projectId: string, modification: string | undefined, llmProxy: LLMProxyClient, model: string, events?: EventSink, blueprint?: ProjectBlueprint): Promise<GeneratedFile[]> {
  const partial = new Map<string, string>();
  const safeId = projectId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
  if (!blueprint) throw new Error('codeGenerationAgent: validated blueprint is required before backend generation');
  const missingBlueprintFiles = blueprintMissingFiles(blueprint);
  if (missingBlueprintFiles.length > 0) {
    throw new Error(`Validated blueprint is missing required files: ${missingBlueprintFiles.join(', ')}`);
  }
  const tablePrefix = `proj_${safeId}_`;
  let manifest: BackendManifest;

  try {
    manifest = await generateBackendManifest(systemDesign, requirements, tablePrefix, modification, llmProxy, model);
  } catch (err) {
    logWarn('codeGenerationAgent:backend-manifest-fallback', { error: (err as Error).message });
    manifest = fallbackBackendManifest(tablePrefix);
  }

  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  if (resources.length === 0) {
    manifest.resources = fallbackBackendManifest(tablePrefix).resources;
  }

  manifest.resources = (manifest.resources || []).map((resource, index) => ({
    ...resource,
    name: resource.name || `resource${index + 1}`,
    routePath: resource.routePath || `/api/${resource.name || `resource-${index + 1}`}`,
    tableName: String(resource.tableName || `${tablePrefix}${resource.name || `resource${index + 1}`}`).startsWith(tablePrefix)
      ? String(resource.tableName || `${tablePrefix}${resource.name || `resource${index + 1}`}`)
      : `${tablePrefix}${String(resource.tableName || resource.name || `resource${index + 1}`).replace(/[^a-zA-Z0-9_]/g, '_')}`,
    methods: Array.isArray(resource.methods) && resource.methods.length > 0 ? resource.methods : ['GET', 'POST'],
  }));

  const backendFallback = fallbackBackendFiles(tablePrefix);
  backendFallback.forEach(file => {
    if (file.path === 'backend/package.json' || file.path === 'backend/index.js' || file.path === 'backend/db/database.js') {
      setFile(partial, file);
    }
  });
  const _bpkg = partial.get('backend/package.json') ?? '';
  const _bidx = partial.get('backend/index.js') ?? '';
  const _bdb = partial.get('backend/db/database.js') ?? '';
  events?.emit({ type: 'FILE_WRITTEN', filePath: 'backend/package.json', message: 'Generated backend scaffold: package.json', payload: { path: 'backend/package.json', content: _bpkg } });
  events?.emit({ type: 'FILE_WRITTEN', filePath: 'backend/index.js', message: 'Generated backend scaffold: index.js', payload: { path: 'backend/index.js', content: _bidx } });
  events?.emit({ type: 'FILE_WRITTEN', filePath: 'backend/db/database.js', message: 'Generated backend scaffold: db/database.js', payload: { path: 'backend/db/database.js', content: _bdb } });

  const artifactResults = await Promise.all([
    (async () => {
      try {
        const f = await generateBackendInitSql(manifest, tablePrefix, requirements, llmProxy, model);
        setFile(partial, f);
        events?.emit({ type: 'FILE_WRITTEN', filePath: f.path, message: `Wrote ${f.path}`, payload: { path: f.path, content: f.content } });
        return { kind: 'sql', ok: true, path: f.path };
      } catch (err) {
        logWarn('codeGenerationAgent:init-sql-fallback', { error: (err as Error).message });
        const f = backendFallback.find(file => file.path === 'backend/db/init.sql') || fallbackInitSql(manifest, tablePrefix);
        setFile(partial, f);
        events?.emit({ type: 'FILE_WRITTEN', filePath: f.path, message: `Wrote fallback ${f.path}`, payload: { path: f.path, content: f.content } });
        return { kind: 'sql', ok: false, path: f.path, error: (err as Error).message };
      }
    })(),
    ...(manifest.resources || []).map((resource) => (async () => {
      const expectedPath = sanitizeRoutePath('', resource.name || 'resource');
      try {
        const route = await generateBackendRoute(resource, resource.routePath || '/', tablePrefix, requirements, llmProxy, model);
        setFile(partial, route);
        events?.emit({ type: 'FILE_WRITTEN', filePath: route.path, message: `Wrote ${route.path}`, payload: { path: route.path, content: route.content } });
        return { kind: 'route', ok: true, path: route.path, resource: resource.name, expectedPath };
      } catch (err) {
        logWarn('codeGenerationAgent:route-fallback', { resource: resource.name, expectedPath, error: (err as Error).message });
        const route = backendFallback.find(file => file.path === expectedPath) || fallbackRoute(resource, tablePrefix);
        setFile(partial, route);
        events?.emit({ type: 'FILE_WRITTEN', filePath: route.path, message: `Wrote fallback ${route.path}`, payload: { path: route.path, content: route.content } });
        return { kind: 'route', ok: false, path: route.path, resource: resource.name, expectedPath, error: (err as Error).message };
      }
    })()),
  ]);

  const failedArtifacts = artifactResults.filter(r => !r.ok).map((r: any) => `${r.kind}:${r.expectedPath || r.path}${r.error ? ` (${r.error})` : ''}`);
  if (failedArtifacts.length > 0) {
    logWarn('codeGenerationAgent:backend-artifact-fallbacks', { failedArtifacts });
  }

  const files = Array.from(partial.entries()).map(([filePath, content]) => ({ path: filePath, content }));
  const missingRequired = Array.from(BACKEND_REQUIRED).filter(required => !files.some(f => f.path === required));
  if (missingRequired.length > 0) {
    logWarn('codeGenerationAgent:backend-missing-required', { missingRequired, files: files.map(f => f.path) });
    for (const fallback of backendFallback) {
      if (!files.some(f => f.path === fallback.path)) {
        files.push(fallback);
      }
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

  let retrievedPatches: string[] = [];
  try {
    const basis = JSON.stringify({ systemDesign: input.systemDesign, requirements: input.requirements });
    const embedding = await embeddingAgent(basis);
    if (Array.isArray(embedding) && embedding.length > 0) {
      const similar = await searchVectors({ user_id: input.user_id || input.userId || 'unknown', task: 'code_patch', embedding, topK: 2 });
      retrievedPatches = similar.map((r: any) => r.metadata?.patch).filter(Boolean);
    }
  } catch {}

  const hasBackend = Boolean(input.projectSpec?.requirements?.backend_required ?? input.systemDesign?.backend);
  const projectId: string = input.projectId || 'unknown';
  const uiSpec = input.uiSpec; // UISpec from prior stage

  debug('codeGenerationAgent:parallel-start', { projectId, hasBackend, hasUISpec: !!uiSpec });
  const manifestOut: { value?: ProjectManifest } = {};
  const [frontendResult, backendResult] = await Promise.allSettled([
    generateFrontendFiles(input.systemDesign, input.requirements, input.modification, llmProxy, model, events, manifestOut, uiSpec, blueprint, input.projectSpec),
    hasBackend ? generateBackendFiles(input.systemDesign, input.requirements, projectId, input.modification, llmProxy, model, events, blueprint) : Promise.resolve([] as GeneratedFile[]),
  ]);

  const frontendFiles = frontendResult.status === 'fulfilled'
    ? frontendResult.value
    : (() => {
        logError('codeGenerationAgent:frontend-failed', frontendResult.reason);
        throw new Error(`Frontend code generation failed: ${(frontendResult.reason as Error)?.message || String(frontendResult.reason)}`);
      })();

  const backendFiles = backendResult.status === 'fulfilled'
    ? backendResult.value
    : (() => {
        logError('codeGenerationAgent:backend-failed', backendResult.reason);
        throw new Error(`Backend code generation failed: ${(backendResult.reason as Error)?.message || String(backendResult.reason)}`);
      })();
  const projectManifest = manifestOut.value;

  const fileMap = new Map([...frontendFiles, ...backendFiles].map(f => [normalizeGeneratedPath(f.path), f.content]));

  // Targeted repair: fill missing frontend scaffold files without re-running the full lifecycle.
  const repairComponents = frontendFiles.filter(f => f.path.startsWith('src/components/'));
  const repairBackendRequired = hasBackend;

  for (const required of ['package.json', 'src/App.jsx', 'src/index.css'] as const) {
    if (!fileMap.has(required)) {
      logWarn('codeGenerationAgent:repair-missing', { path: required });
      events?.emit({ type: 'AGENT_THINKING', message: `Repairing missing file: ${required}` });
      if (required === 'src/App.jsx') {
        try {
          const frontendManifest = fallbackFrontendManifest(input.requirements, uiSpec);
          const repairedApp = await generateFrontendApp(frontendManifest, input.requirements, input.systemDesign, input.modification, repairComponents, llmProxy, model, input.uiSpec);
          fileMap.set(required, repairedApp.content);
          events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Repaired ${required}`, payload: { path: required, content: repairedApp.content } });
        } catch {
          const fallback = fallbackFrontendApp(fallbackFrontendManifest(input.requirements, uiSpec), repairComponents, repairBackendRequired);
          fileMap.set(required, fallback.content);
          events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Fallback repair for ${required}`, payload: { path: required, content: fallback.content } });
        }
      } else if (required === 'src/index.css') {
        const fallback = fallbackFrontendCss();
        fileMap.set(required, fallback.content);
        events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Fallback repair for ${required}`, payload: { path: required, content: fallback.content } });
      } else if (required === 'package.json') {
        const scaffoldFiles = frontendScaffold(fallbackFrontendManifest(input.requirements));
        const pkgFile = scaffoldFiles.find(f => f.path === 'package.json');
        if (pkgFile) {
          fileMap.set(required, pkgFile.content);
          events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Fallback repair for ${required}`, payload: { path: required, content: pkgFile.content } });
        }
      }
    }
  }

  // Targeted repair: fill missing backend required files without re-running the full lifecycle.
  if (hasBackend) {
    const safeId = projectId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
    const tablePrefix = `proj_${safeId}_`;
    const backendFallbackFiles = fallbackBackendFiles(tablePrefix);
    for (const required of Array.from(BACKEND_REQUIRED)) {
      if (!fileMap.has(required)) {
        logWarn('codeGenerationAgent:repair-missing-backend', { path: required });
        const fallback = backendFallbackFiles.find(f => f.path === required);
        if (fallback) {
          fileMap.set(required, fallback.content);
          events?.emit({ type: 'FILE_WRITTEN', filePath: required, message: `Repaired missing backend file: ${required}`, payload: { path: required, content: fallback.content } });
        }
      }
    }
  }

  // Targeted repair: regenerate App.jsx if it is a stub, reusing all already-generated components.
  const appContent = fileMap.get('src/App.jsx') ?? '';
  if (appContent.length < 200) {
    logWarn('codeGenerationAgent:repair-stub-app', { contentLength: appContent.length });
    events?.emit({ type: 'AGENT_THINKING', message: 'App.jsx appears to be a stub — repairing without restarting...' });
    try {
      const frontendManifest = fallbackFrontendManifest(input.requirements);
      const repairedStubApp = await generateFrontendApp(frontendManifest, input.requirements, input.systemDesign, input.modification, repairComponents, llmProxy, model, input.uiSpec);
      validateAppImports(repairedStubApp.content, repairComponents, blueprint, input.uiSpec);
      fileMap.set('src/App.jsx', repairedStubApp.content);
      events?.emit({ type: 'FILE_WRITTEN', filePath: 'src/App.jsx', message: 'Repaired stub App.jsx', payload: { path: 'src/App.jsx', content: repairedStubApp.content } });
    } catch (err) {
      failClosed(`Stub App.jsx repair failed: ${(err as Error).message}`);
    }
  }

  const allFiles = Array.from(fileMap.entries()).map(([pathName, content]) => ({ path: pathName, content }));

  const componentFiles = allFiles.filter(f => f.path.startsWith('src/components/'));
  for (const comp of componentFiles) {
    if (comp.content.length < 150) {
      logWarn('codeGenerationAgent:stub-detected', { path: comp.path, contentLength: comp.content.length });
    }
  }

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
