"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTestFix = handleTestFix;
const testFixAgent_1 = require("../../agents/testFixAgent");
const logger_1 = require("../../utils/logger");
/**
 * testFix is intentionally not wrapped in a hard timeout because the build
 * worker itself can take several minutes. The agent already retries up to 3
 * times internally. Callers that need a ceiling should wrap the returned
 * promise themselves.
 */
async function handleTestFix(input) {
    (0, logger_1.debug)('handleTestFix', { projectId: input.projectId });
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const result = await (0, testFixAgent_1.testFixAgent)({
                buildFn: input.buildFn,
                fixFn: input.fixFn,
                files: input.files,
                workspaceDir: input.workspaceDir,
            });
            (0, logger_1.debug)('handleTestFix:done', { projectId: input.projectId, success: result.success });
            return { success: true, data: result };
        }
        catch (err) {
            if (attempt < MAX_ATTEMPTS) {
                (0, logger_1.debug)('handleTestFix:retry', { projectId: input.projectId, attempt, error: String(err?.message || err) });
                continue;
            }
            (0, logger_1.error)('handleTestFix', err);
            return {
                success: false,
                error: `Test/fix failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Test/fix failed')}. Next step: inspect the build logs, correct any dependency or compilation issues, and retry.`,
            };
        }
    }
    return {
        success: false,
        error: 'Test/fix failed after repeated attempts. Please retry.',
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
