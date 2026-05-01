// Test & Fix Agent
import fs from 'fs/promises';
import path from 'path';
import { debug, warn as logWarn, error as logError } from '../utils/logger';


// Known third-party library versions for auto-remediation
const KNOWN_LIBRARY_VERSIONS: Record<string, string> = {
  'react-router-dom': '^6.20.0',
  'react-router': '^6.20.0',
  'redux': '^4.2.1',
  'react-redux': '^8.1.3',
  '@reduxjs/toolkit': '^1.9.7',
  'axios': '^1.6.0',
  'lodash': '^4.17.21',
  'underscore': '^1.13.6',
  'moment': '^2.29.4',
  'date-fns': '^2.30.0',
  'styled-components': '^6.1.0',
  '@emotion/react': '^11.11.1',
  '@emotion/styled': '^11.11.0',
  'tailwindcss': '^3.3.6',
};

// Node.js built-in modules — never need to be in package.json
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'events',
  'stream', 'buffer', 'crypto', 'child_process', 'cluster', 'net',
  'dns', 'readline', 'zlib', 'assert', 'tty', 'vm', 'module',
  'process', 'timers', 'string_decoder', 'querystring', 'punycode',
]);

/**
 * Scans generated JS/JSX/TS/TSX files for import/require statements,
 * compares them against the declared dependencies in package.json, and
 * adds any missing third-party libraries with sensible default versions.
 * Returns the (possibly updated) package.json content string.
 */
function validateAndFixPackageJson(files: GeneratedFile[]): string | null {
  const packageJsonFile = files.find(
    (f) => f.path === 'package.json' || f.path === '/package.json'
  );
  if (!packageJsonFile) return null;

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  try {
    pkg = JSON.parse(packageJsonFile.content);
  } catch {
    logWarn('testFixAgent:validateAndFixPackageJson', 'failed to parse package.json');
    return null;
  }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  const allDeclared = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);

  // Collect all imports from JS/JSX/TS/TSX source files
  const importedModules = new Set<string>();
  const es6ImportRe = /import\s+(?:{[^}]*}|[^from'"]*)\s+from\s+['"]([^'"]+)['"]/g;
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) continue;

    for (const re of [es6ImportRe, requireRe]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(file.content)) !== null) {
        const mod = match[1];
        // Skip relative imports and absolute paths
        if (mod.startsWith('.') || mod.startsWith('/')) continue;
        // Skip Node.js built-ins
        const rootPkg = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
        if (NODE_BUILTINS.has(rootPkg)) continue;
        importedModules.add(rootPkg);
      }
    }
  }

  // Identify missing dependencies
  const missing: Record<string, string> = {};
  for (const mod of importedModules) {
    if (!allDeclared.has(mod)) {
      const version = KNOWN_LIBRARY_VERSIONS[mod] ?? 'latest';
      missing[mod] = version;
    }
  }

  if (Object.keys(missing).length === 0) return null; // Nothing to fix

  debug('testFixAgent:validateAndFixPackageJson', { missing });

  pkg.dependencies = { ...deps, ...missing };
  return JSON.stringify(pkg, null, 2);
}

const DEFAULT_PUBLIC_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

type GeneratedFile = {
  path: string;
  content: string;
};

async function ensureReactPublicIndexHtml(
  files: GeneratedFile[],
  workspaceDir: string
): Promise<void> {
  // Determine if this is a React project by checking for a react dependency in package.json
  const packageJsonFile = files.find(
    (f) => f.path === 'package.json' || f.path === '/package.json'
  );
  if (!packageJsonFile) return;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJsonFile.content);
  } catch {
    return;
  }

  const hasReact =
    typeof pkg.dependencies?.['react'] === 'string' ||
    typeof pkg.devDependencies?.['react'] === 'string';
  if (!hasReact) return;

  // Check whether public/index.html is already present in the files array
  const normalise = (p: string) => p.replace(/^\/*/, '');
  const hasPublicIndexHtml = files.some(
    (f) => normalise(f.path) === 'public/index.html'
  );

  if (!hasPublicIndexHtml) {
    debug('testFixAgent:ensureReactPublicIndexHtml', 'React project is missing public/index.html — injecting default file.');
    const targetPath = path.join(workspaceDir, 'public', 'index.html');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, DEFAULT_PUBLIC_INDEX_HTML, 'utf8');
  }
}

export async function testFixAgent(input: {
  buildFn: () => Promise<{ success: boolean; logs: string }>;
  fixFn?: (logs: string) => Promise<void>;
  files?: GeneratedFile[];
  workspaceDir?: string;
}) {
  debug('testFixAgent', { workspaceDir: input.workspaceDir });

  // Pre-build validation: ensure React projects have public/index.html
  if (input.files && input.workspaceDir) {
    try {
      await ensureReactPublicIndexHtml(input.files, input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:pre-build-react-validation', err);
    }
  }

  // Pre-build validation: ensure all imported modules are declared in package.json
  if (input.files && input.workspaceDir) {
    try {
      const updatedPackageJson = validateAndFixPackageJson(input.files);
      if (updatedPackageJson !== null) {
        const packageJsonPath = path.join(input.workspaceDir, 'package.json');
        await fs.writeFile(packageJsonPath, updatedPackageJson, 'utf8');
        // Keep the in-memory files array in sync so subsequent reads are consistent
        const packageJsonFile = input.files.find(
          (f) => f.path === 'package.json' || f.path === '/package.json'
        );
        if (packageJsonFile) {
          packageJsonFile.content = updatedPackageJson;
        }
      }
    } catch (err) {
      logWarn('testFixAgent:package-json-validation', err);
    }
  }

  let retries = 0;
  let result: { success: boolean; logs: string } | undefined;
  try {
    do {
      debug('testFixAgent:attempt', { attempt: retries + 1 });
      result = await input.buildFn();
      debug('testFixAgent:buildFn-result', { result });
      if (result.success) {
        debug('testFixAgent:success', { fixed: retries > 0 });
        return { ...result, fixed: retries > 0 };
      }
      // Attempt LLM-based fix before retrying
      if (input.fixFn && retries < 2) {
        debug('testFixAgent:fix-attempt', { retry: retries + 1 });
        try {
          await input.fixFn(result.logs);
        } catch (fixErr) {
          logError('testFixAgent:fixFn', fixErr);
        }
      }
      retries++;
    } while (retries < 3);
    const lastLogs = result?.logs || 'No build output captured.';
    throw new Error(`Build failed after 3 attempts. Last error:\n${lastLogs.slice(-2000)}`);
  } catch (err) {
    logError('testFixAgent', err);
    throw err;
  }
}
