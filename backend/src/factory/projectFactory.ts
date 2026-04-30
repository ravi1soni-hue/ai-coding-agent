import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

export type MaterializedRevision = {
  revisionId: string;
  workspaceDir: string;
  archivePath: string;
  sourceHash: string;
  patchPath: string;
  patchApplied: boolean;
  patchApplyLog: string;
};

type GeneratedFile = {
  path: string;
  content: string;
};

type MaterializeInput = {
  projectId: string;
  codeGen: any;
};

const WORKSPACE_ROOT = path.resolve(__dirname, '../../generated-projects');
const FRONTEND_TEMPLATE_DIR = path.resolve(__dirname, '../../../frontend');

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'project';
}

function extractGeneratedFiles(codeGen: any): GeneratedFile[] {
  const candidates: unknown[] = [codeGen?.files, codeGen?.generatedFiles];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const files: GeneratedFile[] = [];
    for (const item of candidate) {
      const filePath = (item as any)?.path;
      const content = (item as any)?.content;
      if (typeof filePath === 'string' && typeof content === 'string') {
        files.push({ path: filePath, content });
      }
    }
    if (files.length > 0) return files;
  }
  return [];
}

async function copyDir(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
      continue;
    }
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
      continue;
    }
    await fs.copyFile(srcPath, destPath);
  }
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`, exitCode: 124 });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${String(err)}`, exitCode: 1 });
    });
  });
}

async function hashDirectory(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const content = await fs.readFile(fullPath);
        hash.update(relativePath);
        hash.update(content);
      }
    }
  }

  await walk(rootDir);
  return hash.digest('hex');
}

export async function materializeProjectWorkspace(input: MaterializeInput): Promise<MaterializedRevision> {
  const projectSegment = sanitizeSegment(input.projectId);
  const revisionId = crypto.randomUUID();
  const workspaceDir = path.join(WORKSPACE_ROOT, projectSegment, revisionId);

  await fs.mkdir(workspaceDir, { recursive: true });
  await copyDir(FRONTEND_TEMPLATE_DIR, workspaceDir);

  const generatedFiles = extractGeneratedFiles(input.codeGen);
  for (const file of generatedFiles) {
    const normalized = file.path.replace(/^\/+/, '');
    const target = path.resolve(workspaceDir, normalized);
    if (!target.startsWith(workspaceDir)) {
      throw new Error(`Invalid generated file path: ${file.path}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }

  const patchText = typeof input.codeGen?.patch === 'string' ? input.codeGen.patch : '';
  const patchPath = path.join(workspaceDir, 'GENERATED_PATCH.diff');
  await fs.writeFile(patchPath, patchText || '# No patch generated for this revision\n', 'utf8');

  let patchApplied = false;
  let patchApplyLog = 'No patch provided.';
  if (patchText.trim()) {
    await runCommand('git', ['init'], workspaceDir, 20_000);
    const apply = await runCommand('git', ['apply', '--whitespace=nowarn', 'GENERATED_PATCH.diff'], workspaceDir, 20_000);
    patchApplied = apply.exitCode === 0;
    patchApplyLog = `${apply.stdout}\n${apply.stderr}`.trim();
  }

  const archivePath = path.join(workspaceDir, 'source.tgz');
  const tar = await runCommand('tar', ['-czf', 'source.tgz', '.'], workspaceDir, 30_000);
  if (tar.exitCode !== 0) {
    throw new Error(`Failed to archive generated source: ${tar.stderr || tar.stdout}`);
  }

  const sourceHash = await hashDirectory(workspaceDir);

  return {
    revisionId,
    workspaceDir,
    archivePath,
    sourceHash,
    patchPath,
    patchApplied,
    patchApplyLog,
  };
}
