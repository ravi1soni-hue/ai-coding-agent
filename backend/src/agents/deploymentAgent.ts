import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { deployToVercel } from './vercelDeploy';
import { deployToRailway } from '../deploy/railwayDeploy';
import { config as env } from '../config/env';
import { debug, error as logError, warn as logWarn } from '../utils/logger';

// ---------------------------------------------------------------------------
// DB Init — creates project schema then runs backend/db/init.sql inside it
// ---------------------------------------------------------------------------

async function runDbInitSql(backendDir: string, projectId: string): Promise<void> {
  const initSqlPath = path.join(backendDir, 'db', 'init.sql');
  if (!fs.existsSync(initSqlPath)) {
    debug('deploymentAgent:db-init', 'no init.sql found, skipping');
    return;
  }

  const sql = fs.readFileSync(initSqlPath, 'utf8').trim();
  if (!sql || sql.startsWith('--')) {
    debug('deploymentAgent:db-init', 'init.sql empty or comment-only, skipping');
    return;
  }

  const postgresUrl = env.POSTGRES_URL || env.DATABASE_URL;
  if (!postgresUrl) {
    logWarn('deploymentAgent:db-init', 'DATABASE_URL/POSTGRES_URL not set, skipping DB init');
    return;
  }

  // Sanitize projectId so it can safely be used in an identifier
  const schemaName = `proj_${projectId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48)}`;
  const pool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 15_000 });
  try {
    // Create the per-project schema if it doesn't exist, then run init.sql within it
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}, public`);
    await pool.query(sql);
    debug('deploymentAgent:db-init', { schemaName, message: 'DB schema + tables initialized successfully' });
  } catch (err) {
    logWarn('deploymentAgent:db-init-error', {
      message: (err as Error).message,
      hint: 'Tables may already exist — this is usually safe to ignore',
    });
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function deploymentAgent(input: {
  projectId: string;
  revisionId: string;
  buildDir: string;
  backendDir?: string;
  workspaceRoot?: string;
  frontendProjectName?: string;
  backendService?: string;
  hasBackend?: boolean;
}) {
  debug('deploymentAgent', { input });
  try {
    if (!input.buildDir) throw new Error('buildDir required');
    if (!input.projectId) throw new Error('projectId required');
    if (!input.revisionId) throw new Error('revisionId required');
    if (!input.workspaceRoot) throw new Error('workspaceRoot required');

    const defaultProjectName = `proj-${input.projectId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 18) || 'site'}`;
    const schemaName = `proj_${input.projectId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48)}`;
    debug('deploymentAgent:workspaceRoot', { projectId: input.projectId, workspaceRoot: input.workspaceRoot });

    // ── Backend: deploy first so we have the URL before building the frontend ──
    const backendService = input.backendService || `backend-${input.projectId.slice(0, 10)}`;
    const backendRequested = input.hasBackend !== false;

    const backendDirValid = Boolean(
      input.backendDir &&
      fs.existsSync(input.backendDir) &&
      fs.existsSync(path.join(input.backendDir, 'package.json'))
    );

    const shouldDeployBackend = backendRequested && backendDirValid;

    if (shouldDeployBackend && input.backendDir) {
      // Create project schema + init tables before deploying the backend service
      await runDbInitSql(input.backendDir, input.projectId);
    }

    let railwayResult: Awaited<ReturnType<typeof deployToRailway>> | null = null;
    if (shouldDeployBackend && input.backendDir) {
      try {
        railwayResult = await deployToRailway(backendService, {
          source: 'deploymentAgent',
          projectId: input.projectId,
          revisionId: input.revisionId,
          sourceDir: input.backendDir,
          extraEnvVars: {
            DB_SCHEMA: schemaName,
            PROJECT_ID: input.projectId,
          },
        });
      } catch (railwayErr) {
        logWarn('deploymentAgent:railway-failed', {
          message: (railwayErr as Error).message,
          hint: 'Frontend deployment will still complete. Railway can be redeployed separately.',
        });
      }
    }

    // ── Write env-config.js into dist/ so the frontend knows the backend URL ──
    // This must happen after Railway deploy (so we have the serviceUrl) and
    // before Vercel upload (so the file is included in the deployment bundle).
    const backendUrl = railwayResult?.serviceUrl || '';
    const envConfigPath = path.join(input.buildDir, 'env-config.js');
    try {
      const envConfigContent = `window.__ENV__ = { API_URL: '${backendUrl}', PROJECT_ID: '${input.projectId}' };`;
      fs.writeFileSync(envConfigPath, envConfigContent, 'utf8');
      debug('deploymentAgent:env-config-written', { envConfigPath, backendUrl });
    } catch (err) {
      logWarn('deploymentAgent:env-config-write-failed', (err as Error).message);
    }

    // ── Frontend: deploy to Vercel (with env-config.js in dist/), failover to Railway ──
    let frontendResult: { url: string; deploymentId: string; inspectUrl: string | null; status: string; logUrl: string | null } | null = null;
    try {
      frontendResult = await deployToVercel({
        buildDir: input.buildDir,
        projectName: input.frontendProjectName || defaultProjectName,
        meta: { projectId: input.projectId, revisionId: input.revisionId },
      });
    } catch (vercelErr) {
      logWarn('deploymentAgent:vercel-failed', { message: (vercelErr as Error).message });
      try {
        const railwayFrontend = await deployToRailway(`frontend-${input.projectId.slice(0, 10)}`, {
          source: 'deploymentAgent-failover',
          projectId: input.projectId,
          revisionId: input.revisionId,
          sourceDir: input.buildDir,
        });
        frontendResult = {
          url: railwayFrontend.serviceUrl.replace(/^https?:\/\//, ''),
          deploymentId: railwayFrontend.deploymentId,
          inspectUrl: railwayFrontend.logUrl,
          status: railwayFrontend.status,
          logUrl: railwayFrontend.logUrl,
        };
        debug('deploymentAgent:railway-failover-success', { url: frontendResult.url });
      } catch (railwayErr) {
        logError('deploymentAgent:failover-failed', { vercel: (vercelErr as Error).message, railway: (railwayErr as Error).message });
        throw new Error('Both Vercel and Railway deployments failed for frontend');
      }
    }

    if (!frontendResult) {
      throw new Error('Frontend deployment failed to produce a result.');
    }
    if (!frontendResult.url) {
      throw new Error('Frontend deployment succeeded but did not return a URL.');
    }

    const result = {
      frontend_url: `https://${frontendResult.url}`,
      backend_url: railwayResult?.serviceUrl || null,
      vercel_deployment_id: frontendResult.deploymentId.startsWith('rail_') ? null : frontendResult.deploymentId,
      vercel_inspect_url: frontendResult.inspectUrl,
      vercel_status: frontendResult.status,
      vercel_log_url: frontendResult.logUrl,
      railway_deployment_id: railwayResult?.deploymentId || (frontendResult.deploymentId.startsWith('rail_') ? frontendResult.deploymentId : null),
      railway_status: railwayResult?.status || (frontendResult.deploymentId.startsWith('rail_') ? frontendResult.status : (shouldDeployBackend ? 'deploy_error' : 'skipped')),
      railway_log_url: railwayResult?.logUrl || (frontendResult.deploymentId.startsWith('rail_') ? frontendResult.logUrl : null),
      railway_dashboard_url: railwayResult?.dashboardUrl || null,
      frontend_accessible: true,
      frontend_access_warning: null as string | null,
    };

    // Probe Vercel URL for SSO/password protection
    try {
      const probe = await axios.get(result.frontend_url, {
        timeout: 12_000,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      if (probe.status === 401 || probe.status === 403) {
        result.frontend_accessible = false;
        result.frontend_access_warning =
          'Vercel deployment is protected by authentication (SSO/password). ' +
          'Disable Deployment Protection in Vercel settings to make the URL public.';
      }
    } catch {
      // Ignore probe errors — deployment is still valid
    }

    debug('deploymentAgent:result', { result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError('deploymentAgent', message);
    throw err;
  }
}
