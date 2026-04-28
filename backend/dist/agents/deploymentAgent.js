"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deploymentAgent = deploymentAgent;
const vercelDeploy_1 = require("./vercelDeploy");
async function deploymentAgent(input) {
    console.log('[deploymentAgent] called with:', input);
    try {
        if (!input.frontend)
            throw new Error('frontend required');
        // Deploy frontend to Vercel
        const vercelResult = await (0, vercelDeploy_1.deployToVercel)({ buildDir: '../../frontend', projectName: input.frontend });
        // Backend deployment (Railway) is still static for now
        const result = {
            frontend_url: `https://${vercelResult.url}`,
            backend_url: `https://${input.backend}.railway.app`,
            vercel_deployment_id: vercelResult.deploymentId,
            vercel_inspect_url: vercelResult.inspectUrl
        };
        console.log('[deploymentAgent] result:', result);
        return result;
    }
    catch (err) {
        console.error('[deploymentAgent] error:', err);
        throw err;
    }
}
