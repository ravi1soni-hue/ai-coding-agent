import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { debug } from '../utils/logger';

type BuildWorkerPayload = {
  workspaceRoot?: string;
  workspaceDir?: string;
};

type ValidationResult = { valid: boolean; errors: string[] };

type BuildWorkerResult = {
  success: boolean;
  logs: string;
  buildDir?: string;
  backendDir?: string;
};

function resolveWorkspaceRoot(payload: BuildWorkerPayload): string | undefined {
  return payload.workspaceRoot || payload.workspaceDir;
}

function assertInsideProjectsRoot(workspaceRoot: string): void {
  const projectsRoot = path.resolve(__dirname, '../../../projects');
  const normalizedRoot = path.resolve(workspaceRoot);
  const relative = path.relative(projectsRoot, normalizedRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside /projects: ${workspaceRoot}`);
  }
}

function assertInsideWorkspace(workspaceRoot: string, targetPath: string): void {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const normalizedTarget = path.resolve(targetPath);
  const relative = path.relative(normalizedWorkspace, normalizedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Blocked path outside workspaceRoot: ${targetPath}`);
  }
}

function logFileWritePath(filePath: string): void {
  console.log(`[buildWorker] fileWritePath=${filePath}`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateGeneratedProject(workspaceRoot: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const frontendDir = path.join(workspaceRoot, 'frontend');
  const backendDir = path.join(workspaceRoot, 'backend');

  const frontendRequired = ['package.json', 'index.html'];
  for (const fileName of frontendRequired) {
    if (!(await fileExists(path.join(frontendDir, fileName)))) {
      errors.push(`Missing required frontend file: frontend/${fileName}`);
    }
  }

  const entryCandidates = ['src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx'];
  let hasEntry = false;
  for (const entry of entryCandidates) {
    if (await fileExists(path.join(frontendDir, entry))) {
      hasEntry = true;
      break;
    }
  }
  if (!hasEntry) {
    errors.push(`Missing frontend entry file (expected one of: ${entryCandidates.join(', ')})`);
  }

  try {
    const raw = await fs.readFile(path.join(frontendDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (!pkg.scripts?.build) errors.push('Frontend package.json is missing scripts.build');
    if (!pkg.dependencies?.react && !pkg.devDependencies?.react) errors.push('Frontend package.json is missing react dependency');
  } catch {
    errors.push('Frontend package.json is not valid JSON');
  }

  if (await fileExists(path.join(backendDir, 'package.json'))) {
    if (!(await fileExists(path.join(backendDir, 'src', 'index.ts')))) {
      errors.push('Missing required backend file: backend/src/index.ts');
    }
    if (await fileExists(path.join(backendDir, 'index.js'))) {
      errors.push('Legacy backend/index.js detected; backend must be TypeScript-only');
    }
    if (!(await fileExists(path.join(backendDir, 'db', 'init.sql'))) && !(await fileExists(path.join(backendDir, 'db', 'schema.sql')))) {
      errors.push('Missing backend/db/init.sql (required for database initialization)');
    }
  }

  return { valid: errors.length === 0, errors };
}

async function cleanStaleDist(workspaceRoot: string): Promise<void> {
  const frontendDist = path.join(workspaceRoot, 'frontend', 'dist');
  const backendDist = path.join(workspaceRoot, 'backend', 'dist');
  await Promise.allSettled([
    fs.rm(frontendDist, { recursive: true, force: true }),
    fs.rm(backendDist, { recursive: true, force: true }),
  ]);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    console.log(`[buildWorker] cwd=${cwd}`);
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

async function hasTestScript(workspaceDir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf8');
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
    if (ciResult.code === 0) return ciResult;
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

async function testWorkspace(workspaceDir: string): Promise<{ code: number; output: string }> {
  return runCommand('npm', ['test', '--', '--watch=false'], workspaceDir, 5 * 60_000);
}

export async function runBuildWorker(payload: BuildWorkerPayload): Promise<BuildWorkerResult> {
  const workspaceRoot = resolveWorkspaceRoot(payload);
  if (!workspaceRoot) {
    return { success: false, logs: 'workspaceRoot is required for real build/test execution.' };
  }

  assertInsideProjectsRoot(workspaceRoot);

  const logs: string[] = [];
  logs.push(`[buildWorker] workspaceRoot=${workspaceRoot}`);

  const validation = await validateGeneratedProject(workspaceRoot);
  if (!validation.valid) {
    const errorList = validation.errors.map((error) => `  • ${error}`).join('\n');
    return {
      success: false,
      logs: `[buildWorker] Pre-build validation failed — missing required files:\n${errorList}\n\nFix the generated code to include these files before building.`,
    };
  }
  logs.push('[buildWorker] Pre-build validation passed');

  await cleanStaleDist(workspaceRoot);
  logs.push('[buildWorker] Cleaned stale dist/ (fresh build)');

  const frontendDir = path.join(workspaceRoot, 'frontend');
  const backendDir = path.join(workspaceRoot, 'backend');
  let frontendBuildDir: string | undefined;
  let backendWorkspaceDir: string | undefined;

  if (await fileExists(path.join(frontendDir, 'package.json'))) {
    logs.push(`[buildWorker] cwd=${frontendDir}`);
    logs.push(`[buildWorker] Installing frontend dependencies in ${frontendDir}`);
    const installResult = await installDependencies(frontendDir);
    logs.push('$ npm install (frontend)');
    logs.push(installResult.output.trim());
    if (installResult.code !== 0) return { success: false, logs: logs.join('\n\n') };

    const buildResult = await buildWorkspace(frontendDir);
    logs.push('$ npm run build (frontend)');
    logs.push(buildResult.output.trim());
    if (buildResult.code !== 0) return { success: false, logs: logs.join('\n\n') };

    if (await hasTestScript(frontendDir)) {
      const testResult = await testWorkspace(frontendDir);
      logs.push('$ npm test -- --watch=false (frontend)');
      logs.push(testResult.output.trim());
      if (testResult.code !== 0) return { success: false, logs: logs.join('\n\n') };
    }

    frontendBuildDir = path.join(frontendDir, 'dist');
    if (!(await fileExists(frontendBuildDir))) {
      return { success: false, logs: logs.join('\n\n') + '\n\nERROR: Frontend build succeeded but output directory does not exist: ' + frontendBuildDir };
    }
  } else {
    logs.push('No frontend package.json found. Skipping frontend build.');
  }

  if (await fileExists(path.join(backendDir, 'package.json'))) {
    logs.push(`[buildWorker] cwd=${backendDir}`);
    logs.push(`[buildWorker] Installing backend dependencies in ${backendDir}`);
    const installResult = await installDependencies(backendDir);
    logs.push('$ npm install (backend)');
    logs.push(installResult.output.trim());
    if (installResult.code !== 0) return { success: false, logs: logs.join('\n\n') };

    try {
      const raw = await fs.readFile(path.join(backendDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) {
        const buildResult = await buildWorkspace(backendDir);
        logs.push('$ npm run build (backend)');
        logs.push(buildResult.output.trim());
        if (buildResult.code !== 0) return { success: false, logs: logs.join('\n\n') };
      } else {
        logs.push('Backend package has no build script. Skipping backend build.');
      }
    } catch (err: any) {
      logs.push(`Unable to read backend package.json: ${err?.message || String(err)}`);
    }

    if (await hasTestScript(backendDir)) {
      const testResult = await testWorkspace(backendDir);
      logs.push('$ npm test -- --watch=false (backend)');
      logs.push(testResult.output.trim());
      if (testResult.code !== 0) return { success: false, logs: logs.join('\n\n') };
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

  if (!(await fileExists(frontendBuildDir))) {
    return { success: false, logs: logs.join('\n\n') + '\n\nERROR: Build directory does not exist: ' + frontendBuildDir };
  }

  return {
    success: true,
    logs: logs.join('\n\n'),
    buildDir: frontendBuildDir,
    backendDir: backendWorkspaceDir,
  };
}

export async function cleanupWorkspace(workspaceRoot: string): Promise<void> {
  try {
    assertInsideProjectsRoot(workspaceRoot);
    const normalizedRoot = path.resolve(workspaceRoot);
    await fs.rm(normalizedRoot, { recursive: true, force: true });
    console.log(`[buildWorker] Cleaned workspaceRoot=${normalizedRoot}`);
  } catch (err) {
    console.warn(`[buildWorker] Could not clean workspace: ${(err as any)?.message}`);
  }
}
