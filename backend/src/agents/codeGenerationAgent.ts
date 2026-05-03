
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';
import { debug, error as logError, warn as logWarn } from '../utils/logger';

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
    let depth = 0, inStr = false, escaped = false;
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
  throw new Error('No valid JSON found in LLM response');
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
  maxRetries = 3,
  label = 'llmCall'
): Promise<string> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await llmProxy.chatCompletion(messages, model, 0.0, 0.9, maxTokens, timeoutMs);
      const content: string = completion.choices?.[0]?.message?.content || '';
      if (typeof content === 'string' && /^[\s]*<!doctype|<html/i.test(content)) {
        throw new Error(`${label}: LLM returned HTML error page`);
      }
      if (!content.trim()) throw new Error(`${label}: LLM returned empty response`);
      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logWarn(`${label}:attempt${attempt}`, { error: lastError.message });
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2500 * attempt));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------

const BAN_LIST = [
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.pnpm-store', 'bun.lockb',
];

function filterAndNormalizeFiles(
  files: Array<{ path: string; content: string }>
): Array<{ path: string; content: string }> {
  const seen = new Map<string, string>();
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    const p = f.path.replace(/^\/+/, '');
    if (BAN_LIST.some(b => p === b || p.startsWith(`${b}/`))) continue;
    if (p.startsWith('node_modules') || p.includes('/node_modules/')) continue;
    if (p.startsWith('dist/') || p === 'dist') continue;
    seen.set(p, f.content); // later (backend) entries overwrite earlier (frontend)
  }
  return Array.from(seen.entries()).map(([path, content]) => ({ path, content }));
}

// ---------------------------------------------------------------------------
// Phase 1 — Frontend (React + Vite)
// ---------------------------------------------------------------------------

async function generateFrontendFiles(
  systemDesign: any,
  requirements: any,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string
): Promise<Array<{ path: string; content: string }>> {

  const systemPrompt = `You are a senior frontend engineer. Generate a complete React + Vite 5 web application.

=== VITE PROJECT STRUCTURE (follow exactly) ===
- index.html           → ROOT level (NOT inside public/). Must have: <div id="root"></div> and <script type="module" src="/src/main.jsx"></script>
- vite.config.js       → ROOT level. Use @vitejs/plugin-react
- package.json         → ROOT level. Must include scripts: { "dev": "vite", "build": "vite build", "preview": "vite preview" }
- src/main.jsx         → ReactDOM.createRoot(document.getElementById('root')).render(<App />)
- src/App.jsx          → Main app component with all routing/pages
- src/index.css        → Global styles (can be minimal)
- src/components/*.jsx → Reusable components (as needed)
- src/pages/*.jsx      → Page components if multi-page (optional)

=== CRITICAL RULES ===
1. index.html at ROOT level (NEVER in public/) — this is Vite, not Create React App
2. "type": "module" in package.json (ES modules)
3. Every npm import in code MUST be declared in package.json dependencies/devDependencies
4. devDependencies must include: "vite": "^5.4.20", "@vitejs/plugin-react": "^4.3.1"
5. dependencies must include: "react": "^18.3.1", "react-dom": "^18.3.1"
6. Images: use https://via.placeholder.com/WIDTHxHEIGHT (never external URLs)
7. NO package-lock.json, NO node_modules, NO dist files
8. All file contents must be COMPLETE — do not truncate or use comments like "// ... rest of code"
9. For icons: use unicode emojis or simple CSS shapes — do NOT import icon libraries unless explicitly listed in requirements
10. CSS: prefer inline styles or simple CSS files — no Tailwind/shadcn unless requirements explicitly ask for it
11. API calls: ALWAYS use "const API_BASE = import.meta.env.VITE_API_BASE_URL || '';" and call endpoints as `${API_BASE}/api/resource` — NEVER hardcode localhost or relative /api paths

=== OUTPUT FORMAT ===
Respond with ONLY valid JSON — no markdown fences, no explanation, no text before or after:
{"files": [{"path": "string", "content": "string"}, ...]}`;

  const userPrompt = JSON.stringify({
    requirements,
    frontendDesign: systemDesign?.frontend || null,
    authDesign: systemDesign?.auth || null,
    modification: modification || null,
    hasBackend: Boolean(systemDesign?.backend),
    backendApiBase: systemDesign?.backend ? 'import.meta.env.VITE_API_BASE_URL' : null,
    backendApiNote: systemDesign?.backend
      ? 'Use import.meta.env.VITE_API_BASE_URL as the API base. Example: const API = import.meta.env.VITE_API_BASE_URL || ""; fetch(`${API}/api/users`). This value is injected at build time.'
      : null,
  });

  const raw = await callWithRetry(
    llmProxy,
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model,
    8000,
    240_000,
    3,
    'generateFrontend'
  );

  const parsed = parseJsonSafe(raw);
  if (!Array.isArray(parsed?.files)) {
    throw new Error(`Frontend generation returned invalid output (no files array). Raw snippet: ${raw.slice(0, 200)}`);
  }
  return parsed.files.filter((f: any) => typeof f?.path === 'string' && typeof f?.content === 'string');
}

// ---------------------------------------------------------------------------
// Phase 2 — Backend (Express + DB)
// ---------------------------------------------------------------------------

