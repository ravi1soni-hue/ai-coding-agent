import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { debug, error as logError } from '../utils/logger';

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

const PROJECTS_ROOT = path.resolve(__dirname, '../../../projects');
const TEMPLATE_ROOT = path.resolve(__dirname, '../../../templates/fullstack-starter');
const FALLBACK_FRONTEND_TEMPLATE_DIR = path.resolve(__dirname, '../templates/frontend');
const FALLBACK_BACKEND_TEMPLATE_DIR = path.resolve(__dirname, '../templates/backend');

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'project';
}

function assertInsideWorkspace(workspaceRoot: string, targetPath: string): void {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const normalizedTarget = path.resolve(targetPath);
  const relative = path.relative(normalizedWorkspace, normalizedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Blocked path outside workspaceRoot: ${targetPath}`);
  }
}

function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    normalized.includes('..') ||
    normalized.startsWith('backend') && normalized === 'backend' ||
    normalized.startsWith('frontend') && normalized === 'frontend' ||
    normalized.startsWith('templates')
  ) {
    throw new Error(`Blocked generated path: ${relativePath}`);
  }
  const target = path.resolve(workspaceRoot, normalized);
  assertInsideWorkspace(workspaceRoot, target);
  return target;
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
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function materializeTemplate(workspaceRoot: string): Promise<void> {
  if (await exists(TEMPLATE_ROOT)) {
    await copyDir(TEMPLATE_ROOT, workspaceRoot);
    return;
  }
  await copyDir(FALLBACK_FRONTEND_TEMPLATE_DIR, path.join(workspaceRoot, 'frontend'));
  await copyDir(FALLBACK_BACKEND_TEMPLATE_DIR, path.join(workspaceRoot, 'backend'));
}

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    debug('materializeProjectWorkspace:cwd', { cmd, cwd, args });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`, exitCode: 124 });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}\n${String(err)}`, exitCode: 1 }); });
  });
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function hashDirectory(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (['node_modules', 'dist', '.git', 'source.tgz'].includes(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (entry.isDirectory()) await walk(fullPath);
      else { const content = await fs.readFile(fullPath); hash.update(relativePath); hash.update(content); }
    }
  }
  await walk(rootDir);
  return hash.digest('hex');
}

async function writeGeneratedFile(workspaceRoot: string, file: GeneratedFile): Promise<void> {
  const target = resolveWorkspacePath(workspaceRoot, file.path);
  debug('materializeProjectWorkspace:fileWrite', { path: target });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.content, 'utf8');
}

export async function materializeProjectWorkspace(input: MaterializeInput): Promise<MaterializedRevision> {
  const projectSegment = sanitizeSegment(input.projectId);
  const workspaceRoot = path.join(PROJECTS_ROOT, projectSegment);
  const revisionId = crypto.randomUUID();
  await fs.mkdir(workspaceRoot, { recursive: true });
  await materializeTemplate(workspaceRoot);
  console.log(`[materializeProjectWorkspace] workspaceRoot=${workspaceRoot}`);

  for (const file of extractGeneratedFiles(input.codeGen)) {
    await writeGeneratedFile(workspaceRoot, file);
  }

  const patchText = typeof input.codeGen?.patch === 'string' ? input.codeGen.patch : '';
  const patchPath = path.join(workspaceRoot, 'GENERATED_PATCH.diff');
  await fs.writeFile(patchPath, patchText || '# No patch generated for this revision\n', 'utf8');

  let patchApplied = false;
  let patchApplyLog = 'No patch provided.';
  if (patchText.trim()) {
    await runCommand('git', ['init'], workspaceRoot, 20_000);
    const apply = await runCommand('git', ['apply', '--whitespace=nowarn', 'GENERATED_PATCH.diff'], workspaceRoot, 20_000);
    patchApplied = apply.exitCode === 0;
    patchApplyLog = `${apply.stdout}\n${apply.stderr}`.trim();
  }

  const archivePath = path.join(workspaceRoot, `${revisionId}.tgz`);
  const tar = await runCommand('tar', ['-czf', archivePath, '--exclude=.git', '--exclude=node_modules', '--exclude=dist', '--exclude=source.tgz', '.'], workspaceRoot, 30_000);
  if (tar.exitCode !== 0) {
    logError('materializeProjectWorkspace:archive', tar.stderr || tar.stdout);
    throw new Error(`Failed to archive generated source: ${tar.stderr || tar.stdout}`);
  }

  const sourceHash = await hashDirectory(workspaceRoot);

  return { revisionId, workspaceDir: workspaceRoot, archivePath, sourceHash, patchPath, patchApplied, patchApplyLog };
}
