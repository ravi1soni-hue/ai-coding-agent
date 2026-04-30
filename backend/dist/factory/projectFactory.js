"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.materializeProjectWorkspace = materializeProjectWorkspace;
const crypto_1 = __importDefault(require("crypto"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const WORKSPACE_ROOT = path_1.default.resolve(__dirname, '../../generated-projects');
const FRONTEND_TEMPLATE_DIR = path_1.default.resolve(__dirname, '../../../frontend');
function sanitizeSegment(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'project';
}
function extractGeneratedFiles(codeGen) {
    const candidates = [codeGen?.files, codeGen?.generatedFiles];
    for (const candidate of candidates) {
        if (!Array.isArray(candidate))
            continue;
        const files = [];
        for (const item of candidate) {
            const filePath = item?.path;
            const content = item?.content;
            if (typeof filePath === 'string' && typeof content === 'string') {
                files.push({ path: filePath, content });
            }
        }
        if (files.length > 0)
            return files;
    }
    return [];
}
async function copyDir(source, destination) {
    await promises_1.default.mkdir(destination, { recursive: true });
    const entries = await promises_1.default.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
            continue;
        }
        const srcPath = path_1.default.join(source, entry.name);
        const destPath = path_1.default.join(destination, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
            continue;
        }
        await promises_1.default.copyFile(srcPath, destPath);
    }
}
function runCommand(cmd, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function hashDirectory(rootDir) {
    const hash = crypto_1.default.createHash('sha256');
    async function walk(currentDir) {
        const entries = await promises_1.default.readdir(currentDir, { withFileTypes: true });
        const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
            if (entry.name === 'node_modules' ||
                entry.name === 'dist' ||
                entry.name === '.git' ||
                entry.name === 'source.tgz') {
                continue;
            }
            const fullPath = path_1.default.join(currentDir, entry.name);
            const relativePath = path_1.default.relative(rootDir, fullPath);
            if (entry.isDirectory()) {
                await walk(fullPath);
            }
            else {
                const content = await promises_1.default.readFile(fullPath);
                hash.update(relativePath);
                hash.update(content);
            }
        }
    }
    await walk(rootDir);
    return hash.digest('hex');
}
async function materializeProjectWorkspace(input) {
    const projectSegment = sanitizeSegment(input.projectId);
    const projectDir = path_1.default.join(WORKSPACE_ROOT, projectSegment);
    const revisionId = crypto_1.default.randomUUID();
    const workspaceDir = path_1.default.join(projectDir, revisionId);
    await promises_1.default.mkdir(workspaceDir, { recursive: true });
    await copyDir(FRONTEND_TEMPLATE_DIR, workspaceDir);
    const generatedFiles = extractGeneratedFiles(input.codeGen);
    for (const file of generatedFiles) {
        const normalized = file.path.replace(/^\/+/, '');
        const target = path_1.default.resolve(workspaceDir, normalized);
        if (!target.startsWith(workspaceDir)) {
            throw new Error(`Invalid generated file path: ${file.path}`);
        }
        await promises_1.default.mkdir(path_1.default.dirname(target), { recursive: true });
        await promises_1.default.writeFile(target, file.content, 'utf8');
    }
    const patchText = typeof input.codeGen?.patch === 'string' ? input.codeGen.patch : '';
    const patchPath = path_1.default.join(workspaceDir, 'GENERATED_PATCH.diff');
    await promises_1.default.writeFile(patchPath, patchText || '# No patch generated for this revision\n', 'utf8');
    let patchApplied = false;
    let patchApplyLog = 'No patch provided.';
    if (patchText.trim()) {
        await runCommand('git', ['init'], workspaceDir, 20000);
        const apply = await runCommand('git', ['apply', '--whitespace=nowarn', 'GENERATED_PATCH.diff'], workspaceDir, 20000);
        patchApplied = apply.exitCode === 0;
        patchApplyLog = `${apply.stdout}\n${apply.stderr}`.trim();
    }
    const archivePath = path_1.default.join(projectDir, `${revisionId}.tgz`);
    const tar = await runCommand('tar', [
        '-czf',
        archivePath,
        '--exclude=.git',
        '--exclude=node_modules',
        '--exclude=dist',
        '--exclude=source.tgz',
        '.',
    ], workspaceDir, 30000);
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
