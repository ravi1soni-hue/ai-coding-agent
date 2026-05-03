import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { config as env } from '../config/env';
import { debug, warn as logWarn, error as logError } from '../utils/logger';

export type RailwayDeployResult = {
  deploymentId: string;
  status: 'queued' | 'building' | 'deployed' | 'failed';
  serviceUrl: string;
  logUrl: string;
  dashboardUrl: string;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function normalizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  return rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
}

function isRailwayDashboardUrl(url: string): boolean {
  return /https?:\/\/railway\.app\/project\//.test(url);
}

async function resolveRailwayServiceUrl(): Promise<string> {
  const configPath = path.resolve(__dirname, '../../railway.config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { railway_url?: string };
    const url = normalizeUrl(parsed.railway_url ?? '');
    if (url && !isRailwayDashboardUrl(url)) return url;
  } catch {}

  const publicUrl = normalizeUrl(env.RAILWAY_PUBLIC_URL || '');
  if (publicUrl && !isRailwayDashboardUrl(publicUrl)) return publicUrl;
  return '';
}

function runCommand(
  command: string, args: string[], cwd: string, timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`, exitCode: 124 });
    }, timeoutMs);
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 }); });
    child.on('error', err => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}\n${err}`, exitCode: 1 }); });
  });
}

// ---------------------------------------------------------------------------
// Railway GraphQL helpers
// ---------------------------------------------------------------------------

