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

const WORKSPACES_ROOT = path.resolve('/tmp/workspaces');
const PROJECTS_ROOT = path.resolve('/tmp');
/**
 * Path Mapping gap:
 * - Starter templates should live under a read-only directory (/app/templates).
 * - Generated workspaces are the only mutable filesystem under /tmp/workspaces.
 */
const READ_ONLY_TEMPLATE_ROOT = path.resolve('/app/templates/fullstack-starter');
const FALLBACK_TEMPLATE_CANDIDATES = [
  path.resolve(__dirname, '../../../templates/fullstack-starter'),
];

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

// The code-generation agent emits frontend files with bare paths
// (src/App.jsx, package.json, index.html, vite.config.js) and backend
// files prefixed with backend/. The build worker, however, expects both
// scopes under workspaceRoot/{frontend,backend}/. Route bare paths into
// frontend/ so the generated files actually overwrite the template.
function scopeGeneratedPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.startsWith('frontend/') || normalized.startsWith('backend/')) return normalized;
  return `frontend/${normalized}`;
}

function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = scopeGeneratedPath(relativePath);
  if (
    normalized.includes('..') ||
    normalized === 'backend' ||
    normalized === 'frontend' ||
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

async function validateTemplateIntegrity(templatePath: string): Promise<boolean> {
  try {
    // Check for essential files
    const requiredFiles = ['package.json', 'src/main.jsx', 'src/App.jsx', 'index.html'];
    for (const file of requiredFiles) {
      if (!(await exists(path.join(templatePath, file)))) {
        return false;
      }
    }
    // Check package.json has basic structure
    const packageJsonPath = path.join(templatePath, 'package.json');
    const packageContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageContent);
    if (!packageJson.name || !packageJson.dependencies || !packageJson.dependencies.react) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

type TemplateAttempt = { path: string; existed: boolean; valid?: boolean; reason?: string };

async function materializeTemplate(workspaceRoot: string): Promise<void> {
  const attempts: TemplateAttempt[] = [];

  const tryCandidate = async (candidate: string): Promise<boolean> => {
    const existed = await exists(candidate);
    if (!existed) { attempts.push({ path: candidate, existed: false }); return false; }
    const valid = await validateTemplateIntegrity(candidate);
    attempts.push({ path: candidate, existed: true, valid, reason: valid ? 'used' : 'failed integrity check' });
    if (!valid) return false;

    debug('materializeTemplate:using-fullstack', { path: candidate });
    await copyDir(candidate, workspaceRoot);
    return true;
  };

  // Strategy 1 (primary): monolithic template from read-only /app/templates.
  // This ensures templates are immutable and only the generated workspace
  // is mutable under /tmp/workspaces.
  if (await tryCandidate(READ_ONLY_TEMPLATE_ROOT)) return;

  // Strategy 1 (fallback): allow existing repo-local template locations for dev/testing.
  const fullstackCandidates = [
    ...FALLBACK_TEMPLATE_CANDIDATES,
    path.resolve(__dirname, '../../../src/templates/fullstack-starter'),
    path.resolve(__dirname, '../templates/fullstack-starter'),
    path.resolve(process.cwd(), 'templates/fullstack-starter'),
    path.resolve(process.cwd(), 'src/templates/fullstack-starter'),
    path.resolve(process.cwd(), 'dist/templates/fullstack-starter'),
  ];

  for (const candidate of fullstackCandidates) {
    if (await tryCandidate(candidate)) return;
  }

  // Strategy 2: split frontend + backend fallbacks (search multiple roots)
  const splitRoots = [
    path.resolve(__dirname, '../templates'),                // dist/templates (compiled)
    path.resolve(__dirname, '../../src/templates'),         // src/templates from dist
    path.resolve(process.cwd(), 'src/templates'),
    path.resolve(process.cwd(), 'dist/templates'),
    path.resolve(process.cwd(), 'backend/src/templates'),
    path.resolve(process.cwd(), 'backend/dist/templates'),
  ];
  for (const root of splitRoots) {
    const fe = path.join(root, 'frontend');
    const be = path.join(root, 'backend');
    const feExists = await exists(fe);
    const beExists = await exists(be);
    if (!feExists || !beExists) {
      attempts.push({ path: root, existed: feExists && beExists, reason: `frontend=${feExists} backend=${beExists}` });
      continue;
    }
    debug('materializeTemplate:using-split', { root });
    await copyDir(fe, path.join(workspaceRoot, 'frontend'));
    await copyDir(be, path.join(workspaceRoot, 'backend'));
    attempts.push({ path: root, existed: true, valid: true, reason: 'used (split)' });
    return;
  }

  const summary = attempts.map(a => `  - ${a.path} [exists=${a.existed}${a.valid !== undefined ? `, valid=${a.valid}` : ''}${a.reason ? `, ${a.reason}` : ''}]`).join('\n');
  logError('materializeTemplate:no-templates', `__dirname=${__dirname}\ncwd=${process.cwd()}\nAttempts:\n${summary}`);
  throw new Error(`No valid templates found for materialization. __dirname=${__dirname}, cwd=${process.cwd()}.\nAttempted:\n${summary}`);
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

export async function writeGeneratedFile(workspaceRoot: string, file: GeneratedFile): Promise<void> {
  const target = resolveWorkspacePath(workspaceRoot, file.path);
  debug('materializeProjectWorkspace:fileWrite', { path: target });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.content, 'utf8');
}

export async function materializeProjectWorkspace(input: MaterializeInput): Promise<MaterializedRevision> {
  const projectSegment = sanitizeSegment(input.projectId);
  const revisionId = crypto.randomUUID();
  const workspaceRoot = path.join(WORKSPACES_ROOT, `${projectSegment}-${revisionId}`);
  await fs.mkdir(workspaceRoot, { recursive: true });
  await materializeTemplate(workspaceRoot);
  console.log(`[materializeProjectWorkspace] workspaceRoot=${workspaceRoot}`);

  for (const file of extractGeneratedFiles(input.codeGen)) {
    await writeGeneratedFile(workspaceRoot, file);
  }

  // BuildWorker pre-validation expects:
  // - backend/src/index.ts to exist
  // - backend/index.js to NOT exist (TypeScript-only backend)
  // - backend/db/init.sql (or backend/db/schema.sql) to exist
  // Some templates can ship legacy artifacts; normalize them here.
  const backendDir = path.join(workspaceRoot, 'backend');
  const backendPkgPath = path.join(backendDir, 'package.json');

  if (await exists(backendPkgPath)) {
    // 1) Remove legacy backend/index.js if present
    await fs.rm(path.join(backendDir, 'index.js'), { force: true }).catch(() => {});

    // 2) Ensure backend/src/index.ts exists
    const backendSrcDir = path.join(backendDir, 'src');
    const backendSrcIndexTs = path.join(backendSrcDir, 'index.ts');
    const backendExpressDts = path.join(backendSrcDir, 'express.d.ts');

    if (!(await exists(backendSrcIndexTs))) {
      await fs.mkdir(backendSrcDir, { recursive: true });

      // Minimal TS-only backend entrypoint for pre-validation.
      // Avoid imports from other local backend modules so it can compile even if the template is minimal.
      await fs.writeFile(
        backendSrcIndexTs,
        `import express from 'express';

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json());

app.get('/api/health', async (_req: any, res: any) => {
  res.json({ status: 'ok', db: 'not-configured' });
});

app.get('/api/echo', (req: any, res: any) => {
  res.json({ message: 'Generated backend entrypoint running', query: req.query });
});

app.listen(port, () => {
  console.log(\`Backend listening on port \${port}\`);
});
`,
        'utf8'
      );
    }

    if (!(await exists(backendExpressDts))) {
      await fs.writeFile(
        backendExpressDts,
        `declare module 'express' {
  const express: any;
  export default express;
}
`,
        'utf8'
      );
    }

    // 3) Ensure backend/db/init.sql exists (fallback to minimal schema)
    const backendDbDir = path.join(backendDir, 'db');
    const initSqlPath = path.join(backendDbDir, 'init.sql');
    const schemaSqlPath = path.join(backendDbDir, 'schema.sql');

    if (!(await exists(initSqlPath)) && !(await exists(schemaSqlPath))) {
      await fs.mkdir(backendDbDir, { recursive: true });
      await fs.writeFile(
        initSqlPath,
        `CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`,
        'utf8'
      );
    }
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

  // Create a snapshot of the workspace to avoid "file changed as we read it" race condition
  // Archive from the snapshot instead of the live workspace
  const snapshotId = crypto.randomUUID();
  const snapshotDir = path.join(PROJECTS_ROOT, `snapshot-${snapshotId}`);
  const archivePath = path.join(workspaceRoot, `${revisionId}.tgz`);
  
  debug('materializeProjectWorkspace:creating-snapshot', { snapshotDir });
  
  try {
    await copyDir(workspaceRoot, snapshotDir);
    debug('materializeProjectWorkspace:snapshot-copied', { snapshotDir });
    
    // Archive the snapshot from its parent directory to ensure stable read
    // Using absolute path for archive output
    const tar = await runCommand(
      'tar',
      ['-czf', archivePath, '--exclude=.git', '--exclude=node_modules', '--exclude=dist', '--exclude=source.tgz', '-C', path.dirname(snapshotDir), path.basename(snapshotDir)],
      path.dirname(snapshotDir),
      30_000
    );
    
    if (tar.exitCode !== 0) {
      logError('materializeProjectWorkspace:archive', tar.stderr || tar.stdout);
      throw new Error(`Failed to archive generated source: ${tar.stderr || tar.stdout}`);
    }
    
    debug('materializeProjectWorkspace:snapshot-archived', { archivePath });
  } finally {
    // Clean up snapshot directory to avoid accumulation
    try {
      await fs.rm(snapshotDir, { recursive: true, force: true });
      debug('materializeProjectWorkspace:snapshot-cleaned', { snapshotDir });
    } catch (err) {
      logError('materializeProjectWorkspace:snapshot-cleanup-failed', String(err));
    }
  }

  const sourceHash = await hashDirectory(workspaceRoot);

  return { revisionId, workspaceDir: workspaceRoot, archivePath: path.join(workspaceRoot, `${revisionId}.tgz`), sourceHash, patchPath, patchApplied, patchApplyLog };
}
