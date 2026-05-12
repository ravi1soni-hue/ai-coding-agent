import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { debug } from '../utils/logger';

export type ExecutionRunLogSink = (chunk: string) => void;

export type ExecutionRunRequest = {
  workspaceRoot?: string;
  workspaceDir?: string;
  /**
   * Log streaming sink. buildWorker will forward both stdout/stderr chunks.
   */
  onLog?: ExecutionRunLogSink;
  /** Epoch ms by which the entire build must finish. Used to cap per-command timeouts. */
  deadlineAt?: number;
};

export type ExecutionRunResponse = {
  success: boolean;
  logs: string;
  buildDir?: string;
  backendDir?: string;
};

type ValidationResult = { valid: boolean; errors: string[] };

// Backwards-compatible internal aliases
type BuildWorkerPayload = ExecutionRunRequest;
type BuildWorkerResult = ExecutionRunResponse;

const DOCKER_NODE_IMAGE = 'node:20-bookworm';
const MAX_CMD_TIMEOUT_MS = 5 * 60_000;
const MIN_CMD_TIMEOUT_MS = 30_000;

/** Compute a per-command timeout that respects the orchestration deadline. */
function deadlineMs(deadlineAt?: number): number {
  if (!deadlineAt) return MAX_CMD_TIMEOUT_MS;
  return Math.max(MIN_CMD_TIMEOUT_MS, Math.min(MAX_CMD_TIMEOUT_MS, deadlineAt - Date.now()));
}

function resolveWorkspaceRoot(payload: BuildWorkerPayload): string | undefined {
  return payload.workspaceRoot || payload.workspaceDir;
}

async function isDockerAvailable(timeoutMs: number): Promise<{ available: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ available: false, reason: `Timed out running "docker info" after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ available: false, reason: `Failed to spawn docker: ${String(err)}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ available: true });
      const hint = stderr.trim() || stdout.trim() || `exitCode=${code}`;
      resolve({ available: false, reason: `docker info failed: ${hint}` });
    });
  });
}

