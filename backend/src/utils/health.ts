import axios from 'axios';
import { getPgPool } from '../db/postgres';
import { config } from '../config/env';

export type HealthStatus = {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    database: boolean;
    llm_proxy: boolean;
    vercel_api: boolean;
    railway_api: boolean;
  };
  timestamp: string;
};

export async function performHealthChecks(): Promise<HealthStatus> {
  const checks = {
    database: false,
    llm_proxy: false,
    vercel_api: false,
    railway_api: false,
  };

  // Database check
  try {
    const pool = getPgPool();
    await pool.query('SELECT 1');
    checks.database = true;
  } catch {}

  // LLM proxy check
  try {
    await axios.get(config.LLM_PROXY_CHAT_URL, { timeout: 5000 });
    checks.llm_proxy = true;
  } catch {}

  // Vercel API check
  if (config.VERCEL_ACCESS_TOKEN) {
    try {
      await axios.get('https://api.vercel.com/v1/user', {
        headers: { Authorization: `Bearer ${config.VERCEL_ACCESS_TOKEN}` },
        timeout: 5000,
      });
      checks.vercel_api = true;
    } catch {}
  } else {
    checks.vercel_api = true; // Not configured, consider healthy
  }

  // Railway API check
  if (config.RAILWAY_TOKEN) {
    try {
      await axios.post('https://backboard.railway.app/graphql/v2', {
        query: '{ me { id } }',
      }, {
        headers: { Authorization: `Bearer ${config.RAILWAY_TOKEN}` },
        timeout: 5000,
      });
      checks.railway_api = true;
    } catch {}
  } else {
    checks.railway_api = true; // Not configured, consider healthy
  }

  const allHealthy = Object.values(checks).every(Boolean);
  const someFailed = Object.values(checks).some(v => !v);

  const overall = allHealthy ? 'healthy' : someFailed ? 'degraded' : 'unhealthy';

  return {
    overall,
    checks,
    timestamp: new Date().toISOString(),
  };
}
