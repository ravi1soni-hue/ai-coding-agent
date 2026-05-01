"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testFixAgent = testFixAgent;
// Test & Fix Agent
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../utils/logger");
// Known third-party library versions for auto-remediation
const KNOWN_LIBRARY_VERSIONS = {
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
function validateAndFixPackageJson(files) {
    const packageJsonFile = files.find((f) => f.path === 'package.json' || f.path === '/package.json');
    if (!packageJsonFile)
        return null;
    let pkg;
    try {
        pkg = JSON.parse(packageJsonFile.content);
    }
    catch {
        (0, logger_1.warn)('testFixAgent:validateAndFixPackageJson', 'failed to parse package.json');
        return null;
    }
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};
    const allDeclared = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);
    // Collect all imports from JS/JSX/TS/TSX source files
    const importedModules = new Set();
    const es6ImportRe = /import\s+(?:{[^}]*}|[^from'"]*)\s+from\s+['"]([^'"]+)['"]/g;
    const requireRe = /require\(['"]([^'"]+)['"]\)/g;
    for (const file of files) {
        const ext = path_1.default.extname(file.path).toLowerCase();
        if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext))
            continue;
        for (const re of [es6ImportRe, requireRe]) {
            re.lastIndex = 0;
            let match;
            while ((match = re.exec(file.content)) !== null) {
                const mod = match[1];
                // Skip relative imports and absolute paths
                if (mod.startsWith('.') || mod.startsWith('/'))
                    continue;
                // Skip Node.js built-ins
                const rootPkg = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
                if (NODE_BUILTINS.has(rootPkg))
                    continue;
                importedModules.add(rootPkg);
            }
        }
    }
    // Identify missing dependencies
    const missing = {};
    for (const mod of importedModules) {
        if (!allDeclared.has(mod)) {
            const version = KNOWN_LIBRARY_VERSIONS[mod] ?? 'latest';
            missing[mod] = version;
        }
    }
    if (Object.keys(missing).length === 0)
        return null; // Nothing to fix
    (0, logger_1.debug)('testFixAgent:validateAndFixPackageJson', { missing });
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
async function ensureReactPublicIndexHtml(files, workspaceDir) {
    // Determine if this is a React project by checking for a react dependency in package.json
    const packageJsonFile = files.find((f) => f.path === 'package.json' || f.path === '/package.json');
    if (!packageJsonFile)
        return;
    let pkg;
    try {
        pkg = JSON.parse(packageJsonFile.content);
    }
    catch {
        return;
    }
    const hasReact = typeof pkg.dependencies?.['react'] === 'string' ||
        typeof pkg.devDependencies?.['react'] === 'string';
    if (!hasReact)
        return;
    // Check whether public/index.html is already present in the files array
    const normalise = (p) => p.replace(/^\/*/, '');
    const hasPublicIndexHtml = files.some((f) => normalise(f.path) === 'public/index.html');
    if (!hasPublicIndexHtml) {
        (0, logger_1.debug)('testFixAgent:ensureReactPublicIndexHtml', 'React project is missing public/index.html — injecting default file.');
        const targetPath = path_1.default.join(workspaceDir, 'public', 'index.html');
        await promises_1.default.mkdir(path_1.default.dirname(targetPath), { recursive: true });
        await promises_1.default.writeFile(targetPath, DEFAULT_PUBLIC_INDEX_HTML, 'utf8');
    }
}
async function testFixAgent(input) {
    (0, logger_1.debug)('testFixAgent', { workspaceDir: input.workspaceDir });
    // Pre-build validation: ensure React projects have public/index.html
    if (input.files && input.workspaceDir) {
        try {
            await ensureReactPublicIndexHtml(input.files, input.workspaceDir);
        }
        catch (err) {
            (0, logger_1.warn)('testFixAgent:pre-build-react-validation', err);
        }
    }
    // Pre-build validation: ensure all imported modules are declared in package.json
    if (input.files && input.workspaceDir) {
        try {
            const updatedPackageJson = validateAndFixPackageJson(input.files);
            if (updatedPackageJson !== null) {
                const packageJsonPath = path_1.default.join(input.workspaceDir, 'package.json');
                await promises_1.default.writeFile(packageJsonPath, updatedPackageJson, 'utf8');
                // Keep the in-memory files array in sync so subsequent reads are consistent
                const packageJsonFile = input.files.find((f) => f.path === 'package.json' || f.path === '/package.json');
                if (packageJsonFile) {
                    packageJsonFile.content = updatedPackageJson;
                }
            }
        }
        catch (err) {
            (0, logger_1.warn)('testFixAgent:package-json-validation', err);
        }
    }
    let retries = 0;
    let result;
    try {
        do {
            (0, logger_1.debug)('testFixAgent:attempt', { attempt: retries + 1 });
            result = await input.buildFn();
            (0, logger_1.debug)('testFixAgent:buildFn-result', { result });
            if (result.success) {
                (0, logger_1.debug)('testFixAgent:success', { fixed: retries > 0 });
                return { ...result, fixed: retries > 0 };
            }
            // Attempt LLM-based fix before retrying
            if (input.fixFn && retries < 2) {
                (0, logger_1.debug)('testFixAgent:fix-attempt', { retry: retries + 1 });
                try {
                    await input.fixFn(result.logs);
                }
                catch (fixErr) {
                    (0, logger_1.error)('testFixAgent:fixFn', fixErr);
                }
            }
            retries++;
        } while (retries < 3);
        const lastLogs = result?.logs || 'No build output captured.';
        throw new Error(`Build failed after 3 attempts. Last error:\n${lastLogs.slice(-2000)}`);
    }
    catch (err) {
        (0, logger_1.error)('testFixAgent', err);
        throw err;
    }
}