function assertInsideProjectsRoot(workspaceRoot: string): void {
  const projectsRoot = path.resolve('/tmp');
  const normalizedRoot = path.resolve(workspaceRoot);
  const relative = path.relative(projectsRoot, normalizedRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside /tmp: ${workspaceRoot}`);
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

// Runs a command directly on the host (no Docker). Used for npm install which needs
// network access to reach the npm registry — Docker's --network none would block it.
function runCommandOnHost(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLog?: (chunk: string) => void
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, output: `${output}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { const str = String(chunk); output += str; onLog?.(str); });
    child.stderr.on('data', (chunk) => { const str = String(chunk); output += str; onLog?.(str); });

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

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLog?: (chunk: string) => void
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // Phase 2 sandboxing: run build/test commands in a container.
    // We mount only the workspaceRoot (parent of cwd) into /workspace.
    // That blocks container access to other host filesystem paths.
    const workspaceRoot = path.resolve(cwd, '..');
    const mountRoot = workspaceRoot;

    // Ensure we still only operate under /tmp (defense in depth).
    assertInsideProjectsRoot(mountRoot);

    const rel = path.relative(workspaceRoot, cwd).replace(/\\/g, '/');
    const dockerWorkdir = rel ? `/workspace/${rel}` : '/workspace';

    const dockerArgs = [
      'run',
      '--rm',
      '--network',
      'none',
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      '--pids-limit',
      '256',
      '-v',
      `${mountRoot}:/workspace:rw`,
      '-w',
      dockerWorkdir,
      DOCKER_NODE_IMAGE,
      command,
      ...args,
    ];

    let output = '';
    console.log(`[buildWorker] docker cmd=${command} cwd=${cwd} workdir=${dockerWorkdir}`);

    const child = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, output: `${output}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const str = String(chunk);
      output += str;
      onLog?.(str);
    });
    child.stderr.on('data', (chunk) => {
      const str = String(chunk);
      output += str;
      onLog?.(str);
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

async function installDependencies(
  workspaceDir: string,
  onLog?: (chunk: string) => void,
  deadlineAt?: number
): Promise<{ code: number; output: string }> {
  const cmdTimeout = deadlineMs(deadlineAt);
  const lockPath = path.join(workspaceDir, 'package-lock.json');
  if (await fileExists(lockPath)) {
    const ciResult = await runCommandOnHost('npm', ['ci', '--no-audit', '--no-fund'], workspaceDir, cmdTimeout, onLog);
    if (ciResult.code === 0) return ciResult;
    const fallbackResult = await runCommandOnHost('npm', ['install', '--no-audit', '--no-fund'], workspaceDir, deadlineMs(deadlineAt), onLog);
    return {
      code: fallbackResult.code,
      output: `${ciResult.output.trim()}\n\n--- npm ci failed, falling back to npm install ---\n\n${fallbackResult.output.trim()}`,
    };
  }
  return runCommandOnHost('npm', ['install', '--no-audit', '--no-fund'], workspaceDir, cmdTimeout, onLog);
}

async function runFrontendTypeCheck(
  workspaceDir: string,
  onLog?: (chunk: string) => void,
  deadlineAt?: number,
  useDocker = true
): Promise<{ code: number; output: string }> {
  const runner = useDocker ? runCommand : runCommandOnHost;
  const packageJsonPath = path.join(workspaceDir, 'package.json');
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    if (pkg.scripts?.['type-check']) {
      return runner('npm', ['run', 'type-check'], workspaceDir, deadlineMs(deadlineAt), onLog);
    }
    const tsconfigPath = path.join(workspaceDir, 'tsconfig.json');
    if (await fileExists(tsconfigPath) || pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
      return runner('npx', ['tsc', '--noEmit'], workspaceDir, deadlineMs(deadlineAt), onLog);
    }
  } catch {
    // Fall back gracefully when package.json is missing or malformed.
  }
  return { code: 0, output: '' };
}

async function buildWorkspace(
  workspaceDir: string,
  onLog?: (chunk: string) => void,
  deadlineAt?: number,
  useDocker = true
): Promise<{ code: number; output: string }> {
  const runner = useDocker ? runCommand : runCommandOnHost;
  return runner('npm', ['run', 'build'], workspaceDir, deadlineMs(deadlineAt), onLog);
}

async function testWorkspace(
  workspaceDir: string,
  onLog?: (chunk: string) => void,
  deadlineAt?: number,
  useDocker = true
): Promise<{ code: number; output: string }> {
  const runner = useDocker ? runCommand : runCommandOnHost;
  return runner('npm', ['test', '--', '--watch=false'], workspaceDir, deadlineMs(deadlineAt), onLog);
}

export async function runBuildWorker(payload: BuildWorkerPayload): Promise<BuildWorkerResult> {
  const onLog = payload.onLog;
  const { deadlineAt } = payload;
  const workspaceRoot = resolveWorkspaceRoot(payload);
  if (!workspaceRoot) {
    return { success: false, logs: 'workspaceRoot is required for real build/test execution.' };
  }

  assertInsideProjectsRoot(workspaceRoot);

  const logs: string[] = [];
  logs.push(`[buildWorker] workspaceRoot=${workspaceRoot}`);

  // Prefer Docker sandboxing for build/test. Fall back to host execution when Docker
  // is unavailable (e.g. PaaS environments that disallow DinD). npm install always
  // runs on the host regardless, since it needs network access to the npm registry.
  const dockerCheck = await isDockerAvailable(7_500);
  const useDocker = dockerCheck.available;
  if (!useDocker) {
    logs.push(`[buildWorker] Docker unavailable (${dockerCheck.reason}); running build/test on host without sandbox.`);
  }

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
    const installResult = await installDependencies(frontendDir, onLog, deadlineAt);
    logs.push('$ npm install (frontend)');
    logs.push(installResult.output.trim());
    if (installResult.code !== 0) return { success: false, logs: logs.join('\n\n') };

    const typeCheckResult = await runFrontendTypeCheck(frontendDir, onLog, deadlineAt, useDocker);
    if (typeCheckResult.code !== 0) {
      logs.push('$ npm run type-check (frontend)');
      logs.push(typeCheckResult.output.trim());
      return { success: false, logs: logs.join('\n\n') };
    }

    const buildResult = await buildWorkspace(frontendDir, onLog, deadlineAt, useDocker);
    logs.push('$ npm run build (frontend)');
    logs.push(buildResult.output.trim());
    if (buildResult.code !== 0) return { success: false, logs: logs.join('\n\n') };

    if (await hasTestScript(frontendDir)) {
      const testResult = await testWorkspace(frontendDir, onLog, deadlineAt, useDocker);
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
    const installResult = await installDependencies(backendDir, onLog, deadlineAt);
    logs.push('$ npm install (backend)');
    logs.push(installResult.output.trim());
    if (installResult.code !== 0) return { success: false, logs: logs.join('\n\n') };

    try {
      const raw = await fs.readFile(path.join(backendDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) {
        const buildResult = await buildWorkspace(backendDir, onLog, deadlineAt, useDocker);
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
      const testResult = await testWorkspace(backendDir, onLog, deadlineAt, useDocker);
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
