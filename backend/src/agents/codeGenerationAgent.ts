import path from 'path';
import ts from 'typescript';
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError, warn as logWarn } from '../utils/logger';
import { assertBlueprintIntegrationSafety, blueprintMissingFiles, validateProjectBlueprint, type ProjectBlueprint } from './blueprintContract';
import { validateStructuredSpec, type StructuredSpec } from './structuredSpec';
import { reviewerAgent } from './reviewerAgent';
import { parseJsonResponse, type TokenBudget, normalizeBudget } from './llmUtils';
import { AgentState } from './agentStates';

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

const FRONTEND_REQUIRED = new Set(['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css', 'public/env-config.js']);
const FRONTEND_ALLOWED_PREFIXES = [
  'src/components/',
  'src/pages/',
  'src/hooks/',
  'src/utils/',
  'src/lib/',
  'src/context/',
  'src/store/',
  'src/types/',
  'src/services/',
  'src/layouts/',
  'src/constants/',
  'src/assets/',
  'src/styles/',
  'src/features/',
  'src/config/',
  'src/data/',
  'src/theme/',
  'src/animations/',
  'src/providers/',
  'src/api/',
  'src/helpers/',
  'src/sections/',
];
const BACKEND_REQUIRED = new Set(['backend/package.json', 'backend/tsconfig.json', 'backend/src/index.ts', 'backend/src/db/database.ts', 'backend/db/init.sql']);
const BACKEND_ALLOWED_PREFIXES = [
  'backend/src/routes/',
  'backend/src/middleware/',
  'backend/src/services/',
  'backend/src/utils/',
  'backend/src/models/',
  'backend/src/config/',
  'backend/src/types/',
  'backend/src/lib/',
  'backend/src/validators/',
];
const MAX_BUILD_ATTEMPTS = 2;

// Libraries that require external API keys / service credentials at runtime.
// Generating code that imports these produces broken stubs the user cannot run.
// Any LLM output importing these is rejected and the LLM is re-prompted.
const BANNED_EXTERNAL_PACKAGES = new Set([
  '@auth0/auth0-react', 'auth0',          // needs Auth0 tenant + client ID
  'firebase', '@firebase/app',             // needs Firebase project config
  '@supabase/supabase-js',                 // needs Supabase URL + anon key
  'stripe', '@stripe/stripe-js',           // needs Stripe publishable/secret key
  'nodemailer',                            // needs SMTP credentials
  'socket.io', 'socket.io-client',         // needs matching server; complex infra
  '@sendgrid/mail',                        // needs SendGrid API key
  'twilio',                                // needs Twilio account SID + auth token
  'aws-sdk', '@aws-sdk/client-s3',         // needs AWS credentials
  'googleapis',                            // needs Google OAuth / service account
  'paypal-rest-sdk', '@paypal/checkout-server-sdk', // needs PayPal credentials
]);

// Sentence injected into every code-generation prompt so the LLM knows not to use these.
const BANNED_IMPORTS_RULE = `BANNED LIBRARIES (NEVER import or use these — they require external service credentials that are not available at generation time, producing broken code):
@auth0/auth0-react, auth0, firebase, @supabase/supabase-js, stripe, @stripe/stripe-js, nodemailer, socket.io, socket.io-client, @sendgrid/mail, twilio, aws-sdk, @aws-sdk/*, googleapis, paypal-rest-sdk.
If the user's request implies payments, email, or auth from a third-party provider: render a realistic static UI placeholder (e.g. a styled "Payment coming soon" card) — do NOT import the real library or call a real API.`;
const BAN_LIST = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', '.pnpm-store', 'bun.lockb'];
// Default table name/columns used only when the LLM does not specify a domain-specific schema
const SHARED_TABLE_NAME = 'project_items';
const SHARED_TABLE_COLUMNS = ['id TEXT PRIMARY KEY', 'project_id TEXT NOT NULL', 'name TEXT NOT NULL', "data JSONB NOT NULL DEFAULT '{}'::jsonb", 'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'];

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_$]/g, '');
  return cleaned && /^[a-zA-Z_$]/.test(cleaned) ? cleaned : fallback;
}

