"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deploymentAgent = deploymentAgent;
// Deployment Agent: simulates deployment and returns URLs
async function deploymentAgent(input) {
    // In production, deploy using Railway/Vercel APIs
    // Here, return sample URLs
    return {
        frontend_url: `https://${input.frontend}.vercel.app`,
        backend_url: `https://${input.backend}.railway.app`,
    };
}