async function railwayGraphql(query: string, variables: Record<string, any>): Promise<any> {
  const res = await axios.post(
    env.RAILWAY_GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${env.RAILWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 25_000,
    }
  );
  if (res.data?.errors?.length) {
    throw new Error(`Railway GraphQL error: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data?.data;
}

/**
 * Upserts environment variables on the Railway service so the generated
 * backend has POSTGRES_URL, PORT, and NODE_ENV when it starts.
 */
async function setRailwayEnvVars(): Promise<void> {
  const canSet =
    Boolean(env.RAILWAY_TOKEN) &&
    Boolean(env.RAILWAY_PROJECT_ID) &&
    Boolean(env.RAILWAY_SERVICE_ID) &&
    Boolean(env.RAILWAY_ENVIRONMENT_ID);

  if (!canSet) {
    logWarn('railwayDeploy:setEnvVars', 'Missing Railway config, skipping env var injection');
    return;
  }

  const variables: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '3000',
  };
  if (env.POSTGRES_URL) variables.POSTGRES_URL = env.POSTGRES_URL;
  if (env.REDIS_URL) variables.REDIS_URL = env.REDIS_URL;

  const mutation = `
    mutation variableCollectionUpsert($environmentId: String!, $projectId: String!, $serviceId: String!, $variables: ServiceVariables!) {
      variableCollectionUpsert(
        environmentId: $environmentId
        projectId: $projectId
        serviceId: $serviceId
        variables: $variables
      )
    }
  `;

  try {
    await railwayGraphql(mutation, {
      environmentId: env.RAILWAY_ENVIRONMENT_ID,
      projectId: env.RAILWAY_PROJECT_ID,
      serviceId: env.RAILWAY_SERVICE_ID,
      variables,
    });
    debug('railwayDeploy:envVarsSet', { keys: Object.keys(variables) });
  } catch (err) {
    logWarn('railwayDeploy:setEnvVars-failed', (err as Error).message);
    // Non-fatal — deployment will still proceed
  }
}

/**
 * Triggers a new deployment via the Railway GraphQL API.
 */
async function triggerRailwayDeployment(): Promise<{
  deploymentId?: string;
  status?: RailwayDeployResult['status'];
  logUrl?: string;
}> {
  const mutation = `
    mutation serviceInstanceDeploy($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(input: { environmentId: $environmentId, serviceId: $serviceId }) {
        id
        status
      }
    }
  `;

  const data = await railwayGraphql(mutation, {
    environmentId: env.RAILWAY_ENVIRONMENT_ID,
    serviceId: env.RAILWAY_SERVICE_ID,
  });

  const deployment = data?.serviceInstanceDeploy;
  if (!deployment?.id) {
    throw new Error(`Railway deploy API did not return a deployment id: ${JSON.stringify(data)}`);
  }

  const raw = String(deployment.status || '').toLowerCase();
  const status: RailwayDeployResult['status'] =
    raw.includes('fail') ? 'failed' :
    raw.includes('build') ? 'building' :
    raw.includes('queue') ? 'queued' : 'deployed';

  return {
    deploymentId: deployment.id,
    status,
    logUrl: `https://railway.app/project/${env.RAILWAY_PROJECT_ID}/service/${env.RAILWAY_SERVICE_ID}`,
  };
}

/**
 * Deploy via Railway CLI (railway up --detach).
 */
async function runRailwayCliDeploy(sourceDir: string): Promise<{
  deploymentId: string;
  status: RailwayDeployResult['status'];
  serviceUrl: string;
  logUrl: string;
}> {
  const { stdout, exitCode } = await runCommand('railway', ['up', '--detach'], sourceDir, 180_000);
  const urlMatch = stdout.match(/https?:\/\/[\w.-]+\.railway\.app/);
  return {
    deploymentId: `railway-cli-${Date.now().toString(36)}`,
    status: exitCode === 0 ? 'building' : 'failed',
    serviceUrl: urlMatch?.[0] || '',
    logUrl: `https://railway.app/project/${env.RAILWAY_PROJECT_ID ?? 'unknown'}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function deployToRailway(
  service: string,
  deployConfig: {
    source?: string;
    projectId?: string;
    revisionId?: string;
    sourceDir?: string;
  }
): Promise<RailwayDeployResult> {
  debug('railwayDeploy:start', { service, sourceDir: deployConfig.sourceDir });

  const serviceUrl = await resolveRailwayServiceUrl();
  const dashboardUrl = env.RAILWAY_PROJECT_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}`
    : 'https://railway.app';
  const deploymentView = env.RAILWAY_PROJECT_ID && env.RAILWAY_SERVICE_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}/service/${env.RAILWAY_SERVICE_ID}`
    : dashboardUrl;

  let status: RailwayDeployResult['status'] = 'queued';
  let deploymentId = deployConfig.revisionId
    ? `rail_${String(deployConfig.revisionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
    : `rail_${Date.now().toString(36)}`;
  let logUrl = deploymentView;

  // ── Step 1: Inject env vars so backend starts correctly ─────────────────
  await setRailwayEnvVars();

  // ── Step 2: Try CLI deploy if sourceDir is given ─────────────────────────
  if (deployConfig.sourceDir) {
    try {
      const cliResult = await runRailwayCliDeploy(deployConfig.sourceDir);
      deploymentId = cliResult.deploymentId || deploymentId;
      status = cliResult.status || status;
      logUrl = cliResult.logUrl || logUrl;
      debug('railwayDeploy:cli-result', { status, deploymentId });
    } catch (err) {
      logWarn('railwayDeploy:cli-failed', { error: (err as Error).message, fallback: 'GraphQL trigger' });
    }
  }

  // ── Step 3: GraphQL trigger (primary for non-CLI, fallback otherwise) ────
  const canTrigger =
    Boolean(env.RAILWAY_TOKEN) &&
    Boolean(env.RAILWAY_PROJECT_ID) &&
    Boolean(env.RAILWAY_SERVICE_ID) &&
    Boolean(env.RAILWAY_ENVIRONMENT_ID);

  if (canTrigger) {
    try {
      const gqlResult = await triggerRailwayDeployment();
      deploymentId = gqlResult.deploymentId || deploymentId;
      status = gqlResult.status || status;
      logUrl = gqlResult.logUrl || logUrl;
      debug('railwayDeploy:graphql-result', { status, deploymentId });
    } catch (err) {
      logWarn('railwayDeploy:graphql-failed', (err as Error).message);
      // Keep status from CLI result or 'queued'
    }
  }

  // ── Step 4: Health check to confirm service is reachable ─────────────────
  if (serviceUrl) {
    try {
      const health = await axios.get(serviceUrl, { timeout: 20_000, validateStatus: () => true });
      if (status !== 'building' && status !== 'queued') {
        status = health.status >= 200 && health.status < 500 ? 'deployed' : 'failed';
      }
      debug('railwayDeploy:health-check', { httpStatus: health.status, deployStatus: status });
    } catch {
      if (status !== 'building' && status !== 'queued') {
        status = 'failed';
      }
    }
  }

  return { deploymentId, status, serviceUrl, logUrl, dashboardUrl };
}
