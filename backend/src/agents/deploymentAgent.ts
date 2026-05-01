import axios from 'axios';
import fs from 'fs';
import { deployToVercel } from './vercelDeploy';
import { deployToRailway } from '../deploy/railwayDeploy';
import { debug, error as logError } from '../utils/logger';




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

    const vercelResult = await deployToVercel({
      buildDir: input.buildDir,
      projectName: input.frontendProjectName || defaultProjectName,
      meta: {
        projectId: input.projectId,
        revisionId: input.revisionId,
      },
    });

    const backendService = input.backendService || `backend-${input.projectId.slice(0, 10)}`;
    const backendRequested = input.hasBackend !== false;
    const backendDirLooksValid = Boolean(
      input.backendDir && fs.existsSync(input.backendDir) && fs.existsSync(`${input.backendDir}/package.json`),
    );

    const shouldDeployBackend = backendRequested && backendDirLooksValid;
    const railwayResult = shouldDeployBackend
      ? await deployToRailway(backendService, {
          source: 'deploymentAgent',
          projectId: input.projectId,
          revisionId: input.revisionId,
          sourceDir: input.backendDir,
        })
      : null;

    const result = {
      frontend_url: `https://${vercelResult.url}`,
      backend_url: railwayResult?.serviceUrl || null,
      vercel_deployment_id: vercelResult.deploymentId,
      vercel_inspect_url: vercelResult.inspectUrl,
      vercel_status: vercelResult.status,
      vercel_log_url: vercelResult.logUrl,
      railway_deployment_id: railwayResult?.deploymentId || null,
      railway_status: railwayResult?.status || (shouldDeployBackend ? 'failed' : 'skipped'),
      railway_log_url: railwayResult?.logUrl || null,
      railway_dashboard_url: railwayResult?.dashboardUrl || null,
      frontend_accessible: true,
      frontend_access_warning: null as string | null,
    };

    // Detect deployments protected by Vercel auth/SSO so UX can show a clear message.
    try {
      const probe = await axios.get(result.frontend_url, {
        timeout: 10_000,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      if (probe.status === 401 || probe.status === 403) {
        result.frontend_accessible = false;
        result.frontend_access_warning = 'Vercel deployment is protected by authentication (SSO/password). Disable Deployment Protection in Vercel to make the URL publicly accessible.';
      }
    } catch {
      // Ignore probe errors and keep deployment result as-is.
    }
    debug('deploymentAgent:result', { result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError('deploymentAgent', message);
    throw err;
  }
}
