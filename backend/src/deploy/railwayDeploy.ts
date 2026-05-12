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

// ---------------------------------------------------------------------------
// Per-project Railway service management
// — Each generated project gets its own Railway service so user deployments
//   never touch or retrigger our base backend service.
// ---------------------------------------------------------------------------

async function findProjectService(userProjectId: string): Promise<string | null> {
  if (!env.RAILWAY_PROJECT_ID || !env.RAILWAY_TOKEN) return null;
  const serviceName = `gen-${userProjectId.slice(0, 12)}`;
  try {
    const data = await railwayGraphql(
      `query($projectId: String!) {
        project(id: $projectId) {
          services { edges { node { id name } } }
        }
      }`,
      { projectId: env.RAILWAY_PROJECT_ID }
    );
    const edges: any[] = data?.project?.services?.edges || [];
    const found = edges.find((e: any) => e.node?.name === serviceName);
    return found?.node?.id || null;
  } catch {
    return null;
  }
}

async function createProjectService(userProjectId: string): Promise<string | null> {
  if (!env.RAILWAY_PROJECT_ID || !env.RAILWAY_TOKEN) return null;
  const serviceName = `gen-${userProjectId.slice(0, 12)}`;
  try {
    const data = await railwayGraphql(
      `mutation($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id name }
      }`,
      { input: { projectId: env.RAILWAY_PROJECT_ID, name: serviceName } }
    );
    debug('railwayDeploy:serviceCreated', { serviceName, id: data?.serviceCreate?.id });
    return data?.serviceCreate?.id || null;
  } catch (err) {
    logWarn('railwayDeploy:serviceCreate-failed', (err as Error).message);
    return null;
  }
}

async function getOrCreateProjectService(userProjectId: string): Promise<string | null> {
  const existing = await findProjectService(userProjectId);
  if (existing) return existing;
  return createProjectService(userProjectId);
}

/**
 * Upserts environment variables on a specific Railway service so the generated
 * backend has POSTGRES_URL, PORT, NODE_ENV, DB_SCHEMA, and PROJECT_ID when it starts.
 * Uses the per-project service ID, never the base app's RAILWAY_SERVICE_ID.
 */
async function setRailwayEnvVars(serviceId: string, extraVars: Record<string, string> = {}): Promise<void> {
  const canSet =
    Boolean(env.RAILWAY_TOKEN) &&
    Boolean(env.RAILWAY_PROJECT_ID) &&
    Boolean(serviceId) &&
    Boolean(env.RAILWAY_ENVIRONMENT_ID);

  if (!canSet) {
    logWarn('railwayDeploy:setEnvVars', 'Missing Railway config, skipping env var injection');
    return;
  }

  const variables: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: '3000',
    ...extraVars,
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
      serviceId,
      variables,
    });
    debug('railwayDeploy:envVarsSet', { serviceId, keys: Object.keys(variables) });
  } catch (err) {
    logWarn('railwayDeploy:setEnvVars-failed', (err as Error).message);
  }
}

/**
 * Triggers a deployment on the per-project Railway service via CLI.
 * Passes RAILWAY_SERVICE_ID as env var so the CLI targets the correct service,
 * not the base backend service.
 */
async function runRailwayCliDeploy(sourceDir: string, serviceId: string): Promise<{
  deploymentId: string;
  status: RailwayDeployResult['status'];
  serviceUrl: string;
  logUrl: string;
}> {
  const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (serviceId) childEnv.RAILWAY_SERVICE_ID = serviceId;

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const child = spawn('railway', ['up', '--detach'], {
      cwd: sourceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ stdout, stderr: `${stderr}\nTimed out`, exitCode: 124 }); }, 180_000);
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 }); });
    child.on('error', err => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}\n${err}`, exitCode: 1 }); });
  });

  const urlMatch = result.stdout.match(/https?:\/\/[\w.-]+\.railway\.app/);
  return {
    deploymentId: `railway-cli-${Date.now().toString(36)}`,
    status: result.exitCode === 0 ? 'building' : 'failed',
    serviceUrl: urlMatch?.[0] || '',
    logUrl: env.RAILWAY_PROJECT_ID
      ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}/service/${serviceId}`
      : 'https://railway.app',
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
    extraEnvVars?: Record<string, string>;
  }
): Promise<RailwayDeployResult> {
  const userProjectId = deployConfig.projectId || '';
  debug('railwayDeploy:start', { service, userProjectId, sourceDir: deployConfig.sourceDir });

  const dashboardUrl = env.RAILWAY_PROJECT_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}`
    : 'https://railway.app';

  let status: RailwayDeployResult['status'] = 'queued';
  let deploymentId = deployConfig.revisionId
    ? `rail_${String(deployConfig.revisionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
    : `rail_${Date.now().toString(36)}`;
  let serviceUrl = '';
  let logUrl = dashboardUrl;

  // ── Step 1: Get or create an isolated Railway service for this user project ─
  // Never reuse env.RAILWAY_SERVICE_ID — that belongs to our base app.
  const projectServiceId = userProjectId
    ? await getOrCreateProjectService(userProjectId)
    : null;

  const targetServiceId = projectServiceId || '';

  const perServiceLogUrl = targetServiceId && env.RAILWAY_PROJECT_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}/service/${targetServiceId}`
    : dashboardUrl;
  logUrl = perServiceLogUrl;

  // ── Step 2: Inject env vars on the per-project service ───────────────────
  if (targetServiceId) {
    await setRailwayEnvVars(targetServiceId, deployConfig.extraEnvVars || {});
  }

  // ── Step 3: Deploy via Railway CLI with per-project RAILWAY_SERVICE_ID ───
  if (deployConfig.sourceDir) {
    try {
      const cliResult = await runRailwayCliDeploy(deployConfig.sourceDir, targetServiceId);
      deploymentId = cliResult.deploymentId || deploymentId;
      status = cliResult.status || status;
      serviceUrl = cliResult.serviceUrl || serviceUrl;
      logUrl = cliResult.logUrl || logUrl;
      debug('railwayDeploy:cli-result', { status, deploymentId, targetServiceId });
    } catch (err) {
      logWarn('railwayDeploy:cli-failed', (err as Error).message);
    }
  }

  // ── Step 4: Health check to confirm service is reachable ─────────────────
  const resolvedUrl = serviceUrl || await resolveRailwayServiceUrl();
  if (resolvedUrl) {
    try {
      const health = await axios.get(resolvedUrl, { timeout: 20_000, validateStatus: () => true });
      if (status !== 'building' && status !== 'queued') {
        status = health.status >= 200 && health.status < 500 ? 'deployed' : 'failed';
      }
      debug('railwayDeploy:health-check', { httpStatus: health.status, deployStatus: status });
    } catch {
      if (status !== 'building' && status !== 'queued') status = 'failed';
    }
  }

  return { deploymentId, status, serviceUrl: resolvedUrl, logUrl, dashboardUrl };
}
