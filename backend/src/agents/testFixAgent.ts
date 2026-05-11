// Test & Fix Agent
import fs from 'fs/promises';
import path from 'path';
import { debug, warn as logWarn, error as logError } from '../utils/logger';
import { config as envConfig } from '../config/env';

// Known third-party library versions for auto-remediation
const KNOWN_LIBRARY_VERSIONS: Record<string, string> = {
  // Frontend
  'react-router-dom': '^6.20.0',
  'react-router': '^6.20.0',
  'redux': '^4.2.1',
  'react-redux': '^8.1.3',
  '@reduxjs/toolkit': '^1.9.7',
  'axios': '^1.6.0',
  'lodash': '^4.17.21',
  'moment': '^2.29.4',
  'date-fns': '^2.30.0',
  'styled-components': '^6.1.0',
  '@emotion/react': '^11.11.1',
  '@emotion/styled': '^11.11.0',
  'tailwindcss': '^3.3.6',
  'framer-motion': '^10.16.0',
  'react-icons': '^4.12.0',
  'react-hook-form': '^7.48.0',
  'react-query': '^3.39.3',
  '@tanstack/react-query': '^5.0.0',
  'zustand': '^4.4.0',
  'clsx': '^2.0.0',
  // Backend
  'express': '^4.19.0',
  'cors': '^2.8.5',
  'pg': '^8.20.0',
  'dotenv': '^16.0.0',
  'jsonwebtoken': '^9.0.0',
  'bcryptjs': '^2.4.3',
  'multer': '^1.4.5',
  'helmet': '^7.0.0',
  'morgan': '^1.10.0',
};

// Node.js built-in modules — never need to be in package.json
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'events',
  'stream', 'buffer', 'crypto', 'child_process', 'cluster', 'net',
  'dns', 'readline', 'zlib', 'assert', 'tty', 'vm', 'module',
  'process', 'timers', 'string_decoder', 'querystring', 'punycode',
  'worker_threads', 'perf_hooks', 'v8', 'inspector',
]);

type GeneratedFile = { path: string; content: string };

/**
 * Scans all JS/TS files for imports, adds any missing packages to package.json.
 * Returns updated package.json content or null if nothing changed.
 */
function validateAndFixPackageJson(files: GeneratedFile[], pkgPath: 'package.json' | 'backend/package.json'): string | null {
  const packageJsonFile = files.find(f => f.path === pkgPath);
  if (!packageJsonFile) return null;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; [k: string]: unknown };
  try { pkg = JSON.parse(packageJsonFile.content); }
  catch { logWarn('testFixAgent:validateAndFixPackageJson', 'failed to parse ' + pkgPath); return null; }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  const allDeclared = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);

  const importedModules = new Set<string>();
  const es6Re = /import\s+(?:{[^}]*}|[^from'"]*)\s+from\s+['"]([^'"]+)['"]/g;
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;

  const prefix = pkgPath === 'backend/package.json' ? 'backend/' : '';
  for (const file of files) {
    // Only scan files in the right scope
    if (prefix && !file.path.startsWith(prefix)) continue;
    if (!prefix && file.path.startsWith('backend/')) continue;

    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) continue;

    for (const re of [es6Re, requireRe]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(file.content)) !== null) {
        const mod = match[1];
        if (mod.startsWith('.') || mod.startsWith('/')) continue;
        const rootPkg = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
        if (NODE_BUILTINS.has(rootPkg)) continue;
        importedModules.add(rootPkg);
      }
    }
  }

  const missing: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const mod of importedModules) {
    if (!allDeclared.has(mod)) {
      missing[mod] = KNOWN_LIBRARY_VERSIONS[mod] ?? 'latest';
    } else {
      // Check for version conflicts
      const existingVersion = deps[mod] || devDeps[mod];
      const expectedVersion = KNOWN_LIBRARY_VERSIONS[mod];
      if (expectedVersion && existingVersion !== expectedVersion && !existingVersion.includes('^') && !existingVersion.includes('~')) {
        conflicts.push(`${mod}: existing ${existingVersion}, expected ${expectedVersion}`);
      }
    }
  }

  if (conflicts.length > 0) {
    logWarn('testFixAgent:dependencyConflicts', { pkgPath, conflicts });
  }

  if (Object.keys(missing).length === 0) return null;
  debug('testFixAgent:missingDeps', { pkgPath, missing });
  pkg.dependencies = { ...deps, ...missing };
  return JSON.stringify(pkg, null, 2);
}

