"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDeployment = handleDeployment;
const deploymentAgent_1 = require("../../agents/deploymentAgent");
const logger_1 = require("../../utils/logger");
/**
 * Deployment is intentionally not wrapped in a hard timeout — Vercel/Railway
 * uploads can take several minutes for large projects. The underlying agent
 * already has its own HTTP timeouts per request.
 */
async function handleDeployment(input) {
    (0, logger_1.debug)('handleDeployment', { projectId: input.projectId });
    const MAX_ATTEMPTS = 2;
    if (!input.buildDir) {
        return { success: false, error: 'Deployment blocked: buildDir is required for deployment.' };
    }
    if (!input.revisionId) {
        return { success: false, error: 'Deployment blocked: revisionId is required for deployment.' };
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const result = await (0, deploymentAgent_1.deploymentAgent)({
                projectId: input.projectId,
                revisionId: input.revisionId,
                buildDir: input.buildDir,
                backendDir: input.backendDir,
                frontendProjectName: input.frontendProjectName,
                backendService: input.backendService,
                hasBackend: input.hasBackend,
            });
            (0, logger_1.debug)('handleDeployment:done', { projectId: input.projectId, url: result.frontend_url });
            return { success: true, data: result };
        }
        catch (err) {
            if (attempt < MAX_ATTEMPTS) {
                (0, logger_1.debug)('handleDeployment:retry', { projectId: input.projectId, attempt, error: String(err?.message || err) });
                continue;
            }
            (0, logger_1.error)('handleDeployment', err);
            return {
                success: false,
                error: `Deployment failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Deployment failed')}. Next step: verify deployment credentials, provider availability, and retry.`,
            };
        }
    }
    return {
        success: false,
        error: 'Deployment failed after repeated attempts. Please retry.',
    };
}
function toMessage(err, fallback) {
    const raw = String(err?.message || '').trim();
    if (!raw)
        return fallback;
    const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280)
        return fallback;
    return sanitized;
}
