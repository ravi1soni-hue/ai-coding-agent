"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRequirementAnalysis = handleRequirementAnalysis;
const requirementAnalysisAgent_1 = require("../../agents/requirementAnalysisAgent");
const timeout_1 = require("../../utils/timeout");
const logger_1 = require("../../utils/logger");
const TIMEOUT_MS = 5000;
async function handleRequirementAnalysis(input) {
    (0, logger_1.debug)('handleRequirementAnalysis', { projectId: input.projectId });
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const result = await (0, timeout_1.withTimeout)((0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: input.userMessage }), TIMEOUT_MS, 'Requirement analysis');
            (0, logger_1.debug)('handleRequirementAnalysis:done', { projectId: input.projectId });
            return { success: true, data: result };
        }
        catch (err) {
            if (attempt < MAX_ATTEMPTS) {
                (0, logger_1.debug)('handleRequirementAnalysis:retry', {
                    projectId: input.projectId,
                    attempt,
                    error: String(err?.message || err),
                });
                continue;
            }
            (0, logger_1.error)('handleRequirementAnalysis', err);
            return {
                success: false,
                error: `Requirement analysis failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Failed to analyze requirements')}. Next step: simplify the request or split it into smaller requirements and retry.`,
                fallback: null,
            };
        }
    }
    return {
        success: false,
        error: 'Requirement analysis failed after repeated attempts. Please retry.',
        fallback: null,
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
