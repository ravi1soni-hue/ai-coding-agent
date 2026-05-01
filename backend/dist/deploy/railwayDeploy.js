"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deployToRailway = deployToRailway;
const axios_1 = __importDefault(require("axios"));
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const env_1 = require("../config/env");
function normalizeUrl(rawUrl) {
    if (!rawUrl)
        return '';
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        return rawUrl;
    }
    return `https://${rawUrl}`;
}
function isRailwayDashboardUrl(url) {
    return /https?:\/\/railway\.app\/project\//.test(url);
}
async function resolveRailwayServiceUrl() {
    const configPath = path_1.default.resolve(__dirname, '../../railway.config.json');
    try {
        const raw = await promises_1.default.readFile(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        const configuredUrl = normalizeUrl(parsed.railway_url ?? '');
        if (configuredUrl && !isRailwayDashboardUrl(configuredUrl))
            return configuredUrl;
    }
    catch {
        // config file not readable — fall through
    }
    const publicUrl = normalizeUrl(env_1.config.RAILWAY_PUBLIC_URL || '');
    if (publicUrl && !isRailwayDashboardUrl(publicUrl)) {
        return publicUrl;
    }
    return '';
}
function runCommand(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function triggerRailwayDeployment(input) {
    const query = `
    mutation serviceInstanceDeploy($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(input: { environmentId: $environmentId, serviceId: $serviceId }) {
        id
        status
      }
    }
  `;
    const res = await axios_1.default.post(env_1.config.RAILWAY_GRAPHQL_URL, {
        query,
        variables: {
            environmentId: input.environmentId,
            serviceId: input.serviceId,
        },
    }, {
        headers: {
            Authorization: `Bearer ${input.token}`,
            'Content-Type': 'application/json',
        },
        timeout: 20000,
    });
    const deployment = res.data?.data?.serviceInstanceDeploy;
    if (!deployment?.id) {
        throw new Error(`Railway deploy API did not return deployment id: ${JSON.stringify(res.data)}`);
    }
    const rawStatus = String(deployment.status || '').toLowerCase();
    const status = rawStatus.includes('fail')
        ? 'failed'
        : rawStatus.includes('build')
            ? 'building'
            : rawStatus.includes('queue')
                ? 'queued'
                : 'deployed';
    return {
        deploymentId: deployment.id,
        status,
        logUrl: `https://railway.app/project/${input.projectId}/service/${input.serviceId}`,
    };
}
async function runRailwayCliDeploy(sourceDir) {
    try {
        const { stdout, stderr, exitCode } = await runCommand('railway', ['up', '--detach'], sourceDir, 180000);
        const deploymentId = `railway-cli-${Date.now().toString(36)}`;
        const serviceUrlMatch = stdout.match(/https?:\/\/[\w.-]+\.railway\.app/);
        return {
            deploymentId,
            status: exitCode === 0 ? 'building' : 'failed',
            serviceUrl: serviceUrlMatch?.[0] || '',
            logUrl: `https://railway.app/project/${env_1.config.RAILWAY_PROJECT_ID ?? 'unknown'}`,
        };
    }
    catch (err) {
        throw new Error(`Railway CLI deployment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
async function deployToRailway(service, deployConfig) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('Deploying to Railway target:', service, deployConfig);
    }
    const serviceUrl = await resolveRailwayServiceUrl();
    const dashboardUrl = env_1.config.RAILWAY_PROJECT_ID
        ? `https://railway.app/project/${env_1.config.RAILWAY_PROJECT_ID}`
        : 'https://railway.app';
    const deploymentView = env_1.config.RAILWAY_PROJECT_ID && env_1.config.RAILWAY_SERVICE_ID
        ? `https://railway.app/project/${env_1.config.RAILWAY_PROJECT_ID}/service/${env_1.config.RAILWAY_SERVICE_ID}`
        : dashboardUrl;
    let status = 'queued';
    let deploymentId = deployConfig.revisionId
        ? `rail_${String(deployConfig.revisionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
        : `rail_${Date.now().toString(36)}`;
    let logUrl = deploymentView;
    if (deployConfig.sourceDir) {
        try {
            const cliResult = await runRailwayCliDeploy(deployConfig.sourceDir);
            deploymentId = cliResult.deploymentId || deploymentId;
            status = cliResult.status || status;
            logUrl = cliResult.logUrl || logUrl;
        }
        catch (err) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('[railwayDeploy] CLI deploy failed, falling back to GraphQL trigger:', err);
            }
        }
    }
    const canTriggerDeploy = Boolean(env_1.config.RAILWAY_TOKEN) &&
        Boolean(env_1.config.RAILWAY_PROJECT_ID) &&
        Boolean(env_1.config.RAILWAY_SERVICE_ID) &&
        Boolean(env_1.config.RAILWAY_ENVIRONMENT_ID);
    if (canTriggerDeploy) {
        try {
            const deployResponse = await triggerRailwayDeployment({
                projectId: env_1.config.RAILWAY_PROJECT_ID,
                environmentId: env_1.config.RAILWAY_ENVIRONMENT_ID,
                serviceId: env_1.config.RAILWAY_SERVICE_ID,
                token: env_1.config.RAILWAY_TOKEN,
            });
            deploymentId = deployResponse.deploymentId || deploymentId;
            status = deployResponse.status || status;
            logUrl = deployResponse.logUrl || logUrl;
        }
        catch (err) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('Railway deploy API call failed, using health-check fallback', err);
            }
        }
    }
    try {
        if (serviceUrl) {
            const health = await axios_1.default.get(serviceUrl, { timeout: 15000, validateStatus: () => true });
            if (status !== 'building' && status !== 'queued') {
                status = health.status >= 200 && health.status < 500 ? 'deployed' : 'failed';
            }
        }
    }
    catch {
        if (status !== 'building' && status !== 'queued') {
            status = 'failed';
        }
    }
    return {
        deploymentId,
        status,
        serviceUrl,
        logUrl,
        dashboardUrl,
    };
}
