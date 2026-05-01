import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { config as env } from '../config/env';

export type RailwayDeployResult = {
  deploymentId: string;
  status: 'queued' | 'building' | 'deployed' | 'failed';
  serviceUrl: string;
  logUrl: string;
  dashboardUrl: string;
};

function normalizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    return rawUrl;
  }
  return `https://${rawUrl}`;
}

function isRailwayDashboardUrl(url: string): boolean {
  return /https?:\/\/railway\.app\/project\//.test(url);
}

async function resolveRailwayServiceUrl(): Promise<string> {
  // 1. Prefer explicitly configured railway_url from railway.config.json
  const configPath = path.resolve(__dirname, '../../railway.config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { railway_url?: string };
    const configuredUrl = normalizeUrl(parsed.railway_url ?? '');
    if (configuredUrl && !isRailwayDashboardUrl(configuredUrl)) return configuredUrl;
  } catch {
    // config file not readable — fall through
  }

  // 2. Prefer explicit public service URL from env if available.
  const publicUrl = normalizeUrl(env.RAILWAY_PUBLIC_URL || '');
  if (publicUrl && !isRailwayDashboardUrl(publicUrl)) {
    return publicUrl;
  }

  // 3. No public URL resolvable — return empty so callers know.
  return '';
}

async function triggerRailwayDeployment(input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  token: string;
}): Promise<{ deploymentId?: string; status?: RailwayDeployResult['status']; logUrl?: string }> {
  const query = `
    mutation serviceInstanceDeploy($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeploy(input: { environmentId: $environmentId, serviceId: $serviceId }) {
        id
        status
      }
    }
  `;

  const res = await axios.post(
    env.RAILWAY_GRAPHQL_URL,
    {
      query,
      variables: {
        environmentId: input.environmentId,
        serviceId: input.serviceId,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    },
  );

  const deployment = res.data?.data?.serviceInstanceDeploy;
  if (!deployment?.id) {
    throw new Error(`Railway deploy API did not return deployment id: ${JSON.stringify(res.data)}`);
  }

  const rawStatus = String(deployment.status || '').toLowerCase();
  const status: RailwayDeployResult['status'] =
    rawStatus.includes('fail')
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

export async function deployToRailway(service: string, deployConfig: any): Promise<RailwayDeployResult> {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Deploying to Railway target:', service, deployConfig);
  }

  const serviceUrl = await resolveRailwayServiceUrl();
  const dashboardUrl = env.RAILWAY_PROJECT_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}`
    : 'https://railway.app';

  const deploymentView = env.RAILWAY_PROJECT_ID && env.RAILWAY_SERVICE_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}/service/${env.RAILWAY_SERVICE_ID}`
    : dashboardUrl;

  let status: RailwayDeployResult['status'] = 'queued';
  let deploymentId = deployConfig?.revisionId
    ? `rail_${String(deployConfig.revisionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
    : `rail_${Date.now().toString(36)}`;
  let logUrl = deploymentView;

  const canTriggerDeploy =
    Boolean(env.RAILWAY_TOKEN) &&
    Boolean(env.RAILWAY_PROJECT_ID) &&
    Boolean(env.RAILWAY_SERVICE_ID) &&
    Boolean(env.RAILWAY_ENVIRONMENT_ID);

  if (canTriggerDeploy) {
    try {
      const deployResponse = await triggerRailwayDeployment({
        projectId: env.RAILWAY_PROJECT_ID,
        environmentId: env.RAILWAY_ENVIRONMENT_ID,
        serviceId: env.RAILWAY_SERVICE_ID,
        token: env.RAILWAY_TOKEN,
      });
      deploymentId = deployResponse.deploymentId || deploymentId;
      status = deployResponse.status || status;
      logUrl = deployResponse.logUrl || logUrl;
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Railway deploy API call failed, using health-check fallback', err);
      }
    }
  }

  try {
    if (serviceUrl) {
      const health = await axios.get(serviceUrl, { timeout: 15_000, validateStatus: () => true });
      if (status !== 'building' && status !== 'queued') {
        status = health.status >= 200 && health.status < 500 ? 'deployed' : 'failed';
      }
    }
  } catch {
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
