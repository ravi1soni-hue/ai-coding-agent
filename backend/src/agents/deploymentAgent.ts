import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { deployToVercel } from './vercelDeploy';
import { deployToRailway } from '../deploy/railwayDeploy';
import { config as env } from '../config/env';
import { debug, error as logError, warn as logWarn } from '../utils/logger';

// ---------------------------------------------------------------------------
// DB Init — runs backend/db/init.sql against the shared Postgres instance
// ---------------------------------------------------------------------------

async function runDbInitSql(backendDir: string): Promise<void> {
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

  const postgresUrl = env.POSTGRES_URL;
  if (!postgresUrl) {
    logWarn('deploymentAgent:db-init', 'POSTGRES_URL not set, skipping DB init');
    return;
  }

  const pool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 15_000 });
  try {
    await pool.query(sql);
    debug('deploymentAgent:db-init', 'DB tables initialized successfully');
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
  frontendProjectName?: string;
  backendService?: string;
  hasBackend?: boolean;
}) {
  debug('deploymentAgent', { input });
  try {
    if (!input.buildDir) throw new Error('buildDir required');
    if (!input.projectId) throw new Error('projectId required');
    if (!input.revisionId) throw new Error('revisionId required');

    const defaultProjectName = `proj-${input.projectId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 18) || 'site'}`;

    // ── Frontend: deploy to Vercel ──────────────────────────────────────────
    const vercelResult = await deployToVercel({
      buildDir: input.buildDir,
      projectName: input.frontendProjectName || defaultProjectName,
      meta: { projectId: input.projectId, revisionId: input.revisionId },
    });

    // ── Backend: deploy to Railway (conditional) ────────────────────────────
    const backendService = input.backendService || `backend-${input.projectId.slice(0, 10)}`;
    const backendRequested = input.hasBackend !== false;

    // Verify backend directory has the needed files
    const backendDirValid = Boolean(
      input.backendDir &&
      fs.existsSync(input.backendDir) &&
      fs.existsSync(path.join(input.backendDir, 'package.json'))
    );

    const shouldDeployBackend = backendRequested && backendDirValid;

    if (shouldDeployBackend && input.backendDir) {
      // Run DB init SQL before deploying so tables exist when backend starts
      await runDbInitSql(input.backendDir);
    }

    let railwayResult: Awaited<ReturnType<typeof deployToRailway>> | null = null;
    if (shouldDeployBackend && input.backendDir) {
      try {
        railwayResult = await deployToRailway(backendService, {
          source: 'deploymentAgent',
          projectId: input.projectId,
          revisionId: input.revisionId,
          sourceDir: input.backendDir,
        });
      } catch (railwayErr) {
        logWarn('deploymentAgent:railway-failed', {
          message: (railwayErr as Error).message,
          hint: 'Frontend deployment will still complete. Railway can be redeployed separately.',
        });
      }
    }

    if (!vercelResult.url) {
      throw new Error('Vercel deployment succeeded but did not return a frontend URL.');
    }

    const result = {
      frontend_url: `https://${vercelResult.url}`,
      backend_url: railwayResult?.serviceUrl || null,
      vercel_deployment_id: vercelResult.deploymentId,
      vercel_inspect_url: vercelResult.inspectUrl,
      vercel_status: vercelResult.status,
      vercel_log_url: vercelResult.logUrl,
      railway_deployment_id: railwayResult?.deploymentId || null,
      railway_status: railwayResult?.status || (shouldDeployBackend ? 'deploy_error' : 'skipped'),
      railway_log_url: railwayResult?.logUrl || null,
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