async function generateBackendFiles(
  systemDesign: any,
  requirements: any,
  projectId: string,
  modification: string | undefined,
  llmProxy: LLMProxyClient,
  model: string
): Promise<Array<{ path: string; content: string }>> {

  const safeId = projectId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 24);
  const tablePrefix = `proj_${safeId}_`;

  const systemPrompt = `You are a senior backend engineer. Generate a complete Node.js + Express backend API.

=== DB TABLE NAMESPACE ===
ALL database tables MUST use prefix: "${tablePrefix}"
Example: table "users" → "${tablePrefix}users", table "posts" → "${tablePrefix}posts"
This is mandatory — the DB is shared across projects and prefix prevents conflicts.

=== BACKEND STRUCTURE (all files under backend/ directory) ===
- backend/package.json         → "type":"module", scripts: {"start":"node index.js","build":"echo done"}, deps: express, pg, cors
- backend/index.js             → Express server (port from process.env.PORT||3000), imports routes, runs DB init on startup
- backend/db/database.js       → pg Pool via process.env.POSTGRES_URL, exports { pool, query(sql,params) }
- backend/db/init.sql          → CREATE TABLE IF NOT EXISTS for each table (using "${tablePrefix}" prefix)
- backend/routes/[resource].js → One file per resource with CRUD routes (GET /api/resource, POST, PUT, DELETE)
- backend/middleware/           → Optional middleware files

=== backend/index.js template ===
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from './db/database.js';
// import routes...

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Mount routes
// app.use('/api/users', usersRouter);

// DB init: run init.sql at startup
async function initDb() {
  try {
    const sql = readFileSync(join(__dirname, 'db/init.sql'), 'utf8');
    if (sql.trim()) await query(sql);
    console.log('DB initialized');
  } catch (e) { console.warn('DB init warning:', e.message); }
}

app.get('/api/health', async (req, res) => {
  try { await query('SELECT 1'); res.json({ status: 'ok', db: 'connected' }); }
  catch (e) { res.status(500).json({ status: 'error', db: String(e) }); }
});

app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });

initDb().then(() => app.listen(port, () => console.log(\`Backend on port \${port}\`)));

=== CRITICAL RULES ===
1. "type": "module" in backend/package.json (ES modules, use import/export)
2. All tables in init.sql MUST be prefixed with "${tablePrefix}"
3. database.js exports a query(sql, params) helper using pg Pool
4. CORS must be enabled for all routes (allow all origins)
5. All routes must have try/catch with proper error responses
6. backend/db/init.sql must use CREATE TABLE IF NOT EXISTS (safe to re-run)
7. backend/package.json scripts.build MUST be present (can be "echo done" if no build needed)
8. NO package-lock.json, NO node_modules

=== OUTPUT FORMAT ===
Respond with ONLY valid JSON — no markdown fences, no explanation:
{"files": [{"path": "string", "content": "string"}, ...]}`;

  const userPrompt = JSON.stringify({
    requirements,
    backendDesign: systemDesign?.backend || null,
    databaseDesign: systemDesign?.database || null,
    authDesign: systemDesign?.auth || null,
    tablePrefix,
    modification: modification || null,
  });

  const raw = await callWithRetry(
    llmProxy,
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    model,
    7000,
    240_000,
    3,
    'generateBackend'
  );

  const parsed = parseJsonSafe(raw);
  if (!Array.isArray(parsed?.files)) {
    throw new Error(`Backend generation returned invalid output (no files array). Raw snippet: ${raw.slice(0, 200)}`);
  }
  return parsed.files.filter((f: any) => typeof f?.path === 'string' && typeof f?.content === 'string');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function codeGenerationAgent(input: any) {
  debug('codeGenerationAgent:start', { projectId: input?.projectId });
  if (!input) throw new Error('codeGenerationAgent: input required');

  const { model, apiKey } = getModelConfigForTask('code_generation');
  const llmProxy = new LLMProxyClient({ apiKey });

  // RAG: retrieve similar patches for context (best-effort, non-blocking)
  let retrievedPatches: string[] = [];
  try {
    const basis = JSON.stringify({
      systemDesign: input.systemDesign,
      requirements: input.requirements,
    });
    const embedding = await embeddingAgent(basis);
    if (Array.isArray(embedding) && embedding.length > 0) {
      const similar = await searchVectors({
        user_id: input.user_id || 'unknown',
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

  // ── Phase 1: Frontend ──────────────────────────────────────────────────────
  debug('codeGenerationAgent:phase1', { projectId });
  let frontendFiles: Array<{ path: string; content: string }>;
  try {
    frontendFiles = await generateFrontendFiles(
      input.systemDesign,
      input.requirements,
      input.modification,
      llmProxy,
      model
    );
  } catch (err) {
    logError('codeGenerationAgent:phase1-failed', err);
    throw new Error(`Frontend code generation failed: ${(err as Error).message}`);
  }

  // ── Phase 2: Backend + DB (only if systemDesign has backend) ───────────────
  let backendFiles: Array<{ path: string; content: string }> = [];
  if (hasBackend) {
    debug('codeGenerationAgent:phase2', { projectId });
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
      logError('codeGenerationAgent:phase2-failed', err);
      throw new Error(`Backend code generation failed: ${(err as Error).message}`);
    }
  }

  // ── Merge: backend files overwrite frontend files of same path ─────────────
  const allFiles = filterAndNormalizeFiles([...frontendFiles, ...backendFiles]);

  // Validate
  const hasFrontendPkg = allFiles.some(f => f.path === 'package.json');
  if (!hasFrontendPkg) {
    logError('codeGenerationAgent:no-package-json', { fileCount: allFiles.length });
    throw new Error('Code generation produced no root package.json — cannot build frontend');
  }
  if (hasBackend) {
    const hasBackendPkg = allFiles.some(f => f.path === 'backend/package.json');
    if (!hasBackendPkg) {
      logWarn('codeGenerationAgent:no-backend-package-json', { fileCount: allFiles.length });
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
  };
}
