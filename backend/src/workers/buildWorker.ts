import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

type BuildWorkerPayload = {
  workspaceDir?: string;
};

// ---------------------------------------------------------------------------
// Pre-build validation — catches missing required files before npm install
// ---------------------------------------------------------------------------

type ValidationResult = { valid: boolean; errors: string[] };

async function validateGeneratedProject(workspaceDir: string): Promise<ValidationResult> {
  const errors: string[] = [];

  // Frontend required files
  const frontendRequired = ['package.json', 'index.html'];
  for (const f of frontendRequired) {
    if (!await fileExists(path.join(workspaceDir, f))) {
      errors.push(`Missing required frontend file: ${f}`);
    }
  }

  // Frontend must have at least one entry source file
  const entryCandidates = ['src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx'];
  let hasEntry = false;
  for (const e of entryCandidates) {
    if (await fileExists(path.join(workspaceDir, e))) { hasEntry = true; break; }
  }
  if (!hasEntry) {
    errors.push(`Missing frontend entry file (expected one of: ${entryCandidates.join(', ')})`);
  }

  // Validate frontend package.json has required scripts
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (!pkg.scripts?.build) errors.push('Frontend package.json is missing scripts.build');
    if (!pkg.dependencies?.react && !pkg.devDependencies?.react) errors.push('Frontend package.json is missing react dependency');
  } catch {
    errors.push('Frontend package.json is not valid JSON');
  }

  // Backend validation (only if backend/package.json exists)
  const backendDir = path.join(workspaceDir, 'backend');
  if (await fileExists(path.join(backendDir, 'package.json'))) {
    const backendRequired = ['index.js'];
    for (const f of backendRequired) {
      if (!await fileExists(path.join(backendDir, f))) {
        errors.push(`Missing required backend file: backend/${f}`);
      }
    }
    if (!await fileExists(path.join(backendDir, 'db', 'init.sql')) &&
        !await fileExists(path.join(backendDir, 'db', 'schema.sql'))) {
      errors.push('Missing backend/db/init.sql (required for database initialization)');
    }
  }

  return { valid: errors.length === 0, errors };
}

// Removes stale dist/ directories before a fresh build.
async function cleanStaleDist(workspaceDir: string): Promise<void> {
  const frontendDist = path.join(workspaceDir, 'dist');
  const backendDist = path.join(workspaceDir, 'backend', 'dist');
  await Promise.allSettled([
    fs.rm(frontendDist, { recursive: true, force: true }),
    fs.rm(backendDist, { recursive: true, force: true }),
  ]);
}

