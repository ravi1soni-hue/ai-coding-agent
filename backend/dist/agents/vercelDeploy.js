"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployToVercel = deployToVercel;
const axios_1 = __importDefault(require("axios"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const env_1 = require("../config/env");
// Vercel config from central env — never hardcode project IDs here
const VERCEL_ACCESS_TOKEN = env_1.config.VERCEL_ACCESS_TOKEN;
const VERCEL_TEAM_ID = env_1.config.VERCEL_TEAM_ID;
// Deploys the frontend build output to Vercel using the REST API.
// projectName is always dynamic (per-user-project); Vercel creates or reuses the project by name.
async function deployToVercel({ buildDir = '../../frontend/dist', projectName, meta } = {}) {
    if (!projectName)
        throw new Error('projectName is required for Vercel deployment — must be derived from projectId');
    if (!VERCEL_ACCESS_TOKEN)
        throw new Error('VERCEL_ACCESS_TOKEN is not set. Configure it in Railway environment variables.');
    // Read all files in the build directory recursively
    function getFiles(dir, base = dir) {
        if (!fs_1.default.existsSync(dir)) {
            throw new Error(`Directory does not exist: ${dir}`);
        }
        let files = [];
        for (const file of fs_1.default.readdirSync(dir)) {
            const fullPath = path_1.default.join(dir, file);
            if (fs_1.default.statSync(fullPath).isDirectory()) {
                files = files.concat(getFiles(fullPath, base));
            }
            else {
                files.push({
                    file: path_1.default.relative(base, fullPath),
                    data: fs_1.default.readFileSync(fullPath)
                });
            }
        }
        return files;
    }
    const resolvedBuildDir = path_1.default.isAbsolute(buildDir) ? buildDir : path_1.default.resolve(__dirname, buildDir);
    if (!fs_1.default.existsSync(resolvedBuildDir)) {
        throw new Error(`Build directory does not exist: ${resolvedBuildDir}. Frontend build may have failed or output directory is incorrect.`);
    }
    const files = getFiles(resolvedBuildDir);
    const fileList = files.map((f) => ({ file: f.file, data: f.data.toString('base64'), encoding: 'base64' }));
    // Vercel requires lowercase project names (alphanumeric + hyphens only)
    const sanitizedProjectName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
    // Prepare the deployment payload.
    // Do NOT pass a fixed projectId — let Vercel find or create a project by name.
    // This ensures each user project gets its own isolated Vercel project.
    const payload = {
        name: sanitizedProjectName,
        files: fileList,
        target: 'production',
        meta: (meta && Object.keys(meta).length > 0) ? meta : undefined,
        // Required by Vercel v13 API for new projects
        projectSettings: {
            framework: null,
            buildCommand: null,
            devCommand: null,
            installCommand: null,
            outputDirectory: null
        }
    };
    // Build query params — skipAutoDetectionConfirmation avoids the missing_project_settings error
    const queryParams = { skipAutoDetectionConfirmation: '1' };
    if (VERCEL_TEAM_ID)
        queryParams.teamId = VERCEL_TEAM_ID;
    // Call Vercel Deployments API
    let response;
    try {
        response = await axios_1.default.post('https://api.vercel.com/v13/deployments', payload, {
            params: queryParams,
            headers: {
                Authorization: `Bearer ${VERCEL_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            const status = err.response?.status || 500;
            const details = typeof err.response?.data === 'string'
                ? err.response.data
                : JSON.stringify(err.response?.data || {});
            throw new Error(`Vercel API request failed for project "${sanitizedProjectName}": HTTP ${status} — ${details}`);
        }
        throw err;
    }
    if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Vercel deployment failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    // Return deployment URL
    return {
        url: response.data.url,
        inspectUrl: response.data.inspectorUrl || null,
        deploymentId: response.data.id,
        status: response.data.readyState || response.data.status || 'READY',
        logUrl: response.data.inspectorUrl || null,
    };
}