// Normalize a StructuredSpec (from uiSpecAgent) into the UISpec-like shape that
// codeGenerationAgent expects. StructuredSpec uses `componentSchema` instead of
// `components`, and `layoutTree.children` instead of `layoutStructure.compositionOrder`.
// Without this, uiSpec?.components is always undefined and all context-rich prompting
// (contentData, renderLogic, props) is silently dropped, producing generic names.
function normalizeUiSpec(raw: any): any {
  if (!raw) return raw;
  // Already in UISpec shape
  if (Array.isArray(raw.components)) return raw;
  // StructuredSpec shape
  if (Array.isArray(raw.componentSchema)) {
    const components = raw.componentSchema.map((c: any) => {
      const propsObj: Record<string, { type: string; required: boolean; description: string }> = {};
      if (Array.isArray(c.props)) {
        for (const p of c.props) {
          propsObj[p.name] = { type: p.type || 'string', required: Boolean(p.required), description: p.description || '' };
        }
      }
      return {
        name: c.name,
        path: c.filePath,
        purpose: c.purpose,
        props: propsObj,
        state: Array.isArray(c.stateKeys) ? c.stateKeys : [],
        dependencies: Array.isArray(c.children) ? c.children : [],
        renderLogic: c.purpose || '',
        contentData: c.contentData || undefined,
      };
    });
    const compositionOrder: string[] = Array.isArray(raw.layoutTree?.children)
      ? raw.layoutTree.children.map((n: any) => n.component).filter(Boolean)
      : components.map((c: any) => c.name);
    return {
      ...raw,
      components,
      layoutStructure: {
        appRoot: 'App',
        compositionOrder,
        stateManagement: 'props drilling',
      },
      appName: raw.appName || '',
    };
  }
  return raw;
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


// Delimited-file format: avoids JSON-string escape fragility for code.
// Model is asked to emit:
//   <<<FILE:relative/path.ext>>>
//   ...raw code, no escaping...
//   <<<END>>>
// Any prose before/after is ignored.
// Accept both 2 and 3 closing `>` — LLMs occasionally emit `<<` instead of `<<<`.
const FILE_BLOCK_RE = /<<<FILE:([^\n>]+?)>{2,3}\s*\n([\s\S]*?)\n?<<<END>>>/;
const FILE_OPEN_SCAN_RE = /<<<FILE:[^\n>]+>{2,3}/;

function parseFileBlock(content: string, expectedPath?: string): { path: string; content: string } {
  let raw = content;
  // Strip code fences only if they wrap the whole response (don't break inner ``` content).
  const fenceMatch = raw.match(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) raw = fenceMatch[1];

  const m = raw.match(FILE_BLOCK_RE);
  if (m) {
    const filePath = m[1].trim();
    const body = m[2];
    if (!body.trim()) throw new Error('File block has empty body');
    return { path: filePath, content: body };
  }

  // Tolerant fallback: opening marker but missing/truncated <<<END>>>.
  // If the response was cut off mid-file, surface a truncation error so the
  // caller grows the budget on retry instead of writing a half file.
  const openIdx = raw.search(FILE_OPEN_SCAN_RE);
  if (openIdx !== -1) {
    const headerMatch = raw.slice(openIdx).match(/^<<<FILE:([^\n>]+?)>{2,3}\s*\n/);
    if (headerMatch) {
      const filePath = headerMatch[1].trim();
      const bodyStart = openIdx + headerMatch[0].length;
      const endIdx = raw.indexOf('<<<END>>>', bodyStart);
      if (endIdx !== -1) {
        const body = raw.slice(bodyStart, endIdx).replace(/\n$/, '');
        return { path: filePath, content: body };
      }
      throw new Error(`Truncated file block (no <<<END>>> marker) for ${filePath}; tail: ${raw.slice(-80).replace(/\s+/g, ' ')}`);
    }
  }

  if (expectedPath) {
    throw new Error(`No <<<FILE:...>>> block found for ${expectedPath}. Snippet: ${raw.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  throw new Error(`No <<<FILE:...>>> block found. Snippet: ${raw.replace(/\s+/g, ' ').slice(0, 220)}`);
}

function isProbablyTruncatedGeneratedFile(filePath: string, content: string): boolean {
  const trimmed = content.trim();
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim()).length;
  const lowerPath = filePath.toLowerCase();

  if (lowerPath.endsWith('src/app.jsx') || lowerPath.endsWith('src/app.tsx')) {
    return trimmed.length < 500 || lines < 8 || !/export\s+default\s+function\s+App|export\s+default\s+App|function\s+App\s*\(/.test(trimmed);
  }

  if (lowerPath.endsWith('src/index.css')) {
    return trimmed.length < 200 || lines < 8 || /color|display|position|margin|padding|font-size|background/.test(trimmed) === false;
  }

  if (/\.(jsx|tsx|js|ts)$/.test(lowerPath)) {
    return trimmed.length < 120 && lines < 5;
  }

  if (/\.css$/.test(lowerPath)) {
    return trimmed.length < 100 && lines < 5;
  }

  return false;
}

function containsPlaceholderText(value: string): boolean {
  // Only flag content that is clearly an unfilled stub — not legitimate code that happens
  // to contain related words. False positives here silently produce empty stub components.
  //
  // Rejected patterns (explicitly stub-like):
  //   - TODO comment/annotation
  //   - "placeholder text" / "placeholder content" / "placeholder data" as prose
  //   - "generic text" as literal copy
  //
  // NOT rejected:
  //   - placeholder="..." HTML/JSX attribute (stripped before check)
  //   - placeholder={...} JSX expression attribute
  //   - PascalCase component names containing "Placeholder" (e.g. PlaceholderAvatar)
  //   - CSS/JS identifiers like `placeholderColor`, `--placeholder-color`
  //   - Any word that merely contains "placeholder" as a substring in code context
  if (/\bTODO\b/.test(value)) return true;
  if (/\bgeneric text\b/i.test(value)) return true;
  // Strip HTML/JSX attribute assignments and PascalCase/camelCase identifiers so only
  // plain prose occurrences of "placeholder" remain.
  const stripped = value
    .replace(/\bplaceholder\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\{[^}]*\})/gi, '') // placeholder="..." / placeholder={...}
    .replace(/\b[A-Z][a-zA-Z]*[Pp]laceholder[a-zA-Z]*/g, '')                      // PascalCase: PlaceholderAvatar
    .replace(/\b[a-z][a-zA-Z]*[Pp]laceholder[a-zA-Z]*/g, '')                      // camelCase: placeholderColor
    .replace(/--[a-z-]*placeholder[a-z-]*/g, '');                                  // CSS custom props: --placeholder-color
  // Only flag "placeholder" as a standalone prose word followed by a noun — unambiguously stub copy.
  return /\bplaceholder\s+(?:text|content|data|image|value|name|title|description)\b/i.test(stripped);
}

function validateGeneratedFile(file: unknown, expectedPath: string | undefined, scope: 'frontend' | 'backend', label: string): GeneratedFile {
  const obj = assertObject(file, label);
  const filePath = normalizePath(String(obj.path || expectedPath || ''));
  const content = obj.content;
  if (!filePath) throw new Error(`${label}: missing path`);
  if (expectedPath && filePath !== expectedPath) throw new Error(`${label}: expected path ${expectedPath}, got ${filePath}`);
  if (!isAllowedPath(filePath, scope)) throw new Error(`${label}: invalid or disallowed path ${filePath}`);
  if (typeof content !== 'string' || !content.trim()) throw new Error(`${label}: missing content for ${filePath}`);
  if (containsPlaceholderText(content)) throw new Error(`${label}: generated content contains placeholder text for ${filePath}`);
  // Reject any file that imports a banned external-service library (would produce broken stubs)
  if (['.jsx', '.tsx', '.js', '.ts'].includes(path.extname(filePath).toLowerCase())) {
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    let imp: RegExpExecArray | null;
    while ((imp = importRe.exec(content)) !== null) {
      const pkg = imp[1].startsWith('@') ? imp[1].split('/').slice(0, 2).join('/') : imp[1].split('/')[0];
      if (BANNED_EXTERNAL_PACKAGES.has(pkg)) {
        throw new Error(`${label}: generated ${filePath} imports banned external-service package "${pkg}" (requires credentials not available at generation time)`);
      }
    }
  }
  // Reject components that have routing-orchestrator names — routing lives in App.jsx only.
  if (scope === 'frontend' && filePath.startsWith('src/components/')) {
    const baseName = path.basename(filePath, '.jsx');
    if (/Router$|Routes$|RouterView$/i.test(baseName)) {
      throw new Error(`${label}: component name "${baseName}" implies routing ownership — routing must live in App.jsx only. Rename to a page or layout component.`);
    }
    // Detect runtime prop-guard patterns that would crash if a prop is not supplied:
    //   if (!props.RouteView) throw ...   or   if (!RouteView) throw ...
    const routingPropGuard = /if\s*\(!(?:props\.)?(?:RouteView|routeView|RouteComponent|routeComponent)\)/.test(content);
    if (routingPropGuard) {
      throw new Error(`${label}: component "${baseName}" enforces a routing-related required prop. Routing props are forbidden in components — routing lives in App.jsx.`);
    }
  }

  if (filePath === 'src/App.jsx') {
    const hasExport = /export\s+default\s+(function|const|class|\w+)/.test(content);
    const hasAppName = /\bfunction\s+App\b|\bconst\s+App\b|\bclass\s+App\b|\bexport\s+default\s+App\b/.test(content);
    if (!hasExport || !hasAppName) {
      throw new Error(`${label}: App.jsx appears incomplete or missing export default App`);
    }
  }
  if (['.jsx', '.tsx', '.js', '.ts'].includes(path.extname(filePath).toLowerCase())) {
    const sourceKind = ['.tsx', '.jsx'].includes(path.extname(filePath).toLowerCase()) ? ts.JsxEmit.Preserve : undefined;
    const transpile = ts.transpileModule(content, {
      compilerOptions: {
        jsx: sourceKind,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: filePath,
      reportDiagnostics: true,
    });

    const diagnostics = transpile.diagnostics || [];
    if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
      throw new Error(`${label}: generated ${filePath} contains syntax or parse errors`);
    }

    // ts.transpileModule misses two LLM-specific patterns that esbuild rejects at build:
    //   1. Bare English sentences inside a function body (no `//` prefix).
    //   2. Single/double-quoted CSS strings split across lines (unterminated literal).
    // Catch them here so we retry at generation time, not after a wasted build cycle.
    const lines = content.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const trimmed = lines[li].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      // Bare-prose detector: starts with capital letter, ends in '.', no JS syntax tokens,
      // ≥3 alphabetic words. Mirrors fixBareProseComments in testFixAgent.
      if (
        /^[A-Z]/.test(trimmed) &&
        trimmed.endsWith('.') &&
        !/[=(){};:<>\[\]+*&|?!`]/.test(trimmed) &&
        (trimmed.match(/[A-Za-z]+/g) || []).length >= 3
      ) {
        throw new Error(`${label}: generated ${filePath} contains a bare English sentence at line ${li + 1} (LLM forgot the // prefix): "${trimmed.slice(0, 80)}"`);
      }
    }
    // Unterminated-string detector: scan line-by-line for unbalanced single/double quotes
    // (template literals with backticks are legal multi-line, so ignored).
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let inDouble = false;
      let inSingle = false;
      let inBacktick = false;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (ch === '\\') { ci++; continue; }
        if (ch === '`' && !inDouble && !inSingle) inBacktick = !inBacktick;
        else if (inBacktick) continue;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "'" && !inDouble) inSingle = !inSingle;
      }
      if (inDouble || inSingle) {
        throw new Error(`${label}: generated ${filePath} has an unterminated string literal at line ${li + 1} (likely a CSS value split across lines): "${line.trim().slice(0, 80)}"`);
      }
    }

    // ts.transpileModule suppresses duplicate-identifier errors that esbuild catches at build time.
    // Detect the pattern: same symbol declared twice (e.g. `function Foo` then `export default function Foo`).
    const topLevelDeclRe = /^\s*(?:export\s+default\s+)?(?:function|const|class|let|var)\s+([A-Z][A-Za-z0-9_$]*)/gm;
    const declCounts = new Map<string, number>();
    let m: RegExpExecArray | null;
    while ((m = topLevelDeclRe.exec(content)) !== null) {
      const sym = m[1];
      declCounts.set(sym, (declCounts.get(sym) ?? 0) + 1);
    }
    const duplicates = [...declCounts.entries()].filter(([, count]) => count > 1).map(([sym]) => sym);
    if (duplicates.length > 0) {
      throw new Error(`${label}: generated ${filePath} has duplicate top-level declarations for: ${duplicates.join(', ')} — esbuild will reject this`);
    }
  }
  return { path: filePath, content };
}

function setFile(files: Map<string, string>, file: GeneratedFile) {
  files.set(normalizePath(file.path), file.content);
}

// Component basenames that collide with framework files at src/<name>.jsx.
// A manifest component named "App" would force validateAppImports to require
// `import App from './components/App.jsx'` inside src/App.jsx — which then
// redeclares `App` via `export default function App()`, breaking the build.
const RESERVED_COMPONENT_BASENAMES = new Set(['App', 'Main', 'Index', 'Root']);

function isReservedComponentName(name: string): boolean {
  return RESERVED_COMPONENT_BASENAMES.has(name);
}

