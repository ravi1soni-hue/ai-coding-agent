import { deployToVercel } from './vercelDeploy';
import { deployToRailway } from '../deploy/railwayDeploy';

export async function deploymentAgent(input: { frontend: string; backend: string }) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[deploymentAgent] called with:', input);
  }
  try {
    if (!input.frontend) throw new Error('frontend required');
    // Deploy frontend to Vercel
    const vercelResult = await deployToVercel({ buildDir: '../../frontend', projectName: input.frontend });
    // Deploy backend to Railway and capture artifact metadata
    const railwayResult = await deployToRailway(input.backend, { source: 'deploymentAgent' });

    const result = {
      frontend_url: `https://${vercelResult.url}`,
      backend_url: railwayResult.serviceUrl,
      vercel_deployment_id: vercelResult.deploymentId,
      vercel_inspect_url: vercelResult.inspectUrl,
      vercel_status: vercelResult.status,
      vercel_log_url: vercelResult.logUrl,
      railway_deployment_id: railwayResult.deploymentId,
      railway_status: railwayResult.status,
      railway_log_url: railwayResult.logUrl,
      railway_dashboard_url: railwayResult.dashboardUrl,
    };
    if (process.env.NODE_ENV !== 'production') {
      console.log('[deploymentAgent] result:', result);
    }
    return result;
  } catch (err) {
    console.error('[deploymentAgent] error:', err);
    throw err;
  }
}
