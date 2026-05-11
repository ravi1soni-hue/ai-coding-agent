import path from 'path';
import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError, warn as logWarn } from '../utils/logger';
import { assertBlueprintIntegrationSafety, blueprintMissingFiles, validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';
import { validateStructuredSpec, type StructuredSpec } from './structuredSpec';
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

function toComponentName(rawName: unknown, fallback: string): string {
  const str = typeof rawName === 'string' ? rawName : fallback;
  const id = sanitizeIdentifier(str, fallback);
  return id.charAt(0).toUpperCase() + id.slice(1) || fallback;
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
    // Robust fallback for {"path":"...","content":"..."} responses.
    // Large JSX files often contain literal newlines or other characters the LLM
    // fails to escape, breaking JSON.parse. Since content is always the last field,
    // we extract path normally and treat everything between the content opening quote
    // and the final closing quote as the raw file content.
    const pathMatch = slice.match(/"path"\s*:\s*"([^"]*)"/);
    const contentKeyIdx = slice.indexOf('"content"');
    if (pathMatch && contentKeyIdx !== -1) {
      const colonIdx = slice.indexOf(':', contentKeyIdx);
      const openQuote = slice.indexOf('"', colonIdx + 1);
      if (openQuote !== -1) {
        // The JSON object closes with `"}` — find the last occurrence of that sequence
        // to locate the end of the content string value rather than any quote inside it.
        const closingSeq = slice.lastIndexOf('"}');
        const closeQuote = closingSeq > openQuote ? closingSeq : slice.lastIndexOf('"');
        if (closeQuote > openQuote) {
          const rawContent = slice.slice(openQuote + 1, closeQuote);
          // Unescape only the sequences the LLM does escape; leave literal newlines as-is.
          const unescaped = rawContent
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');

          // Reject obviously-truncated payloads. When the LLM hits its
          // output-token cap mid-string, the fallback extracts a slice
          // ending in a bare `\` or with grossly unbalanced braces;
          // returning that produces a file Vite can't parse. Force the
          // caller into its stub/fallback path instead of poisoning the
          // build with half a component.
          const looksTruncated =
            closingSeq === -1 /* never saw '"}' */ ||
            /\\\s*$/.test(unescaped) /* trailing escape */ ||
            (unescaped.match(/\{/g)?.length || 0) - (unescaped.match(/\}/g)?.length || 0) !== 0 ||
            (unescaped.match(/\(/g)?.length || 0) - (unescaped.match(/\)/g)?.length || 0) !== 0;
          if (looksTruncated) {
            throw new Error(`Truncated LLM JSON response (content tail: ${unescaped.slice(-80).replace(/\s+/g, ' ')})`);
          }
          return { path: pathMatch[1], content: unescaped };
        }
      }
    }
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

function fallbackFrontendApp(_manifest: FrontendManifest, components: GeneratedFile[], hasBackend = false): GeneratedFile {
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
${componentTags || '        <div className="content-grid" />'}
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

  if (Array.isArray(manifest.apiResources)) {
    for (const resource of manifest.apiResources) {
      if (!resource?.name || !resource?.path || !String(resource.path).startsWith('/api/')) {
        logWarn('codeGenerationAgent:manifest-invalid-api-resource-skipped', { name: resource?.name, path: resource?.path });
      }
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
    // Preserve the LLM-specified table name; fall back to SHARED_TABLE_NAME only when absent.
    name: String(table?.name || SHARED_TABLE_NAME),
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

function backendRouteFileStub(resource: NonNullable<BackendManifest['resources']>[number]): GeneratedFile {
  const routeFile = sanitizeRoutePath('', resource.name || 'resource');
  const methods = Array.isArray(resource.methods) && resource.methods.length > 0 ? resource.methods : ['GET', 'POST'];
  const fields = Array.isArray(resource.fields) && resource.fields.length > 0 ? resource.fields : ['name', 'data'];
  // created_at is DB-managed so never inserted; exclude from both extraction and INSERT columns.
  const DB_MANAGED = ['id', 'project_id', 'created_at'];
  const insertableFields = fields.filter((f) => !DB_MANAGED.includes(f));
  const fieldExtractions = insertableFields.map((f) => `    const ${f} = req.body?.${f};`).join('\n');
  const insertFields = ['id', 'project_id', ...insertableFields];
  const insertPlaceholders = insertFields.map((_, i) => `$${i + 1}`).join(', ');
  const insertValues = insertFields.map((f) => {
    if (f === 'id') return 'id';
    if (f === 'project_id') return 'projectId';
    return f; // matches the extracted const name above
  }).join(', ');

  const handlers: string[] = [];

  if (methods.some((m) => m.toUpperCase() === 'GET')) {
    handlers.push(`router.get('/', async (req, res, next) => {
  try {
    const projectId = String(req.query.project_id || req.query.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    const result = await query(\`SELECT * FROM ${SHARED_TABLE_NAME} WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100\`, [projectId]);
    res.json({ ${resource.name || 'items'}: result.rows });
  } catch (error) {
    next(error);
  }
});`);
  }

  if (methods.some((m) => m.toUpperCase() === 'POST')) {
    handlers.push(`router.post('/', async (req, res, next) => {
  try {
    const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    const id = randomUUID();
${fieldExtractions}
    const result = await query(
      \`INSERT INTO ${SHARED_TABLE_NAME} (${insertFields.join(', ')}) VALUES (${insertPlaceholders}) RETURNING *\`,
      [${insertValues}]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});`);
  }

  if (methods.some((m) => m.toUpperCase() === 'PUT' || m.toUpperCase() === 'PATCH')) {
    const updateFields = fields.filter((f) => !['id', 'project_id', 'created_at'].includes(f));
    const setClauses = updateFields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    handlers.push(`router.put('/:id', async (req, res, next) => {
  try {
    const projectId = String(req.body?.project_id || req.body?.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
${updateFields.map((f) => `    const ${f} = req.body?.${f};`).join('\n')}
    const result = await query(
      \`UPDATE ${SHARED_TABLE_NAME} SET ${setClauses} WHERE id = $1 AND project_id = $${updateFields.length + 2} RETURNING *\`,
      [req.params.id, ${updateFields.join(', ')}, projectId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});`);
  }

  if (methods.some((m) => m.toUpperCase() === 'DELETE')) {
    handlers.push(`router.delete('/:id', async (req, res, next) => {
  try {
    const projectId = String(req.query.project_id || req.query.projectId || '').trim();
    if (!projectId) return res.status(400).json({ error: 'project_id is required' });
    const result = await query(
      \`DELETE FROM ${SHARED_TABLE_NAME} WHERE id = $1 AND project_id = $2 RETURNING id\`,
      [req.params.id, projectId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});`);
  }

  return {
    path: routeFile,
    content: `import express from 'express';
import { randomUUID } from 'crypto';
import { query } from '../db/database.ts';

const router = express.Router();

${handlers.join('\n\n')}

export default router;
`,
  };
}

async function backendRouteFile(
  resource: NonNullable<BackendManifest['resources']>[number],
  llmProxy: LLMProxyClient,
  model: string
): Promise<GeneratedFile> {
  const routeFile = sanitizeRoutePath('', resource.name || 'resource');
  const methods = Array.isArray(resource.methods) && resource.methods.length > 0 ? resource.methods : ['GET', 'POST'];
  const systemPrompt = `Generate a Node.js + Express + TypeScript route file for the resource: "${resource.name}".
Purpose: ${resource.purpose || resource.name}
Route path registered by caller: ${resource.routePath || '/api/' + resource.name}
HTTP methods to implement: ${methods.join(', ')}
Fields: ${Array.isArray(resource.fields) && resource.fields.length > 0 ? resource.fields.join(', ') : 'flexible — infer from purpose'}
Database table: ${SHARED_TABLE_NAME} (shared multi-tenant table with project_id column)
Table columns: id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

RULES:
- Always require and validate project_id from req.query (GET/DELETE) or req.body (POST/PUT/PATCH)
- Use parameterized queries — never string-interpolate user values into SQL
- Return domain-appropriate response keys (e.g. { orders: [...] } not { items: [...] }) matching the resource name
- For POST: use randomUUID() for id
- For GET: ORDER BY created_at DESC LIMIT 100
- For PUT/PATCH: WHERE id = $1 AND project_id = $N, return 404 if not found
- For DELETE: WHERE id = $1 AND project_id = $2, return 404 if not found
- Import { query } from '../db/database.ts'
- Import { randomUUID } from 'crypto' (only if POST/PUT is implemented)
- Export as: export default router

Return ONLY JSON: {"path":"${routeFile}","content":"complete TypeScript Express route file"}`;

  try {
    const parsed = await generateJson(llmProxy, model, `backendRoute:${resource.name}`, systemPrompt, { resource }, 2000);
    return validateGeneratedFile(parsed, routeFile, 'backend', `backendRoute:${resource.name}`);
  } catch (err) {
    logWarn(`backendRouteFile:llm-failed:${resource.name}`, { error: (err as Error).message });
    return backendRouteFileStub(resource);
  }
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

type TokenBudget = { initial: number; ceiling: number };

// Hard cap so a runaway estimator can never blow past provider limits.
const ABSOLUTE_TOKEN_CEILING = 20000;

function normalizeBudget(budget: number | TokenBudget): TokenBudget {
  if (typeof budget === 'number') return { initial: budget, ceiling: budget };
  const initial = Math.max(512, Math.min(ABSOLUTE_TOKEN_CEILING, Math.round(budget.initial)));
  const ceiling = Math.max(initial, Math.min(ABSOLUTE_TOKEN_CEILING, Math.round(budget.ceiling)));
  return { initial, ceiling };
}

// componentSpec shape comes from the UI spec agent — we read only the fields
// that meaningfully drive output size and ignore the rest.
function estimateComponentBudget(
  componentSpec: any,
  dependencyCount: number,
  purpose: string
): TokenBudget {
  const props = Array.isArray(componentSpec?.props) ? componentSpec.props.length : 0;
  const renderLogic = String(componentSpec?.renderLogic || '');
  const interactive = Array.isArray(componentSpec?.interactiveElements) ? componentSpec.interactiveElements.length : 0;
  const sections = Array.isArray(componentSpec?.sections) ? componentSpec.sections.length : 0;
  const stateFields = Array.isArray(componentSpec?.state) ? componentSpec.state.length : 0;
  // Mentions like "FAQ items", "pricing tiers", "table rows" hint at repeated blocks.
  const repetitionHints = (renderLogic.match(/\b(items?|rows?|tiers?|cards?|sections?|entries?|fields?)\b/gi) || []).length;

  const initial = Math.round(
    2000
    + props * 80
    + interactive * 220
    + sections * 260
    + stateFields * 180
    + repetitionHints * 200
    + dependencyCount * 140
    + (renderLogic.length + purpose.length) * 1.4
  );

  return normalizeBudget({
    initial: Math.max(3000, Math.min(9000, initial)),
    ceiling: 16000,
  });
}

function estimateAppBudget(importsCount: number, backendRequired: boolean): TokenBudget {
  const initial = 2800 + importsCount * 220 + (backendRequired ? 700 : 0);
  return normalizeBudget({
    initial: Math.max(3500, Math.min(11000, initial)),
    ceiling: 18000,
  });
}

async function generateJson(
  llmProxy: LLMProxyClient,
  model: string,
  label: string,
  systemPrompt: string,
  userPayload: unknown,
  maxTokens: number | TokenBudget
): Promise<any> {
  const { initial, ceiling } = normalizeBudget(maxTokens);
  let currentBudget = initial;
  // lastBadJson holds the LLM's response only when the call succeeded but parse failed.
  // We don't feed it back when the failure was a network/call error (no useful content to correct).
  let lastBadJson = '';
  for (let jsonAttempt = 1; jsonAttempt <= 3; jsonAttempt++) {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ];
    if (jsonAttempt > 1 && lastBadJson) {
      const trimmed = lastBadJson.trimEnd();
      const wasTruncated = !trimmed.endsWith('}') && !trimmed.endsWith('"}');
      messages.push({ role: 'assistant', content: lastBadJson.slice(0, 1200) });
      messages.push({
        role: 'user',
        content: wasTruncated
          ? 'Your response was truncated before the JSON was closed. Return ONLY a complete, valid JSON object — shorten string values if necessary but ensure the JSON is fully closed with no markdown fences.'
          : 'Your previous response was not valid JSON. Return ONLY a valid JSON object with no markdown fences, no prose, and all string values properly escaped.',
      });
    }
    let rawContent = '';
    try {
      const completion = await llmProxy.chatCompletion(messages, model, 0.0, 0.9, currentBudget, 60_000);
      rawContent = completion.choices?.[0]?.message?.content || '';
      if (!rawContent.trim()) throw new Error(`${label}: LLM returned empty response`);
      lastBadJson = rawContent; // store before parse so we can feed it back on parse failure
      return parseJsonSafe(rawContent);
    } catch (err) {
      // Only set lastBadJson when there was a response to correct (parse failure).
      // For call failures rawContent is empty — don't overwrite a prior useful response.
      if (rawContent) lastBadJson = rawContent;
      const message = err instanceof Error ? err.message : String(err);
      // Adaptive growth: if the model hit the token cap mid-JSON, the next
      // attempt needs more room or it will fail the same way.
      const wasTruncated = /Truncated LLM JSON response/.test(message);
      const nextBudget = wasTruncated && currentBudget < ceiling
        ? Math.min(ceiling, Math.max(currentBudget + 1500, Math.ceil(currentBudget * 1.6)))
        : currentBudget;
      logWarn(`${label}:json-attempt-failed:${jsonAttempt}`, {
        error: message,
        budget: currentBudget,
        nextBudget,
        truncated: wasTruncated,
        rawSnippet: lastBadJson.slice(0, 240),
      });
      currentBudget = nextBudget;
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
- Include all components needed to fully implement the user's requested features (there is no upper limit — match the scope of the request)
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
    const componentName = toComponentName(component?.name, fallbackName);
    return {
      ...component,
      path: sanitizeComponentPath(component?.path || `src/components/${componentName}.jsx`, index),
      name: componentName,
    };
  });

  manifest.components = normalizedComponents;
  manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};

  if (Array.isArray(uiSpec?.components) && uiSpec.components.length > 0) {
    const manifestNames = new Set(manifest.components.map((c: any) => String(c.name || '')));
    const missing = (uiSpec.components as Array<{ name?: string; path?: string; purpose?: string }>)
      .filter((c) => c.name && !manifestNames.has(c.name));
    if (missing.length > 0) {
      const extra = missing.flatMap((c, idx) => {
        const safeName = toComponentName(c.name, `Section${idx + 1}`);
        return [{ path: `src/components/${safeName}.jsx`, name: safeName, purpose: String(c.purpose || `${safeName} component`) }];
      });
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
  const componentName = toComponentName(component.name || path.basename(expectedPath, '.jsx'), path.basename(expectedPath, '.jsx'));
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
    estimateComponentBudget(componentSpec, dependencyCode.length, String(component.purpose || ''))
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
    estimateAppBudget(imports.length, backendRequired)
  );

  const appFile = validateGeneratedFile(parsed, 'src/App.jsx', 'frontend', 'frontendApp');
  const hasImports = imports.length > 0 && imports.some((i) => appFile.content.includes(i.name));
  const hasExport = appFile.content.includes('export default') && (appFile.content.includes('function App') || appFile.content.includes('const App') || appFile.content.includes('App ='));
  const hasRender = appFile.content.includes('return') && (appFile.content.includes('(') || appFile.content.includes('<') || appFile.content.includes('>'));
  const hasApiBase = backendRequired ? appFile.content.includes('API_BASE') || appFile.content.includes('fetch') || appFile.content.includes('http') : true;

  // Enhanced semantic checks for logical correctness and API consistency
  const hasReactImport = appFile.content.includes("import React") || appFile.content.includes("from 'react'");
  const hasProperJsx = /<[^>]*>/.test(appFile.content) && appFile.content.includes('</'); // Basic JSX check
  const hasStateManagement = appFile.content.includes('useState') || appFile.content.includes('useEffect') || !backendRequired; // State if needed
  const hasErrorHandling = backendRequired ? appFile.content.includes('try') || appFile.content.includes('catch') || appFile.content.includes('Error') : true;
  const hasApiConsistency = backendRequired ? (appFile.content.includes('fetch') && (appFile.content.includes('await') || appFile.content.includes('.then'))) : true;
  const noSyntaxErrors = !/\bundefined\b.*\./.test(appFile.content) && !/\bnull\b.*\./.test(appFile.content); // Basic check for common errors

  const logicalCorrect = hasReactImport && hasProperJsx && hasStateManagement && hasErrorHandling && hasApiConsistency && noSyntaxErrors;

  if (!hasExport || !hasRender || !hasImports || !hasApiBase || !logicalCorrect) {
    logWarn('frontendApp:semantic-check-failed', { hasExport, hasRender, hasImports, hasApiBase, backendRequired, logicalCorrect, hasReactImport, hasProperJsx, hasStateManagement, hasErrorHandling, hasApiConsistency, noSyntaxErrors });
    throw new Error('Semantic checks failed: Code does not meet logical correctness and API consistency requirements');
  }

  return appFile;
}

async function generateFrontendCss(manifest: FrontendManifest, requirements: any, appFile: GeneratedFile, componentFiles: GeneratedFile[], llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const userMessage = String(requirements?.userMessage || '').slice(0, 300);
  const systemPrompt = `Generate src/index.css for this React app: "${userMessage || manifest.appName}". Match the visual style to the app's purpose. Return ONLY JSON: {"path":"src/index.css","content":"complete CSS"}`;
  const parsed = await generateJson(llmProxy, model, 'frontendCss', systemPrompt, { manifest, requirements, appSnippet: appFile.content.slice(0, 4000), componentSnippets: componentFiles.map((f) => ({ path: f.path, content: f.content.slice(0, 1800) })) }, 4000);
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
    files.push(backendRouteFileStub(resource));
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
        const route = await backendRouteFile(resource, llmProxy, model);
        setFile(partial, route);
        events?.emit({ type: 'FILE_WRITTEN', filePath: route.path, message: `Wrote ${route.path}`, payload: { path: route.path, content: route.content } });
        return { kind: 'route', ok: true, path: route.path, resource: resource.name, expectedPath };
      } catch (err) {
        logWarn('codeGenerationAgent:route-fallback', { resource: resource.name, expectedPath, error: (err as Error).message });
        const route = backendRouteFallbackFiles(manifest).find((file) => file.path === expectedPath) || backendRouteFileStub(resource);
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

function normalizeStateName(value: unknown): string {
  return String(value || '').trim();
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = normalizeStateName(currentState);
  const normalizedNext = normalizeStateName(nextState);
  if (!normalizedCurrent) return normalizedNext || 'CLARIFICATION_REQUIRED';
  if (!normalizedNext) return 'CLARIFICATION_REQUIRED';
  return normalizedNext;
}

function semanticAlignmentScore(input: {
  projectSpec?: unknown;
  blueprint?: ProjectBlueprint;
  requirements?: unknown;
  uiSpec?: unknown;
  output?: unknown;
}): number {
  const text = [
    JSON.stringify(input.projectSpec ?? {}),
    JSON.stringify(input.blueprint ?? {}),
    JSON.stringify(input.requirements ?? {}),
    JSON.stringify(input.uiSpec ?? {}),
    JSON.stringify(input.output ?? {}),
  ].join(' ').toLowerCase();

  const score = 0.5
    + (/\bproject_id\b/.test(text) ? 0.08 : 0)
    + (/\bapi\b|\broute\b|\bendpoint\b/.test(text) ? 0.08 : 0)
    + (/\bcomponent\b|\bjsx\b/.test(text) ? 0.08 : 0)
    + (/\bplaceholder\b|\btodo\b|\btbd\b|\bgeneric text\b/.test(text) ? -0.3 : 0)
    + (/\bbackend\b|\bpostgres\b|\bdatabase\b/.test(text) ? 0.06 : 0)
    + (/\bapp\.jsx\b|\bindex\.css\b|\bmain\.jsx\b/.test(text) ? 0.06 : 0);

  return Math.max(0, Math.min(1, score));
}

function buildBlockedOutput(projectId: string) {
  return {
    files: [],
    patch: '',
    hasBackend: false,
    projectId,
    generationMode: 'state-gated-blocked',
    project_task_queue: [],
  };
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

  async function generateFrontendFiles(): Promise<GeneratedFile[]> {
    let manifest: FrontendManifest;
    try {
      manifest = await generateFrontendManifest(input.systemDesign, input.requirements, input.modification, llmProxy, model, uiSpec);
      validateManifestSemantics(manifest, input.requirements, input.projectSpec, uiSpec);
    } catch (err) {
      logWarn('codeGenerationAgent:frontend-manifest-fallback', { error: (err as Error).message });
      manifest = fallbackFrontendManifest(input.requirements, uiSpec);
    }

    const scaffoldFiles = frontendScaffold(manifest);
    // uiSpec components are authoritative but still bounded; LLM-only lists are capped tighter.
    const hasUiSpecComponents = Array.isArray(uiSpec?.components) && uiSpec.components.length > 0;
    const cap = hasUiSpecComponents ? Math.max(MAX_COMPONENTS, (uiSpec.components as unknown[]).length) : MAX_COMPONENTS;
    const componentSpecs = (manifest.components || []).slice(0, cap);

    const generatedDependencies = new Map<string, string>();
    const componentFiles: GeneratedFile[] = [];
    for (const component of componentSpecs) {
      try {
        const file = await generateFrontendComponent(component, manifest, input.requirements, llmProxy, model, uiSpec, generatedDependencies);
        generatedDependencies.set(file.path.replace(/^src\/components\//, '').replace(/\.jsx$/, ''), file.content);
        componentFiles.push(file);
        events?.emit({ type: 'FILE_WRITTEN', filePath: file.path, message: `Generated ${file.path}`, payload: { path: file.path, content: file.content } });
      } catch (err) {
        logWarn('codeGenerationAgent:component-fallback', { path: component.path, error: (err as Error).message });
        // Emit a minimal stub so the import in App.jsx resolves at runtime instead of crashing.
        const compName = toComponentName(component.name || path.basename(component.path || '', '.jsx'), 'GeneratedSection');
        const safePath = sanitizeComponentPath(component.path || `src/components/${compName}.jsx`, componentFiles.length);
        const stubFile: GeneratedFile = {
          path: safePath,
          content: `import React from 'react';\nexport default function ${compName}() {\n  return <div className="section">${compName}</div>;\n}\n`,
        };
        componentFiles.push(stubFile);
        events?.emit({ type: 'FILE_WRITTEN', filePath: stubFile.path, message: `Wrote stub ${stubFile.path}`, payload: { path: stubFile.path, content: stubFile.content } });
      }
    }

    let appFile: GeneratedFile;
    try {
      appFile = await generateFrontendApp(manifest, input.requirements, input.systemDesign, input.modification, componentFiles, llmProxy, model, uiSpec);
      validateAppImports(appFile.content, componentFiles, blueprint, uiSpec);
    } catch (err) {
      logWarn('codeGenerationAgent:app-fallback', { error: (err as Error).message });
      appFile = fallbackFrontendApp(manifest, componentFiles, hasBackend);
    }

    let cssFile: GeneratedFile;
    try {
      cssFile = await generateFrontendCss(manifest, input.requirements, appFile, componentFiles, llmProxy, model);
    } catch (err) {
      logWarn('codeGenerationAgent:css-fallback', { error: (err as Error).message });
      cssFile = fallbackFrontendCss();
    }

    return [...scaffoldFiles, appFile, cssFile, ...componentFiles];
  }

  const [frontendResult, backendResult] = await Promise.allSettled([
    generateFrontendFiles(),
    hasBackend ? generateBackendFiles(input.systemDesign, input.requirements, projectId, input.modification, llmProxy, model, events, blueprint) : Promise.resolve([] as GeneratedFile[]),
  ]);

  const frontendFiles = frontendResult.status === 'fulfilled'
    ? frontendResult.value
    : (() => {
        logError('codeGenerationAgent:frontend-failed', (frontendResult as PromiseRejectedResult).reason);
        throw new Error(`Frontend code generation failed: ${((frontendResult as PromiseRejectedResult).reason as Error)?.message || String((frontendResult as PromiseRejectedResult).reason)}`);
      })();

  const backendFiles = backendResult.status === 'fulfilled'
    ? backendResult.value
    : (() => {
        logError('codeGenerationAgent:backend-failed', backendResult.reason);
        throw new Error(`Backend code generation failed: ${(backendResult.reason as Error)?.message || String(backendResult.reason)}`);
      })();

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
    project_task_queue: [],
  };
}