function deReserveComponentName(name: string): string {
  return isReservedComponentName(name) ? `${name}Section` : name;
}

function sanitizeComponentPath(rawPath: string, index: number): string {
  const p = normalizePath(rawPath || '');
  if (p.startsWith('src/components/') && p.endsWith('.jsx') && !p.includes('..')) {
    const base = path.basename(p, '.jsx');
    if (isReservedComponentName(base)) {
      return `src/components/${deReserveComponentName(base)}.jsx`;
    }
    return p;
  }
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
      .map((c) => {
        const rawName = String(c.name || '').trim() || 'Section';
        const name = deReserveComponentName(rawName);
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
    ...pages.map((page: any, i: number) => {
      const pageLabel = typeof page === 'string' ? page : String(page?.name || page?.title || page?.path || `Page ${i + 1}`);
      const rawSlug = pageLabel.replace(/[^a-zA-Z0-9]/g, '') || `Page${i + 1}`;
      const slug = deReserveComponentName(rawSlug);
      return { path: `src/components/${slug}.jsx`, name: slug, purpose: `${pageLabel} page content and functionality.` };
    }),
  ];

  if (components.length === 0) {
    components.push(
      { path: 'src/components/Overview.jsx', name: 'Overview', purpose: 'Core user workflow overview.' },
      { path: 'src/components/Workspace.jsx', name: 'Workspace', purpose: 'Primary interactive workspace.' }
    );
  }

  return { appName, dependencies: {}, apiResources: [], components, styleNotes: 'Clean responsive application UI.' };
}

// Returns components that should be rendered directly in App.jsx (root-level only).
// Priority: (1) compositionOrder from uiSpec, (2) last 40% of generationOrder (page-level roots),
// (3) all components as fallback.
// The old sibling-import heuristic is removed — with dependency-ordered parallel generation,
// leaf components don't import siblings, so the heuristic misclassified everything as a root.
function filterRootComponents(components: GeneratedFile[], compositionOrder?: string[], uiGenOrder?: string[]): GeneratedFile[] {
  const nameOf = (f: GeneratedFile) => sanitizeIdentifier(path.basename(f.path, '.jsx'), 'GeneratedSection');

  if (compositionOrder && compositionOrder.length > 0) {
    const orderLower = compositionOrder.map((n) => n.toLowerCase());
    const ordered = components
      .filter((f) => orderLower.includes(nameOf(f).toLowerCase()))
      .sort((a, b) => orderLower.indexOf(nameOf(a).toLowerCase()) - orderLower.indexOf(nameOf(b).toLowerCase()));
    if (ordered.length > 0) return ordered;
  }

  // uiSpec generationOrder is leaf-first (children before parents).
  // The last 40% of the order are page-level compositors — those are the roots App.jsx renders.
  if (uiGenOrder && uiGenOrder.length > 0) {
    const cutoff = Math.floor(uiGenOrder.length * 0.6);
    const rootNames = new Set(uiGenOrder.slice(cutoff).map((n) => n.toLowerCase()));
    const roots = components.filter((f) => rootNames.has(nameOf(f).toLowerCase()));
    if (roots.length > 0) return roots;
  }

  return components;
}

function fallbackFrontendApp(_manifest: FrontendManifest, components: GeneratedFile[], hasBackend = false, compositionOrder?: string[]): GeneratedFile {
  const rootComponents = filterRootComponents(components, compositionOrder);
  const imports = components.map((file) => `import ${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} from './${file.path.replace(/^src\//, '')}';`).join('\n');
  const apiInit = hasBackend ? `
  const API_BASE = window.__ENV__?.API_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';
  const PROJECT_ID = window.__ENV__?.PROJECT_ID || import.meta.env.VITE_PROJECT_ID || '';
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

  const wrappedTags = rootComponents
    .map((file) => {
      const name = sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection');
      return `        <ErrorBoundary name="${name}"><${name} /></ErrorBoundary>`;
    })
    .join('\n');

  return {
    path: 'src/App.jsx',
    content: `import React from 'react';
${imports}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('[ErrorBoundary] ' + this.props.name + ':', e.message, info.componentStack); }
  render() {
    if (this.state.error) return <div style={{padding:'16px',background:'#fee2e2',color:'#991b1b',borderRadius:'8px',margin:'8px'}}>[{this.props.name}] {this.state.error.message}</div>;
    return this.props.children;
  }
}

