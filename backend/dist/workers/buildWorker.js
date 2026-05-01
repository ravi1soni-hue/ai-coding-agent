"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBuildWorker = runBuildWorker;
exports.cleanupWorkspace = cleanupWorkspace;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
function runCommand(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function fileExists(filePath) {
    try {
        await promises_1.default.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function hasTestScript(workspaceDir) {
    try {
        const packageJsonPath = path_1.default.join(workspaceDir, 'package.json');
        const raw = await promises_1.default.readFile(packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw);
        const testScript = pkg.scripts?.test;
        if (!testScript)
            return false;
        return !testScript.includes('no test specified');
    }
    catch {
        return false;
    }
}
async function installDependencies(workspaceDir) {
    const lockPath = path_1.default.join(workspaceDir, 'package-lock.json');
    const installCommand = await fileExists(lockPath) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    return runCommand('npm', installCommand, workspaceDir, 5 * 60000);
}
async function buildWorkspace(workspaceDir) {
    return runCommand('npm', ['run', 'build'], workspaceDir, 5 * 60000);
}
async function runBuildWorker(payload) {
    const workspaceDir = payload.workspaceDir;
    if (!workspaceDir) {
        return { success: false, logs: 'workspaceDir is required for real build/test execution.' };
    }
    const logs = [];
    const frontendDir = workspaceDir;
    const backendDir = path_1.default.join(workspaceDir, 'backend');
    let frontendBuildDir;
    let backendWorkspaceDir;
    if (await fileExists(path_1.default.join(frontendDir, 'package.json'))) {
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
        frontendBuildDir = path_1.default.join(frontendDir, 'dist');
    }
    else {
        logs.push('No frontend package.json found. Skipping frontend build.');
    }
    if (await fileExists(path_1.default.join(backendDir, 'package.json'))) {
        logs.push(`[buildWorker] Installing backend dependencies in ${backendDir}`);
        const installResult = await installDependencies(backendDir);
        logs.push('$ npm install (backend)');
        logs.push(installResult.output.trim());
        if (installResult.code !== 0) {
            return { success: false, logs: logs.join('\n\n') };
        }
        const buildJsonPath = path_1.default.join(backendDir, 'package.json');
        try {
            const raw = await promises_1.default.readFile(buildJsonPath, 'utf8');
            const pkg = JSON.parse(raw);
            if (pkg.scripts?.build) {
                const buildResult = await buildWorkspace(backendDir);
                logs.push('$ npm run build (backend)');
                logs.push(buildResult.output.trim());
                if (buildResult.code !== 0) {
                    return { success: false, logs: logs.join('\n\n') };
                }
            }
            else {
                logs.push('Backend package has no build script. Skipping backend build.');
            }
        }
        catch (err) {
            logs.push(`Unable to read backend package.json: ${err?.message || String(err)}`);
        }
        if (await hasTestScript(backendDir)) {
            const testResult = await runCommand('npm', ['test', '--', '--watch=false'], backendDir, 5 * 60000);
            logs.push('$ npm test -- --watch=false (backend)');
            logs.push(testResult.output.trim());
            if (testResult.code !== 0) {
                return { success: false, logs: logs.join('\n\n') };
            }
        }
        else {
            logs.push('No backend test script found. Skipping backend test phase.');
        }
        backendWorkspaceDir = backendDir;
    }
    else {
        logs.push('No backend package.json found. Skipping backend install/build.');
    }
    if (!frontendBuildDir) {
        return { success: false, logs: 'Frontend build output not available. Ensure generated frontend code exists and can build.' };
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
async function cleanupWorkspace(workspaceDir) {
    try {
        const nodeModulesPath = path_1.default.join(workspaceDir, 'node_modules');
        await promises_1.default.rm(nodeModulesPath, { recursive: true, force: true });
        const backendModulesPath = path_1.default.join(workspaceDir, 'backend', 'node_modules');
        await promises_1.default.rm(backendModulesPath, { recursive: true, force: true });
        console.log(`[buildWorker] Cleaned up node_modules at ${nodeModulesPath} and ${backendModulesPath}`);
    }
    catch (err) {
        console.warn(`[buildWorker] Could not clean up node_modules: ${err?.message}`);
    }
}