type BuildWorkerResult = {
  success: boolean;
  logs: string;
  buildDir?: string;
  backendDir?: string;
};

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, output: `${output}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : 1, output });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `${output}\n${String(err)}` });
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasTestScript(workspaceDir: string): Promise<boolean> {
  try {
    const packageJsonPath = path.join(workspaceDir, 'package.json');
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const testScript = pkg.scripts?.test;
    if (!testScript) return false;
    return !testScript.includes('no test specified');
  } catch {
    return false;
  }
}

async function installDependencies(workspaceDir: string): Promise<{ code: number; output: string }> {
  const lockPath = path.join(workspaceDir, 'package-lock.json');
  if (await fileExists(lockPath)) {
    const ciResult = await runCommand('npm', ['ci', '--no-audit', '--no-fund'], workspaceDir, 5 * 60_000);
    if (ciResult.code === 0) {
      return ciResult;
    }
    const fallbackResult = await runCommand('npm', ['install', '--no-audit', '--no-fund'], workspaceDir, 5 * 60_000);
    return {
      code: fallbackResult.code,
      output: `${ciResult.output.trim()}\n\n--- npm ci failed, falling back to npm install ---\n\n${fallbackResult.output.trim()}`,
    };
  }

  return runCommand('npm', ['install', '--no-audit', '--no-fund'], workspaceDir, 5 * 60_000);
}

async function buildWorkspace(workspaceDir: string): Promise<{ code: number; output: string }> {
  return runCommand('npm', ['run', 'build'], workspaceDir, 5 * 60_000);
}

export async function runBuildWorker(payload: BuildWorkerPayload): Promise<BuildWorkerResult> {
  const workspaceDir = payload.workspaceDir;
  if (!workspaceDir) {
    return { success: false, logs: 'workspaceDir is required for real build/test execution.' };
  }

  const logs: string[] = [];

  // ── Pre-build: validate required files exist ─────────────────────────────
  const validation = await validateGeneratedProject(workspaceDir);
  if (!validation.valid) {
    const errorList = validation.errors.map(e => `  • ${e}`).join('\n');
    return {
      success: false,
      logs: `[buildWorker] Pre-build validation failed — missing required files:\n${errorList}\n\nFix the generated code to include these files before building.`,
    };
  }
  logs.push('[buildWorker] Pre-build validation passed');

  // ── Pre-build: clean stale dist/ before fresh build ──────────────────────
  await cleanStaleDist(workspaceDir);
  logs.push('[buildWorker] Cleaned stale dist/ (fresh build)');

  const frontendDir = workspaceDir;
  const backendDir = path.join(workspaceDir, 'backend');
  let frontendBuildDir: string | undefined;
  let backendWorkspaceDir: string | undefined;

  if (await fileExists(path.join(frontendDir, 'package.json'))) {
    logs.push(`[buildWorker] Installing frontend dependencies in ${frontendDir}`);
    const installResult = await installDependencies(frontendDir);
    logs.push(`$ npm install (frontend)`);
    logs.push(installResult.output.trim());
    if (installResult.code !== 0) {
      return { success: false, logs: logs.join('\n\n') };
    }

    const buildResult = await buildWorkspace(frontendDir);
    logs.push('$ npm run build (frontend)');
    logs.push(buildResult.output.trim());
    if (buildResult.code !== 0) {
      return { success: false, logs: logs.join('\n\n') };
    }

    const hasFrontendTest = await hasTestScript(frontendDir);
    if (hasFrontendTest) {
      const testResult = await runCommand('npm', ['test', '--', '--watch=false'], frontendDir, 5 * 60_000);
      logs.push('$ npm test -- --watch=false (frontend)');
      logs.push(testResult.output.trim());
      if (testResult.code !== 0) {
        return { success: false, logs: logs.join('\n\n') };
      }
    }

    frontendBuildDir = path.join(frontendDir, 'dist');

    // Verify the build output directory actually exists
    if (!await fileExists(frontendBuildDir)) {
      return { success: false, logs: logs.join('\n\n') + '\n\nERROR: Frontend build succeeded but output directory does not exist: ' + frontendBuildDir };
    }
  } else {
    logs.push('No frontend package.json found. Skipping frontend build.');
  }

  if (await fileExists(path.join(backendDir, 'package.json'))) {
    logs.push(`[buildWorker] Installing backend dependencies in ${backendDir}`);
    const installResult = await installDependencies(backendDir);
    logs.push('$ npm install (backend)');
    logs.push(installResult.output.trim());
    if (installResult.code !== 0) {
      return { success: false, logs: logs.join('\n\n') };
    }

    const buildJsonPath = path.join(backendDir, 'package.json');
    try {
      const raw = await fs.readFile(buildJsonPath, 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) {
        const buildResult = await buildWorkspace(backendDir);
        logs.push('$ npm run build (backend)');
        logs.push(buildResult.output.trim());
        if (buildResult.code !== 0) {
          return { success: false, logs: logs.join('\n\n') };
        }
      } else {
        logs.push('Backend package has no build script. Skipping backend build.');
      }
    } catch (err: any) {
      logs.push(`Unable to read backend package.json: ${err?.message || String(err)}`);
    }

    if (await hasTestScript(backendDir)) {
      const testResult = await runCommand('npm', ['test', '--', '--watch=false'], backendDir, 5 * 60_000);
      logs.push('$ npm test -- --watch=false (backend)');
      logs.push(testResult.output.trim());
      if (testResult.code !== 0) {
        return { success: false, logs: logs.join('\n\n') };
      }
    } else {
      logs.push('No backend test script found. Skipping backend test phase.');
    }

    backendWorkspaceDir = backendDir;
  } else {
    logs.push('No backend package.json found. Skipping backend install/build.');
  }

  if (!frontendBuildDir) {
    return { success: false, logs: 'Frontend build output not available. Ensure generated frontend code exists and can build.' };
  }

  // Verify the build directory actually exists before returning
  if (!await fileExists(frontendBuildDir)) {
    return { success: false, logs: logs.join('\n\n') + '\n\nERROR: Build directory does not exist: ' + frontendBuildDir };
  }

  return {
    success: true,
    logs: logs.join('\n\n'),
    buildDir: frontendBuildDir,
    backendDir: backendWorkspaceDir,
  };
}

// Clean up node_modules from workspace to free disk after a successful build.
// Called after the built dist/ is no longer needed on disk (post-deploy).
export async function cleanupWorkspace(workspaceDir: string): Promise<void> {
  try {
    const nodeModulesPath = path.join(workspaceDir, 'node_modules');
    await fs.rm(nodeModulesPath, { recursive: true, force: true });
    const backendModulesPath = path.join(workspaceDir, 'backend', 'node_modules');
    await fs.rm(backendModulesPath, { recursive: true, force: true });
    console.log(`[buildWorker] Cleaned up node_modules at ${nodeModulesPath} and ${backendModulesPath}`);
  } catch (err) {
    console.warn(`[buildWorker] Could not clean up node_modules: ${(err as any)?.message}`);
  }
}