/**
 * Ensures Vite's root index.html exists (NOT public/index.html — that's CRA).
 * Vite requires index.html at the workspace root with a module script entry.
 */
async function ensureViteIndexHtml(files: GeneratedFile[], workspaceDir: string): Promise<void> {
  const packageJsonFile = files.find(f => f.path === 'package.json');
  if (!packageJsonFile) return;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  try { pkg = JSON.parse(packageJsonFile.content); }
  catch { return; }

  // Detect Vite projects by devDependencies or build script
  const isVite = Boolean(
    pkg.devDependencies?.['vite'] ||
    pkg.dependencies?.['vite'] ||
    pkg.scripts?.['build']?.includes('vite')
  );
  if (!isVite) return;

  // For Vite: index.html goes at ROOT, not public/
  const normalise = (p: string) => p.replace(/^\/+/, '');
  const hasRootIndexHtml = files.some(f => normalise(f.path) === 'index.html');

  if (!hasRootIndexHtml) {
    debug('testFixAgent:ensureViteIndexHtml', 'Vite project missing root index.html — injecting default');
    const entryFile = files.find(f =>
      normalise(f.path) === 'src/main.jsx' ||
      normalise(f.path) === 'src/main.tsx' ||
      normalise(f.path) === 'src/index.jsx' ||
      normalise(f.path) === 'src/index.tsx'
    );
    const entryPath = entryFile ? `/${entryFile.path.replace(/^\/+/, '')}` : '/src/main.jsx';

    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entryPath}"></script>
  </body>
</html>
`;
    await fs.mkdir(path.join(workspaceDir, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'frontend', 'index.html'), html, 'utf8');
  }

  // Remove public/index.html if it exists (Vite doesn't need it and it can cause confusion)
  try {
    await fs.rm(path.join(workspaceDir, 'frontend', 'public', 'index.html'), { force: true });
  } catch {}
}

/**
 * Writes .env and .env.production with VITE_API_BASE_URL so the frontend
 * build can resolve the Railway backend URL at build time.
 */
async function writeViteEnvFile(workspaceDir: string): Promise<void> {
  const rawUrl = envConfig.RAILWAY_PUBLIC_URL || '';
  if (!rawUrl) return;
  const backendUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  const envContent = `VITE_API_BASE_URL=${backendUrl}\n`;
  try {
    const frontendDir = path.join(workspaceDir, 'frontend');
    await fs.mkdir(frontendDir, { recursive: true });
    await fs.writeFile(path.join(frontendDir, '.env'), envContent, 'utf8');
    await fs.writeFile(path.join(frontendDir, '.env.production'), envContent, 'utf8');
    debug('testFixAgent:writeViteEnvFile', { backendUrl });
  } catch (err) {
    logWarn('testFixAgent:writeViteEnvFile', err);
  }
}

/**
 * Ensures backend/db/init.sql exists if backend has a database section.
 */
async function ensureDbInitSql(files: GeneratedFile[], workspaceDir: string): Promise<void> {
  const backendPkg = files.find(f => f.path === 'backend/package.json');
  if (!backendPkg) return;

  const hasInitSql = files.some(f => f.path === 'backend/db/init.sql' || f.path === 'backend/db/schema.sql');
  if (!hasInitSql) {
    debug('testFixAgent:ensureDbInitSql', 'backend missing db/init.sql — injecting empty placeholder');
    const dbDir = path.join(workspaceDir, 'backend', 'db');
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(
      path.join(dbDir, 'init.sql'),
      '-- Database initialization SQL\n-- Tables are created by the backend on startup\n',
      'utf8'
    );
  }
}

export async function testFixAgent(input: {
  buildFn: () => Promise<{ success: boolean; logs: string }>;
  fixFn?: (logs: string) => Promise<void>;
  files?: GeneratedFile[];
  workspaceDir?: string;
  projectId?: string;
  emitInfo?: (message: string) => void;
}) {
  debug('testFixAgent:start', { workspaceDir: input.workspaceDir, projectId: input.projectId });
  const info = (msg: string) => { try { input.emitInfo?.(msg); } catch { /* best-effort */ } };
  info('Preparing build workspace...');

  // ── Pre-build: write VITE_API_BASE_URL to .env / .env.production ──────────
  if (input.workspaceDir) {
    try {
      await writeViteEnvFile(input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:vite-env-write', err);
    }
  }

  // ── Pre-build: ensure Vite index.html at root (not public/) ──────────────
  if (input.files && input.workspaceDir) {
    try {
      await ensureViteIndexHtml(input.files, input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:vite-index-check', err);
    }
  }

  // ── Pre-build: ensure backend db/init.sql exists ─────────────────────────
  if (input.files && input.workspaceDir) {
    try {
      await ensureDbInitSql(input.files, input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:db-init-sql-check', err);
    }
  }

  // ── Pre-build: add missing dependencies to frontend package.json ──────────
  if (input.files && input.workspaceDir) {
    try {
      const updatedPkg = validateAndFixPackageJson(input.files, 'package.json');
      if (updatedPkg) {
        await fs.mkdir(path.join(input.workspaceDir, 'frontend'), { recursive: true });
        await fs.writeFile(path.join(input.workspaceDir, 'frontend', 'package.json'), updatedPkg, 'utf8');
        const inMem = input.files.find(f => f.path === 'package.json');
        if (inMem) inMem.content = updatedPkg;
      }
    } catch (err) {
      logWarn('testFixAgent:frontend-pkg-fix', err);
    }
  }

  // ── Pre-build: add missing dependencies to backend package.json ──────────
  if (input.files && input.workspaceDir) {
    const hasBackend = input.files.some(f => f.path === 'backend/package.json');
    if (hasBackend) {
      try {
        const updatedPkg = validateAndFixPackageJson(input.files, 'backend/package.json');
        if (updatedPkg) {
          await fs.writeFile(path.join(input.workspaceDir, 'backend', 'package.json'), updatedPkg, 'utf8');
          const inMem = input.files.find(f => f.path === 'backend/package.json');
          if (inMem) inMem.content = updatedPkg;
        }
      } catch (err) {
        logWarn('testFixAgent:backend-pkg-fix', err);
      }
    }
  }

  // ── Build loop: up to 3 attempts with AI fix between each ─────────────────
  let retries = 0;
  let lastResult: { success: boolean; logs: string } | undefined;

  try {
    do {
      info(`Build attempt ${retries + 1} of 3 — running npm install and build (this can take a few minutes)...`);
      debug('testFixAgent:attempt', { attempt: retries + 1 });
      lastResult = await input.buildFn();
      debug('testFixAgent:buildResult', { success: lastResult.success });

      if (lastResult.success) {
        info(retries > 0 ? `Build succeeded after ${retries + 1} attempt(s).` : 'Build succeeded.');
        debug('testFixAgent:success', { fixed: retries > 0 });
        return { ...lastResult, fixed: retries > 0 };
      }

      if (input.fixFn && retries < 2) {
        info(`Build failed — invoking AI self-heal (attempt ${retries + 1})...`);
        debug('testFixAgent:invoking-fixFn', { retry: retries + 1 });
        try {
          await input.fixFn(lastResult.logs);
        } catch (fixErr) {
          logError('testFixAgent:fixFn-error', fixErr);
        }
      }
      retries++;
    } while (retries < 3);

    const lastLogs = lastResult?.logs || 'No build output.';
    throw new Error(`Build failed after 3 attempts.\n${lastLogs.slice(-2000)}`);
  } catch (err) {
    logError('testFixAgent', err);
    throw err;
  }
}
