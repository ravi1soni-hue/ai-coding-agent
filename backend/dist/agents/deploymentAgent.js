"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deploymentAgent = deploymentAgent;
const vercelDeploy_1 = require("./vercelDeploy");
const railwayDeploy_1 = require("../deploy/railwayDeploy");
async function deploymentAgent(input) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('[deploymentAgent] called with:', input);
    }
    try {
        if (!input.buildDir)
            throw new Error('buildDir required');
        if (!input.projectId)
            throw new Error('projectId required');
        if (!input.revisionId)
            throw new Error('revisionId required');
        const defaultProjectName = `proj-${input.projectId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 18) || 'site'}`;
        const vercelResult = await (0, vercelDeploy_1.deployToVercel)({
            buildDir: input.buildDir,
            projectName: input.frontendProjectName || defaultProjectName,
            meta: {
                projectId: input.projectId,
                revisionId: input.revisionId,
            },
        });
        const railwayResult = await (0, railwayDeploy_1.deployToRailway)(input.backendService, {
            source: 'deploymentAgent',
            projectId: input.projectId,
            revisionId: input.revisionId,
        });
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
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[deploymentAgent] error:', message);
        throw err;
    }
}
