"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployToVercel = deployToVercel;
const axios_1 = __importDefault(require("axios"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../config/../../.env') });
// Vercel config from environment variables
const VERCEL_ACCESS_TOKEN = process.env.VERCEL_ACCESS_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || '';
const CUSTOM_DOMAIN = process.env.VERCEL_CUSTOM_DOMAIN || '';
// Deploys the frontend build output to Vercel using the REST API
async function deployToVercel({ buildDir = '../../frontend', projectName = 'ai-coding-agent-iota-ochre' } = {}) {
    // Read all files in the build directory recursively
    function getFiles(dir, base = dir) {
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
    const files = getFiles(path_1.default.resolve(__dirname, buildDir));
    const fileList = files.map((f) => ({ file: f.file, data: f.data.toString('base64') }));
    // Prepare the deployment payload
    const payload = {
        name: projectName,
        projectId: VERCEL_PROJECT_ID,
        files: fileList.map((f) => ({ file: f.file, data: f.data })),
        target: 'production',
        teamId: VERCEL_TEAM_ID
    };
    // Call Vercel Deployments API
    const response = await axios_1.default.post('https://api.vercel.com/v13/deployments', payload, {
        headers: {
            Authorization: `Bearer ${VERCEL_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
    if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Vercel deployment failed: ${response.status} ${JSON.stringify(response.data)}`);
    }
    // Return deployment URL
    return {
        url: response.data.url,
        inspectUrl: response.data.inspectorUrl || null,
        deploymentId: response.data.id
    };
}
