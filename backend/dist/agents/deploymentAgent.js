"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deploymentAgent = deploymentAgent;
// Deployment Agent: simulates deployment and returns URLs
async function deploymentAgent(input) {
    try {
        if (!input.frontend || !input.backend)
            throw new Error('frontend and backend required');
        // In production, deploy using Railway/Vercel APIs
        // Here, return sample URLs
        return {
            frontend_url: `https://${input.frontend}.vercel.app`,
            backend_url: `https://${input.backend}.railway.app`,
        };
    }
    catch (err) {
        throw err;
    }
}