export default function App() {
${apiInit}
  return (
    <main className="app-shell">
${wrappedTags || '        <div className="content-grid" />'}
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
  const systemPrompt = `Create a backend implementation manifest for Node.js + TypeScript + Express + PostgreSQL for this app: "${userMessage}".
Return ONLY JSON with shape:
{"resources":[{"name":"...","routePath":"/api/...","tableName":"<domain_table>","fields":["field1","field2"],"methods":["GET","POST","PUT","DELETE"],"purpose":"..."}],"tables":[{"name":"<domain_table>","columns":["id TEXT PRIMARY KEY","project_id TEXT NOT NULL","...domain columns...","created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"],"purpose":"..."}]}

Rules:
- Choose meaningful, domain-specific table names (e.g. "products", "orders", "users", "posts") — NOT generic names like "items".
- Every table MUST include a "project_id TEXT NOT NULL" column for multi-tenant isolation.
- Every table MUST include "id TEXT PRIMARY KEY" and "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()".
- Add domain-appropriate columns based on the app requirements.
- Each resource's tableName must match a table defined in the tables array.
- routePath must always start with /api/.`;
  return generateJson(llmProxy, model, 'backendManifest', systemPrompt, { requirements, userDescription: userMessage, backendDesign: systemDesign?.backend || null, modification: null }, 1800)
    .then((parsed) => parseBackendManifest(parsed));
}

function parseBackendManifest(raw: unknown): BackendManifest {
  const manifest = assertObject(raw, 'backendManifest') as BackendManifest;
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const normalizedResources = resources.map((resource, index) => {
    // Slugify the name so human-readable values like "CV Uploads" or "Parsing / Sync"
    // don't silently fail path/route validation downstream.
    const rawName = String(resource?.name || `resource${index + 1}`);
    const name = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `resource${index + 1}`;
    const routePath = String(resource?.routePath || `/api/${name}`);
    // Use LLM-specified tableName; fall back to sanitized resource name, then default
    const rawTable = typeof resource?.tableName === 'string' && resource.tableName.trim() ? resource.tableName.trim() : name.toLowerCase().replace(/[^a-z0-9_]/g, '_') || SHARED_TABLE_NAME;
    return {
      ...resource,
      name,
      routePath: routePath.startsWith('/api/') ? routePath : `/api/${name}`,
      tableName: rawTable,
      methods: Array.isArray(resource?.methods) && resource.methods.length > 0 ? resource.methods : ['GET', 'POST'],
      purpose: String(resource?.purpose || `Data operations for ${name}`),
    };
  });

  const tables = Array.isArray(manifest.tables) ? manifest.tables : [];
  const normalizedTables = tables.map((table) => {
    const tableName = String(table?.name || SHARED_TABLE_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
    const rawColumns: string[] = Array.isArray(table?.columns) && table.columns.length > 0 ? table.columns : [];
    // Ensure required multi-tenant columns are always present
    const hasId = rawColumns.some(c => /\bid\b/i.test(c));
    const hasProjectId = rawColumns.some(c => /project_id/i.test(c));
    const hasCreatedAt = rawColumns.some(c => /created_at/i.test(c));
    const columns = [
      ...(hasId ? [] : ['id TEXT PRIMARY KEY']),
      ...(hasProjectId ? [] : ['project_id TEXT NOT NULL']),
      ...rawColumns,
      ...(hasCreatedAt ? [] : ['created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()']),
    ];
    return {
      ...table,
      name: tableName,
      columns,
      purpose: String(table?.purpose || `Domain data storage for ${tableName}`),
    };
  });

  return { resources: normalizedResources, tables: normalizedTables };
}

function sanitizeComponentName(rawName: string, index: number): string {
  return sanitizeIdentifier(rawName || `GeneratedSection${index + 1}`, `GeneratedSection${index + 1}`);
}

function frontendScaffold(manifest: FrontendManifest): GeneratedFile[] {
  const dependencies = { react: '^18.3.1', 'react-dom': '^18.3.1', 'prop-types': '^15.8.1', ...(manifest.dependencies || {}) };
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
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${manifest.appName || 'Generated App'}</title><script src="/env-config.js"></script></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`
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
    {
      // Placeholder — overwritten with real values (API_URL, PROJECT_ID) after build, before Vercel upload
      path: 'public/env-config.js',
      content: `window.__ENV__ = { API_URL: '', PROJECT_ID: '' };`,
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
      dev: 'tsx src/index.ts',
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
      tsx: '^4.7.0',
      typescript: '^5.4.0',
      '@types/express': '^5.0.0',
      '@types/node': '^22.0.0',
      '@types/cors': '^2.8.17',
    },
  };

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src/**/*'],
  };

  return [
    {
      path: 'backend/package.json',
      content: JSON.stringify(packageJson, null, 2),
    },
    {
      path: 'backend/tsconfig.json',
      content: JSON.stringify(tsconfig, null, 2),
    },
    {
      path: 'backend/src/db/database.ts',
      content: `import { Pool, type PoolClient } from 'pg';

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
export const pool = new Pool(connectionString ? { connectionString } : {});

// Isolate each project's data inside its own Postgres schema.
// DB_SCHEMA is injected as an env var by the deployment pipeline (e.g. proj_<projectId>).
const DB_SCHEMA = process.env.DB_SCHEMA || 'public';

pool.on('connect', (client: PoolClient) => {
  client.query(\`SET search_path TO \${DB_SCHEMA}, public\`).catch(() => {});
});

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
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from './db/database.js';

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

async function registerRoutes() {
  // Auto-register all route files from the routes directory.
  // Route files export a default Express Router; the filename sets the /api/<name> path.
  const routesDir = path.join(__dirname, 'routes');
  if (!existsSync(routesDir)) return;
  const files = readdirSync(routesDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const routePath = \`/api/\${path.basename(file, '.js')}\`;
      const mod = await import(new URL(\`./routes/\${file}\`, import.meta.url).href);
      app.use(routePath, mod.default);
      console.log(\`[routes] registered \${routePath}\`);
    } catch (err) {
      console.warn(\`[routes] failed to load \${file}:\`, err instanceof Error ? err.message : String(err));
    }
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

async function start() {
  await initDb();
  await registerRoutes();
  app.listen(port, () => console.log(\`Backend on port \${port}\`));
}

start().catch((err) => { console.error('Startup error:', err); process.exit(1); });
`,
    },
    {
      path: 'backend/db/init.sql',
      content: `CREATE TABLE IF NOT EXISTS project_items (
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
  const tableName = String(resource.tableName || resource.name || SHARED_TABLE_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
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
    const result = await query(\`SELECT * FROM ${tableName} WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100\`, [projectId]);
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
      \`INSERT INTO ${tableName} (${insertFields.join(', ')}) VALUES (${insertPlaceholders}) RETURNING *\`,
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
      \`UPDATE ${tableName} SET ${setClauses} WHERE id = $1 AND project_id = $${updateFields.length + 2} RETURNING *\`,
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
      \`DELETE FROM ${tableName} WHERE id = $1 AND project_id = $2 RETURNING id\`,
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
import { query } from '../db/database.js';

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
  const resourceTable = String(resource.tableName || resource.name || SHARED_TABLE_NAME).replace(/[^a-zA-Z0-9_]/g, '_');
  const systemPrompt = `Generate a Node.js + Express + TypeScript route file for the resource: "${resource.name}".
Purpose: ${resource.purpose || resource.name}
Route path registered by caller: ${resource.routePath || '/api/' + resource.name}
HTTP methods to implement: ${methods.join(', ')}
Fields: ${Array.isArray(resource.fields) && resource.fields.length > 0 ? resource.fields.join(', ') : 'flexible — infer from purpose'}
Database table: ${resourceTable} (multi-tenant table with project_id column for isolation)
Table columns: id TEXT PRIMARY KEY, project_id TEXT NOT NULL, <domain columns>, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

RULES:
- Always require and validate project_id from req.query (GET/DELETE) or req.body (POST/PUT/PATCH)
- Use parameterized queries — never string-interpolate user values into SQL
- Return domain-appropriate response keys (e.g. { orders: [...] } not { items: [...] }) matching the resource name
- For POST: use randomUUID() for id
- For GET: ORDER BY created_at DESC LIMIT 100
- For PUT/PATCH: WHERE id = $1 AND project_id = $N, return 404 if not found
- For DELETE: WHERE id = $1 AND project_id = $2, return 404 if not found
- Import { query } from '../db/database.js' (MUST use .js extension — NOT .ts — for Node16 module resolution)
- Import { randomUUID } from 'crypto' (only if POST/PUT is implemented)
- Export as: export default router
- ${BANNED_IMPORTS_RULE}`;

  try {
    const parsed = await generateFile(llmProxy, model, `backendRoute:${resource.name}`, routeFile, systemPrompt, { resource }, { initial: 2500, ceiling: 9000 });
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
    // Floor at 4000 so tiny components never waste budget; no upper clamp so
    // complex components (large tables, many state fields, many sections) get
    // the tokens they actually need on the first attempt instead of truncating
    // and triggering a costly retry.
    initial: Math.max(4000, initial),
    ceiling: 32000,
  });
}

function estimateAppBudget(importsCount: number, backendRequired: boolean): TokenBudget {
  const initial = 1800 + importsCount * 120 + (backendRequired ? 500 : 0);
  return normalizeBudget({
    // No cap: 100 components needs ~14k tokens; capping at 6k guaranteed truncation.
    initial: Math.max(2000, initial),
    ceiling: 32000,
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
  for (let jsonAttempt = 1; jsonAttempt <= 3; jsonAttempt++) {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPayload) },
    ];
    if (jsonAttempt > 1) {
      messages.push({
        role: 'user',
        content: 'Your previous response was not a valid, complete JSON object. Return ONLY a single valid JSON object — no markdown fences, no prose, all strings properly escaped, fully closed.',
      });
    }
    let rawContent = '';
    try {
      // Pass undefined for timeoutMs so LLMProxyClient auto-scales by max_tokens
      // (its computed defaultTimeout is much smarter than a fixed 60s).
      const completion = await llmProxy.chatCompletion(messages, model, 0.0, 0.9, currentBudget);
      rawContent = completion.choices?.[0]?.message?.content || '';
      if (!rawContent.trim()) throw new Error(`${label}: LLM returned empty response`);
      return parseJsonResponse(rawContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Budget Exceeded/i.test(message)) throw err;
      const looksTruncated = /No valid JSON found|Unexpected end of JSON|Unterminated string/i.test(message);
      const nextBudget = looksTruncated && currentBudget < ceiling
        ? Math.min(ceiling, Math.max(currentBudget + 4000, Math.ceil(currentBudget * 2.2)))
        : currentBudget;
      logWarn(`${label}:json-attempt-failed:${jsonAttempt}`, {
        error: message,
        budget: currentBudget,
        nextBudget,
        truncated: looksTruncated,
        rawSnippet: rawContent.slice(0, 240),
      });
      currentBudget = nextBudget;
      if (jsonAttempt === 3) throw err;
    }
  }
  throw new Error(`${label}: all JSON self-heal attempts exhausted`);
}

// generateFile asks the LLM to return a single source file using the
// <<<FILE:path>>> ... <<<END>>> delimited format. This sidesteps the
// JSON-string-escape fragility that caused the bulk of the truncation
// failures in the logs (template literals, backslashes, embedded quotes).
async function generateFile(
  llmProxy: LLMProxyClient,
  model: string,
  label: string,
  expectedPath: string,
  systemPromptBody: string,
  userPayload: unknown,
  maxTokens: number | TokenBudget
): Promise<{ path: string; content: string }> {
  const { initial, ceiling } = normalizeBudget(maxTokens);
  let currentBudget = initial;
  const formatPreamble = `Return ONLY a single delimited file block. No JSON, no markdown fences, no prose.

Format EXACTLY (literal markers, raw code in between):
<<<FILE:${expectedPath}>>>
...complete file contents here, with real newlines and no escape sequences...
<<<END>>>

Rules:
- Emit the opening marker on its own line, then the file body, then <<<END>>> on its own line.
- Do NOT wrap the body in quotes or escape characters.
- Do NOT include any text outside the markers.`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: `${systemPromptBody}\n\n${formatPreamble}` },
      { role: 'user', content: JSON.stringify(userPayload) },
    ];
    if (attempt > 1) {
      messages.push({
        role: 'user',
        content: `Your previous response did not produce a complete <<<FILE:${expectedPath}>>>...<<<END>>> block. Emit ONLY the delimited block. The body must be complete, syntactically valid, and end with <<<END>>> on its own line.`,
      });
    }
    let rawContent = '';
    try {
      const completion = await llmProxy.chatCompletion(messages, model, 0.0, 0.9, currentBudget);
      rawContent = completion.choices?.[0]?.message?.content || '';
      if (!rawContent.trim()) throw new Error(`${label}: LLM returned empty response`);
      const parsedFile = parseFileBlock(rawContent, expectedPath);
      if (isProbablyTruncatedGeneratedFile(parsedFile.path, parsedFile.content)) {
        throw new Error(`${label}: truncated file block or too-short file content for ${parsedFile.path}`);
      }
      return parsedFile;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Budget exhausted for this project — retrying won't help, fail immediately.
      if (/Budget Exceeded/i.test(message)) throw err;
      const looksTruncated = /Truncated file block|No <<<FILE|too-short file content/i.test(message);
      const nextBudget = looksTruncated && currentBudget < ceiling
        ? Math.min(ceiling, Math.max(currentBudget + 4000, Math.ceil(currentBudget * 2.0)))
        : currentBudget;
      logWarn(`${label}:file-attempt-failed:${attempt}`, {
        error: message,
        budget: currentBudget,
        nextBudget,
        truncated: looksTruncated,
        rawSnippet: rawContent.slice(0, 240),
      });
      currentBudget = nextBudget;
      if (attempt === 3) throw err;
    }
  }
  throw new Error(`${label}: all file self-heal attempts exhausted`);
}

async function generateFrontendManifest(systemDesign: any, requirements: any, modification: string | undefined, llmProxy: LLMProxyClient, model: string, uiSpec?: any): Promise<FrontendManifest> {
  // If uiSpec already has a component list, build the manifest from it directly —
  // no LLM call needed. The LLM call just re-derives what uiSpecAgent already computed,
  // and name-reconciliation mismatches downstream are worse than skipping it entirely.
  if (Array.isArray(uiSpec?.components) && uiSpec.components.length > 0) {
    const components = (uiSpec.components as Array<{ name?: string; path?: string; purpose?: string }>)
      .filter((c) => c.name && String(c.name) !== 'App')
      .map((c, idx) => {
        const safeName = deReserveComponentName(toComponentName(c.name, `Section${idx + 1}`));
        return {
          path: sanitizeComponentPath(c.path || `src/components/${safeName}.jsx`, idx),
          name: safeName,
          purpose: String(c.purpose || `${safeName} component`),
        };
      });
    return {
      appName: String(systemDesign?.frontend?.appName || requirements?.appName || uiSpec?.appName || 'GeneratedApp').trim() || 'GeneratedApp',
      dependencies: {},
      apiResources: [],
      components,
      styleNotes: '',
    } as FrontendManifest;
  }

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
    const rawName = toComponentName(component?.name, fallbackName);
    const componentName = deReserveComponentName(rawName);
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
        const safeName = deReserveComponentName(toComponentName(c.name, `Section${idx + 1}`));
        return [{ path: `src/components/${safeName}.jsx`, name: safeName, purpose: String(c.purpose || `${safeName} component`) }];
      });
      manifest.components = [...manifest.components, ...extra];
      logWarn('codeGenerationAgent:manifest-reconciled-uispec', { added: extra.map((c) => c.name) });
    }
  }

  // Ensure every required page has a corresponding section component in the manifest.
  // The LLM manifest prompt asks for this but doesn't always produce it.
  if (pages.length > 0) {
    const manifestNames = new Set((manifest.components as Array<{ name?: string }>).map((c) => String(c.name || '').toLowerCase()));
    const missingPages = pages.filter((page: any) => {
      const pageLabel = typeof page === 'string' ? page : String(page?.name || page?.title || '');
      const slug = deReserveComponentName(pageLabel.replace(/[^a-zA-Z0-9]/g, '') || 'Section');
      return !manifestNames.has(slug.toLowerCase()) && !manifestNames.has(`${slug.toLowerCase()}section`) && !manifestNames.has(`${slug.toLowerCase()}page`);
    });
    if (missingPages.length > 0) {
      const added = missingPages.map((page: any, idx: number) => {
        const pageLabel = typeof page === 'string' ? page : String(page?.name || page?.title || `Section${idx + 1}`);
        const slug = deReserveComponentName(pageLabel.replace(/[^a-zA-Z0-9]/g, '') || `Section${idx + 1}`);
        return { path: `src/components/${slug}.jsx`, name: slug, purpose: `${pageLabel} section — full content and functionality` };
      });
      manifest.components = [...manifest.components, ...added];
      logWarn('codeGenerationAgent:manifest-reconciled-pages', { added: added.map((c: { name: string }) => c.name) });
    }
  }

  // Deduplicate components case-insensitively by slug — logs showed "home"+"Home",
  // "contact"+"Contact" etc. all entering generation, doubling LLM calls and failures.
  const seenSlugs = new Set<string>();
  manifest.components = manifest.components.filter((c) => {
    const slug = String(c.name || c.path || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenSlugs.has(slug)) return false;
    seenSlugs.add(slug);
    return true;
  });

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
  const backendRequired = Boolean(requirements?.backend_required || requirements?.auth_required);
  const componentSpec = uiSpec?.components?.find((c: any) => c.name === componentName);
  const dependencyCode = componentSpec?.dependencies
    ?.map((dep: string) => {
      const content = generatedDependencies?.get(dep);
      if (!content) return { dep, code: undefined };
      // Extract only the exported function signature + props destructuring instead of
      // truncating raw content to 500 chars. This gives the parent LLM the exact prop
      // names without wasting tokens on implementation details.
      const sigMatch = content.match(/export\s+default\s+function\s+\w+\s*\(([^)]*)\)/);
      const sig = sigMatch ? `export default function ${dep}(${sigMatch[1]}) { /* ... */ }` : `export default function ${dep}(props) { /* ... */ }`;
      return { dep, code: sig.slice(0, 400) };
    })
    .filter((d: any) => d.code) || [];

  const contentData = componentSpec?.contentData && typeof componentSpec.contentData === 'object' ? componentSpec.contentData : null;
  const systemPrompt = `Generate one focused React component file for: "${userMessage || manifest.appName}".
Component: ${componentName}
Purpose: ${component.purpose || componentName}

${componentSpec ? `Props interface:
${JSON.stringify(componentSpec.props, null, 2)}

Render logic: ${componentSpec.renderLogic}
` : ''}${contentData ? `CANONICAL CONTENT — use these exact values verbatim in the JSX, do not invent alternatives:
${JSON.stringify(contentData, null, 2)}

` : ''}

${dependencyCode.length > 0 ? `Already-generated child components (import and use these):
${dependencyCode.map((d: any) => `${d.dep}: ${d.code}`).join('\n---\n')}
` : ''}

RULES — ALL are mandatory:
- Export: export default function ${componentName}(props) { ... }
- ONE responsibility: this component renders ONLY "${component.purpose || componentName}". Nothing else.
- SIZE LIMIT: target 100-200 lines. Hard max 350 lines. Keep it focused — one responsibility.
- ROUTING PROHIBITION: NEVER import or use BrowserRouter, Router, Routes, Route, Switch, useNavigate, useLocation, Link from react-router in this file. Routing lives ONLY in App.jsx. This component receives its data via props.
- ${backendRequired ? 'API CALLS: If this component fetches data, declare at the top of the function body: const API_BASE = window.__ENV__?.API_URL || import.meta.env.VITE_API_URL || \'http://localhost:3000\'; const PROJECT_ID = window.__ENV__?.PROJECT_ID || import.meta.env.VITE_PROJECT_ID || \'\'; — Always include project_id: PROJECT_ID in all GET/DELETE query params and POST/PUT/PATCH request bodies. Never hardcode URLs.' : 'No backend calls in this component.'}
- No TODO comments, no placeholder text, no stub implementations.
- COMMENTS MUST USE // SYNTAX: NEVER write plain English sentences inside a function body without a // prefix. Every comment line MUST start with //. BAD (syntax error): \`Validate required prop at runtime to help catch incorrect usage early.\` GOOD: \`// Validate required prop at runtime to help catch incorrect usage early.\` — A bare English sentence inside a function is a hard syntax error.
- Real JSX with actual content matching the purpose — not lorem ipsum, not generic examples.
- All imports at the top. Only import what you use.
- useState/useEffect only if genuinely needed for THIS component's local behaviour.
- REACT-ICONS: Only use icon names that actually exist in react-icons v5. Pick icons that match the app's domain — do NOT default to dev-tools icons unless the app is dev-tools.
  Safe Si (brand) icons: SiPython, SiTypescript, SiJavascript, SiReact, SiNodedotjs, SiDocker, SiKubernetes, SiAmazon, SiGooglecloud, SiMicrosoftazure, SiPostgresql, SiMongodb, SiRedis, SiGit, SiGithub, SiLinux, SiTensorflow, SiPytorch, SiOpenai, SiHuggingFace, SiMeta, SiVercel, SiNetlify, SiFastapi, SiFlask, SiDjango, SiGraphql, SiTailwindcss, SiVite, SiStripe, SiPaypal, SiVisa, SiMastercard, SiGoogle, SiApple, SiFacebook, SiInstagram, SiX, SiLinkedin, SiYoutube, SiTiktok, SiWhatsapp, SiSlack, SiDiscord, SiTelegram, SiSpotify, SiNetflix, SiAirbnb, SiUber, SiShopify.
  Safe Fa (generic) icons — navigation/UI: FaHome, FaUser, FaSearch, FaCog, FaBell, FaTrash, FaEdit, FaSave, FaPlus, FaMinus, FaTimes, FaCheck, FaChevronDown, FaChevronUp, FaChevronLeft, FaChevronRight, FaArrowLeft, FaArrowRight, FaEllipsisH, FaEllipsisV, FaFilter, FaSort, FaBars, FaCircle.
  Auth/security: FaSignInAlt, FaSignOutAlt, FaLock, FaUnlock, FaShieldAlt, FaKey, FaUserPlus, FaUsers, FaUserShield.
  Status/feedback: FaCheckCircle, FaTimesCircle, FaExclamationCircle, FaInfoCircle, FaExclamationTriangle, FaQuestionCircle, FaSpinner.
  Data/admin: FaTasks, FaChartBar, FaChartLine, FaChartPie, FaDatabase, FaServer, FaCode, FaTerminal, FaCloud, FaDownload, FaUpload, FaFile, FaFileAlt, FaFolder, FaPaperclip, FaTable, FaList.
  Commerce/payments: FaShoppingCart, FaShoppingBag, FaCreditCard, FaMoneyBillAlt, FaDollarSign, FaTag, FaPercent, FaReceipt, FaBoxOpen, FaTruck, FaStore.
  Communication: FaEnvelope, FaPhone, FaComments, FaCommentDots, FaPaperPlane, FaInbox, FaHeadset.
  Social/engagement: FaHeart, FaStar, FaThumbsUp, FaThumbsDown, FaShare, FaBookmark, FaEye, FaEyeSlash.
  Media: FaImage, FaImages, FaCamera, FaVideo, FaPlay, FaPause, FaMusic, FaMicrophone.
  Calendar/time: FaCalendar, FaCalendarAlt, FaClock, FaHistory, FaStopwatch.
  Location/travel: FaMapMarkerAlt, FaMap, FaPlane, FaCar, FaHotel, FaUtensils.
  Misc generic: FaBalanceScale, FaGavel, FaRocket, FaBug, FaFlag, FaFlagCheckered, FaBolt, FaBookOpen, FaGraduationCap, FaBriefcase, FaBuilding, FaIndustry, FaHeartbeat, FaStethoscope.
  NEVER invent icon names — if unsure, use FaCircle or omit entirely. CRITICAL: FaScaleBalanced does NOT exist — use FaBalanceScale instead.
- JSX ATTRIBUTES: NEVER put the same attribute on a JSX element twice. BAD: <div style={base} style={{...base, color:'red'}}>. GOOD: <div style={{...base, color:'red'}}>. Duplicate attributes are a hard esbuild compile error.
- OBJECT LITERALS: NEVER repeat the same key in a JS object. BAD: { padding: 12, background: '#fff', padding: 8 }. Duplicate keys are a hard esbuild compile error.
- CSS STRINGS — SINGLE LINE ONLY: NEVER split a CSS string value across multiple lines. String literals containing commas (rgba(), linear-gradient(), transition shorthand) MUST fit entirely on ONE line. BAD (syntax error): \`background: 'linear-gradient(rgba(255,\\n  255,0.03))'\`. GOOD: \`background: 'linear-gradient(rgba(255,255,0.03))'\`. A newline inside a JS string literal is a hard syntax error that will break the build. This applies to ALL gradient/rgba strings — \`linear-gradient(#0f172a 0%, #071029 100%)\` MUST be on a SINGLE line. NEVER break after the opening parenthesis of a gradient.
- ${BANNED_IMPORTS_RULE}`;

  const budget = estimateComponentBudget(componentSpec, dependencyCode.length, String(component.purpose || ''));
  const payload = {
    component,
    appName: manifest.appName,
    requirements,
    componentName,
    userDescription: userMessage,
    componentSpec,
    dependencyCode: dependencyCode.length > 0 ? dependencyCode : undefined,
  };

  const parsed = await generateFile(llmProxy, model, `frontendComponent:${expectedPath}`, expectedPath, systemPrompt, payload, budget);

  try {
    return validateGeneratedFile(parsed, expectedPath, 'frontend', `frontendComponent:${expectedPath}`);
  } catch (err) {
    // If validation fails only due to placeholder text, make one targeted retry with an explicit
    // anti-placeholder instruction before letting the caller fall back to a stub.
    if (/placeholder/i.test((err as Error).message)) {
      logWarn(`frontendComponent:placeholder-retry:${expectedPath}`, { error: (err as Error).message });
      const antiPlaceholderPrompt = `${systemPrompt}\n\nCRITICAL: Do NOT use placeholder text, TODO comments, lorem ipsum, or stub content of any kind. Every value in the JSX must be real, specific, and appropriate for "${component.purpose || componentName}".`;
      const reparsed = await generateFile(llmProxy, model, `frontendComponent:${expectedPath}:noplaceholder`, expectedPath, antiPlaceholderPrompt, payload, budget);
      return validateGeneratedFile(reparsed, expectedPath, 'frontend', `frontendComponent:${expectedPath}:noplaceholder`);
    }
    throw err;
  }
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
  const userMessage = String(requirements?.userMessage || '').slice(0, 500);
  const layoutInfo = uiSpec?.layoutStructure || {};
  const compositionOrder: string[] | undefined = Array.isArray(layoutInfo.compositionOrder) && layoutInfo.compositionOrder.length > 0
    ? layoutInfo.compositionOrder
    : undefined;

  // All components must be importable; only root components should be rendered at top-level.
  const allImports = componentFiles.map((file) => ({
    name: sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection'),
    importLine: `import ${sanitizeIdentifier(path.basename(file.path, '.jsx'), 'GeneratedSection')} from './${file.path.replace(/^src\//, '')}';`,
  }));
  const uiGenOrder: string[] | undefined = Array.isArray(uiSpec?.generationOrder) ? uiSpec.generationOrder : undefined;
  const rootFiles = filterRootComponents(componentFiles, compositionOrder, uiGenOrder);
  const rootNames = rootFiles.map((f) => sanitizeIdentifier(path.basename(f.path, '.jsx'), 'GeneratedSection'));

  // Build a required-props summary for each root component from uiSpec, so App.jsx knows what to pass.
  const rootPropsHints: string[] = [];
  if (uiSpec?.components) {
    for (const name of rootNames) {
      const spec = uiSpec.components.find((c: any) => String(c.name || '').trim() === name);
      if (!spec?.props) continue;
      const required = Object.entries(spec.props as Record<string, { required?: boolean; type?: string }>)
        .filter(([, v]) => v?.required)
        .map(([k, v]) => `${k}: ${v.type || 'any'}`);
      if (required.length > 0) rootPropsHints.push(`${name} requires props: { ${required.join(', ')} }`);
    }
  }

  const systemPrompt = `Generate src/App.jsx — the composition root for a React + Vite app: "${userMessage || manifest.appName}".

App.jsx is the ONLY file that owns routing and navigation. All child components are already generated.

App root structure: ${layoutInfo.appRoot || 'Main app wrapper'}
State management: ${layoutInfo.stateManagement || 'Props drilling'}
Navigation strategy: ${layoutInfo.navigationStrategy || 'Single page'}

ALL component imports (import all of these at the top of the file):
${allImports.map((i) => i.importLine).join('\n')}

ROOT components to render in JSX (render ONLY these — do NOT render child components directly, they are already composed inside their parents):
${rootNames.join(', ')}
${rootPropsHints.length > 0 ? `\nRequired props for root components — you MUST pass these when rendering:\n${rootPropsHints.join('\n')}` : ''}

${backendRequired ? `Backend required — initialize at the top of the file:
const API_BASE = window.__ENV__?.API_URL || import.meta.env.VITE_API_URL || 'http://localhost:3000';
const PROJECT_ID = window.__ENV__?.PROJECT_ID || import.meta.env.VITE_PROJECT_ID || '';
` : ''}

ERROR BOUNDARY — you MUST include this class verbatim before the App function:
\`\`\`
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('[ErrorBoundary] ' + this.props.name + ':', e.message, info.componentStack); }
  render() {
    if (this.state.error) return <div style={{padding:'16px',background:'#fee2e2',color:'#991b1b',borderRadius:'8px',margin:'8px'}}>[{this.props.name}] {this.state.error.message}</div>;
    return this.props.children;
  }
}
\`\`\`
Wrap EACH root component in JSX with <ErrorBoundary name="ComponentName">...</ErrorBoundary>. This catches runtime crashes and surfaces the broken component name in the console so errors can be diagnosed.

RULES:
- Export: export default function App() { ... }
- Import ALL components listed above but only render the ROOT components in JSX.
- CRITICAL: Do not render sub-components (non-root) directly in App — they are already used inside their parent components. Rendering them here would duplicate entire sections.
- This file handles routing (BrowserRouter + Routes + Route) and/or page-switching state. Child components do NOT.
- If multi-page: use BrowserRouter + Routes. If single-page with sections: render all root sections top-to-bottom.
- Keep App.jsx lean: routing + layout shell + top-level state only. No business logic inside App.jsx itself.
- SIZE: target 60-120 lines. Hard max 200 lines (ErrorBoundary adds ~10 lines). Pass data to children via props, not inline logic.
- ${backendRequired ? 'Use API_BASE for all fetch calls. Always include project_id: PROJECT_ID in query params (GET/DELETE) or request body (POST/PUT). Handle loading and error states.' : 'No backend calls.'}
- No TODOs, no stubs, no placeholder comments.
- COMMENTS MUST USE // SYNTAX: Every comment line inside the function body MUST start with //. NEVER write bare English sentences without // — they are syntax errors.
- Generation order: ${(uiSpec?.generationOrder || []).join(' -> ') || 'all components'}
- ${BANNED_IMPORTS_RULE}`;

  const parsed = await generateFile(
    llmProxy,
    model,
    'frontendApp',
    'src/App.jsx',
    systemPrompt,
    {
      requirements,
      userDescription: userMessage,
      frontendDesign: systemDesign?.frontend || null,
      manifest,
      componentImports: allImports,
      rootComponentNames: rootNames,
      modification: modification || null,
      layoutInfo,
      backendRequired,
      uiSpec: uiSpec ? { generationOrder: uiSpec.generationOrder, navigationStrategy: uiSpec.navigationStrategy, stateManagementStrategy: uiSpec.stateManagementStrategy } : undefined,
    },
    estimateAppBudget(allImports.length, backendRequired)
  );

  const appFile = validateGeneratedFile(parsed, 'src/App.jsx', 'frontend', 'frontendApp');
  const hasImports = allImports.length > 0 && allImports.some((i) => appFile.content.includes(i.name));
  const hasExport = appFile.content.includes('export default') && (appFile.content.includes('function App') || appFile.content.includes('const App') || appFile.content.includes('App ='));
  const hasRender = appFile.content.includes('return') && (appFile.content.includes('(') || appFile.content.includes('<') || appFile.content.includes('>'));
  const hasApiBase = backendRequired ? appFile.content.includes('API_BASE') || appFile.content.includes('fetch') || appFile.content.includes('http') : true;

  // Enhanced semantic checks for logical correctness and API consistency
  const hasReactImport = appFile.content.includes("import React") || appFile.content.includes("from 'react'");
  const hasProperJsx = /<[^>]*>/.test(appFile.content) && appFile.content.includes('</'); // Basic JSX check
  const hasStateManagement = appFile.content.includes('useState') || appFile.content.includes('useEffect') || !backendRequired; // State if needed
  const hasErrorHandling = backendRequired ? appFile.content.includes('try') || appFile.content.includes('catch') || appFile.content.includes('Error') : true;
  const hasApiConsistency = backendRequired ? (appFile.content.includes('fetch') && (appFile.content.includes('await') || appFile.content.includes('.then'))) : true;

  const logicalCorrect = hasReactImport && hasProperJsx && hasStateManagement && hasErrorHandling && hasApiConsistency;

  if (!hasExport || !hasRender || !hasImports || !hasApiBase || !logicalCorrect) {
    logWarn('frontendApp:semantic-check-failed', { hasExport, hasRender, hasImports, hasApiBase, backendRequired, logicalCorrect, hasReactImport, hasProperJsx, hasStateManagement, hasErrorHandling, hasApiConsistency });
    throw new Error('Semantic checks failed: Code does not meet logical correctness and API consistency requirements');
  }

  return appFile;
}

// Extract className tokens that actually appear in the generated JSX, so the
// CSS prompt only has to style what exists — not re-read the entire codebase.
function extractClassNames(jsxSources: string[]): string[] {
  const found = new Set<string>();
  const classAttrRe = /className\s*=\s*(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})/g;
  for (const src of jsxSources) {
    let m: RegExpExecArray | null;
    while ((m = classAttrRe.exec(src)) !== null) {
      const raw = (m[1] || m[2] || m[3] || '').trim();
      if (!raw) continue;
      // Strip template-literal interpolations like ${cond ? 'a' : 'b'}.
      raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).forEach((tok) => {
        if (tok && /^[a-zA-Z][\w-]*$/.test(tok)) found.add(tok);
      });
    }
  }
  return Array.from(found).sort();
}

function verifyCssCoverage(cssContent: string, classNames: string[]): number {
  if (classNames.length === 0) return 1;
  const covered = classNames.filter((cn) => cssContent.includes(`.${cn}`));
  return covered.length / classNames.length;
}

async function generateFrontendCss(manifest: FrontendManifest, requirements: any, appFile: GeneratedFile, componentFiles: GeneratedFile[], llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const userMessage = String(requirements?.userMessage || '').slice(0, 400);
  const styleNotes = String((manifest as any)?.styleNotes || '').slice(0, 600);
  const classNames = extractClassNames([appFile.content, ...componentFiles.map((f) => f.content)]).slice(0, 220);

  function buildCssPrompt(extraInstruction?: string): string {
    return `Generate src/index.css for this React app: "${userMessage || manifest.appName}".

Class names used in the JSX — write rules for all of them:
${classNames.map((c) => `.${c}`).join(', ') || '(no className attributes — emit a sensible base stylesheet)'}

${styleNotes ? `Style direction: ${styleNotes}` : ''}
${extraInstruction ? `\nCRITICAL: ${extraInstruction}` : ''}

RULES:
- One complete, self-contained plain CSS file. CSS variables on :root are encouraged.
- Structure: 1) :root variables, 2) reset/base, 3) layout, 4) component rules, 5) responsive.
- Every class name listed above must have a rule. No omissions.
- Write clean, minimal CSS — no duplicated selectors, no redundant rules, no commented-out blocks.
- Target 150-300 lines. If you are over 400 lines you are over-engineering it — use variables and shared rules.`;
  }

  // CSS for rich landing/marketing pages routinely lands at 12k-18k output
  // tokens. Use a generous ceiling close to ABSOLUTE_TOKEN_CEILING so we
  // don't silently fall back to the bare-bones fallback CSS.
  const parsed = await generateFile(
    llmProxy,
    model,
    'frontendCss',
    'src/index.css',
    buildCssPrompt(),
    { appName: manifest.appName, classNames, styleNotes },
    { initial: 4000, ceiling: 12000 }
  );
  if (isProbablyTruncatedGeneratedFile(parsed.path, parsed.content)) {
    throw new Error(`frontendCss: generated content appears too short or incomplete for ${parsed.path}`);
  }
  const cssFile = validateGeneratedFile(parsed, 'src/index.css', 'frontend', 'frontendCss');

  // Verify coverage: if < 80% of classNames have rules, retry with the missing list injected.
  const coverage = verifyCssCoverage(cssFile.content, classNames);
  if (coverage < 0.8 && classNames.length > 0) {
    const missing = classNames.filter((cn) => !cssFile.content.includes(`.${cn}`));
    logWarn('codeGenerationAgent:css-coverage-low', { coverage: Math.round(coverage * 100), missingCount: missing.length, sample: missing.slice(0, 8) });
    try {
      const retryPrompt = buildCssPrompt(`The following class names are MISSING rules in your output — you MUST include a CSS rule for each: ${missing.map((c) => `.${c}`).join(', ')}`);
      const retried = await generateFile(llmProxy, model, 'frontendCss:retry', 'src/index.css', retryPrompt, { appName: manifest.appName, classNames, missing }, { initial: 5000, ceiling: 14000 });
      if (!isProbablyTruncatedGeneratedFile(retried.path, retried.content)) {
        return validateGeneratedFile(retried, 'src/index.css', 'frontend', 'frontendCss:retry');
      }
    } catch (retryErr) {
      logWarn('codeGenerationAgent:css-coverage-retry-failed', { error: (retryErr as Error).message });
    }
  }

  return cssFile;
}

function buildBackendFilesFromManifest(manifest: BackendManifest): GeneratedFile[] {
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

function backendRouteFallbackFiles(manifest: BackendManifest): GeneratedFile[] {
  return (manifest.resources || []).map((resource) => backendRouteFileStub(resource));
}

async function generateBackendInitSql(manifest: BackendManifest, requirements: any, llmProxy: LLMProxyClient, model: string): Promise<GeneratedFile> {
  const tables = Array.isArray(manifest.tables) && manifest.tables.length > 0 ? manifest.tables : [{ name: SHARED_TABLE_NAME, columns: SHARED_TABLE_COLUMNS }];
  const tableNames = tables.map(t => String(t.name)).join(', ');
  const systemPrompt = `Generate backend/db/init.sql using CREATE TABLE IF NOT EXISTS statements for these domain-specific tables: ${tableNames}.
Each table MUST include a "project_id TEXT NOT NULL" column for multi-tenant isolation, an "id TEXT PRIMARY KEY", and a "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()". Add domain-appropriate columns based on the table name and app requirements. Use the provided manifest for column hints.`;
  const parsed = await generateFile(llmProxy, model, 'backendInitSql', 'backend/db/init.sql', systemPrompt, { manifest, requirements }, { initial: 2200, ceiling: 6000 });
  const file = validateGeneratedFile(parsed, 'backend/db/init.sql', 'backend', 'backendInitSql');
  if (!/project_id/i.test(file.content)) throw new Error('backendInitSql: SQL must include project_id column in all tables');
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
  if (!normalizedCurrent) return normalizedNext || AgentState.NEXT_CLARIFICATION;
  if (!normalizedNext) return AgentState.NEXT_CLARIFICATION;
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

  const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('code_generation');
  const llmProxy = new LLMProxyClient({ apiKey, projectId: input?.projectId, fallbacks });
  const events: EventSink | undefined = typeof input.emitEvent === 'function' ? { emit: input.emitEvent } : undefined;

  const retrievedPatches: string[] = [];

  const hasBackend = Boolean(input.projectSpec?.requirements?.backend_required ?? input.systemDesign?.backend);
  const projectId: string = input.projectId || 'unknown';
  const uiSpec = normalizeUiSpec(input.uiSpec);

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

    // Blueprint is the single source of truth for what files must exist.
    // Self-heal may have added components to blueprint.files that aren't in the
    // manifest (derived from uiSpec). Merge them in so code generation actually
    // produces every file the blueprint declares.
    const manifestComponents = manifest.components || [];
    manifest.components = manifestComponents;
    const blueprintComponentPaths = new Set(manifestComponents.map((c: any) => normalizePath(c.path || '')));
    for (const bpFile of blueprint.files) {
      if (bpFile.kind === 'component' && bpFile.path.startsWith('src/components/') && !blueprintComponentPaths.has(normalizePath(bpFile.path))) {
        const compName = toComponentName(path.basename(bpFile.path, '.jsx'), 'GeneratedSection');
        manifestComponents.push({ path: bpFile.path, name: compName, purpose: bpFile.purpose || `${compName} component` });
        blueprintComponentPaths.add(normalizePath(bpFile.path));
      }
    }

    const scaffoldFiles = frontendScaffold(manifest);
    // Use every component the blueprint/uiSpec decided the project needs.
    // No artificial cap: the project defines its own scope.
    const hasUiSpecComponents = Array.isArray(uiSpec?.components) && uiSpec.components.length > 0;
    const blueprintComponentCount = blueprint.files.filter((f) => f.kind === 'component' && f.path.startsWith('src/components/')).length;
    const authoritative = Math.max(hasUiSpecComponents ? (uiSpec.components as unknown[]).length : 0, blueprintComponentCount);
    const componentSpecs = authoritative > 0
      ? (manifest.components || []).slice(0, authoritative)
      : (manifest.components || []);

    // Build dependency graph from uiSpec so we can sequence generation leaf-first.
    // A component is "ready" once all components it depends on (its children) have
    // been generated and their content is in generatedDependencies.
    const componentDepMap = new Map<string, string[]>();
    for (const spec of componentSpecs) {
      const uiComp = uiSpec?.components?.find((c: any) => String(c.name || '') === String(spec.name || ''));
      const deps = Array.isArray(uiComp?.dependencies) ? uiComp.dependencies.filter(Boolean) : [];
      componentDepMap.set(String(spec.name || ''), deps);
    }

    const componentResults: Array<{ index: number; file: GeneratedFile }> = [];
    const generatedDependencies = new Map<string, string>();

    // Ready queue: items whose dependencies are all satisfied.
    // pending: indices of items not yet enqueued or generated.
    const pendingIndices = new Set<number>(componentSpecs.map((_, i) => i));
    const readyQueue: Array<{ component: typeof componentSpecs[0]; index: number }> = [];

    function refreshReadyQueue(): void {
      for (const idx of pendingIndices) {
        const spec = componentSpecs[idx];
        const deps = componentDepMap.get(String(spec.name || '')) || [];
        const allReady = deps.every(dep => generatedDependencies.has(dep));
        if (allReady) {
          readyQueue.push({ component: spec, index: idx });
          pendingIndices.delete(idx);
        }
      }
    }
    refreshReadyQueue(); // seed with leaf components (no deps)

    // Run up to COMPONENT_CONCURRENCY workers; each worker picks from readyQueue
    // and waits briefly when the queue is empty but pendingIndices is not yet drained.
    const COMPONENT_CONCURRENCY = Math.min(10, Math.max(4, Math.ceil(componentSpecs.length / 6)));

    async function runComponentSlot(): Promise<void> {
      while (true) {
        const item = readyQueue.shift();
        if (!item) {
          if (pendingIndices.size === 0) break; // all done
          await new Promise<void>(r => setTimeout(r, 60)); // wait for a dep to finish
          continue;
        }
        const { component, index } = item;
        try {
          const file = await generateFrontendComponent(component, manifest, input.requirements, llmProxy, model, uiSpec, generatedDependencies);
          // Key by both component name AND bare filename so lookups from either side work.
          const compName = String(component.name || '');
          if (compName) generatedDependencies.set(compName, file.content);
          generatedDependencies.set(file.path.replace(/^src\/components\//, '').replace(/\.jsx$/, ''), file.content);
          componentResults.push({ index, file });
          events?.emit({ type: 'FILE_WRITTEN', filePath: file.path, message: `Generated ${file.path}`, payload: { path: file.path, content: file.content } });
        } catch (err) {
          logWarn('codeGenerationAgent:component-fallback', { path: component.path, error: (err as Error).message });
          const compName = toComponentName(component.name || path.basename(component.path || '', '.jsx'), 'GeneratedSection');
          const safePath = sanitizeComponentPath(component.path || `src/components/${compName}.jsx`, index);
          const stubFile: GeneratedFile = {
            path: safePath,
            // STUB_COMPONENT marker is intentional — testFixAgent reads it to identify files
            // that need real generation. Do not remove this comment from the stub.
            content: `import React from 'react';\n/* STUB_COMPONENT: ${compName} — generation failed, needs real implementation */\nexport default function ${compName}() {\n  return <div className="section">${compName}</div>;\n}\n`,
          };
          componentResults.push({ index, file: stubFile });
          // Mark as done (empty string) so waiting parents are unblocked — they'll get
          // the stub content at generation time, which is better than waiting forever.
          if (component.name) generatedDependencies.set(String(component.name), '');
          generatedDependencies.set(safePath.replace(/^src\/components\//, '').replace(/\.jsx$/, ''), '');
          events?.emit({ type: 'STUB_COMPONENT', filePath: stubFile.path, message: `Stub emitted for ${stubFile.path} — generation failed: ${(err as Error).message}`, payload: { path: stubFile.path, content: stubFile.content, reason: (err as Error).message } });
        }
        refreshReadyQueue(); // unlock components whose deps are now satisfied
      }
    }

    await Promise.all(Array.from({ length: Math.min(COMPONENT_CONCURRENCY, Math.max(1, componentSpecs.length)) }, runComponentSlot));
    // Restore original blueprint ordering
    componentResults.sort((a, b) => a.index - b.index);
    const componentFiles = componentResults.map((r) => r.file);

    let appFile: GeneratedFile;
    try {
      appFile = await generateFrontendApp(manifest, input.requirements, input.systemDesign, input.modification, componentFiles, llmProxy, model, uiSpec);
      // Throws on import path mismatches — caught below, triggers fallbackFrontendApp.
      validateAppImports(appFile.content, componentFiles, blueprint, uiSpec);
    } catch (err) {
      logWarn('codeGenerationAgent:app-generation-fallback', { error: (err as Error).message });
      appFile = fallbackFrontendApp(manifest, componentFiles, hasBackend, uiSpec?.layoutStructure?.compositionOrder);
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
        const repairedApp = fallbackFrontendApp(fallbackFrontendManifest(input.requirements, uiSpec), frontendFiles.filter((f) => f.path.startsWith('src/components/')), hasBackend, uiSpec?.layoutStructure?.compositionOrder);
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
    const repairedStubApp = fallbackFrontendApp(frontendManifest, componentFiles, hasBackend, uiSpec?.layoutStructure?.compositionOrder);
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
