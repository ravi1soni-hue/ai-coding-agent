import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

type BuildWorkerPayload = {
  workspaceDir?: string;
};

type BuildWorkerResult = {
  success: boolean;
  logs: string;
  buildDir?: string;
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

export async function runBuildWorker(payload: BuildWorkerPayload): Promise<BuildWorkerResult> {
  const workspaceDir = payload.workspaceDir;
  if (!workspaceDir) {
    return { success: false, logs: 'workspaceDir is required for real build/test execution.' };
  }

  const logs: string[] = [];
  const lockPath = path.join(workspaceDir, 'package-lock.json');
  let installCommand = ['install', '--no-audit', '--no-fund'];
  try {
    await fs.access(lockPath);
    installCommand = ['ci', '--no-audit', '--no-fund'];
  } catch {
    installCommand = ['install', '--no-audit', '--no-fund'];
  }

  const installResult = await runCommand('npm', installCommand, workspaceDir, 5 * 60_000);
  logs.push(`$ npm ${installCommand.join(' ')}`);
  logs.push(installResult.output.trim());
  if (installResult.code !== 0) {
    return { success: false, logs: logs.join('\n\n') };
  }

  const buildResult = await runCommand('npm', ['run', 'build'], workspaceDir, 5 * 60_000);
  logs.push('$ npm run build');
  logs.push(buildResult.output.trim());
  if (buildResult.code !== 0) {
    return { success: false, logs: logs.join('\n\n') };
  }

  if (await hasTestScript(workspaceDir)) {
    const testResult = await runCommand('npm', ['test', '--', '--watch=false'], workspaceDir, 5 * 60_000);
    logs.push('$ npm test -- --watch=false');
    logs.push(testResult.output.trim());
    if (testResult.code !== 0) {
      return { success: false, logs: logs.join('\n\n') };
    }
  } else {
    logs.push('No test script found. Skipping test phase.');
  }

  return {
    success: true,
    logs: logs.join('\n\n'),
    buildDir: path.join(workspaceDir, 'dist'),
  };
}
