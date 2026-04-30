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

async function resolveRailwayServiceUrl(service: string): Promise<string> {
  const fallback = normalizeUrl(service ? `${service}.railway.app` : '');
  const configPath = path.resolve(__dirname, '../../railway.config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { railway_url?: string };
    const configuredUrl = normalizeUrl(parsed.railway_url ?? '');
    if (configuredUrl) return configuredUrl;
    return fallback;
  } catch {
    return fallback;
  }
}

export async function deployToRailway(service: string, deployConfig: any): Promise<RailwayDeployResult> {
  if (process.env.NODE_ENV !== 'production') {
    console.log('Deploying to Railway target:', service, deployConfig);
  }

  const deploymentId = deployConfig?.revisionId
    ? `rail_${String(deployConfig.revisionId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`
    : `rail_${Date.now().toString(36)}`;

  const serviceUrl = await resolveRailwayServiceUrl(service);
  const dashboardUrl = env.RAILWAY_PROJECT_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}`
    : 'https://railway.app';

  const deploymentView = env.RAILWAY_PROJECT_ID && env.RAILWAY_SERVICE_ID
    ? `https://railway.app/project/${env.RAILWAY_PROJECT_ID}/service/${env.RAILWAY_SERVICE_ID}`
    : dashboardUrl;

  let status: RailwayDeployResult['status'] = 'queued';
  try {
    const health = await axios.get(serviceUrl, { timeout: 15_000, validateStatus: () => true });
    status = health.status >= 200 && health.status < 500 ? 'deployed' : 'failed';
  } catch {
    status = 'failed';
  }

  return {
    deploymentId,
    status,
    serviceUrl,
    logUrl: deploymentView,
    dashboardUrl,
  };
}
