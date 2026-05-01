"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleClarification = handleClarification;
const clarificationAgent_1 = require("../../agents/clarificationAgent");
const timeout_1 = require("../../utils/timeout");
const logger_1 = require("../../utils/logger");
const TIMEOUT_MS = 3000;
async function handleClarification(input) {
    (0, logger_1.debug)('handleClarification', { projectId: input.projectId });
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const result = await (0, timeout_1.withTimeout)((0, clarificationAgent_1.clarificationAgent)({
                requirements: input.requirements,
                clarificationAnswers: input.clarificationAnswers,
                askedQuestions: input.askedQuestions,
                modification: input.modification,
                lastQuestion: input.lastQuestion,
                lastAnswer: input.lastAnswer,
            }), TIMEOUT_MS, 'Clarification');
            (0, logger_1.debug)('handleClarification:done', { projectId: input.projectId });
            return { success: true, data: result };
        }
        catch (err) {
            if (attempt < MAX_ATTEMPTS) {
                (0, logger_1.debug)('handleClarification:retry', { projectId: input.projectId, attempt, error: String(err?.message || err) });
                continue;
            }
            (0, logger_1.error)('handleClarification', err);
            return {
                success: false,
                error: `Clarification failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Clarification failed')}. Next step: review the prompt or clarification answers and retry.`,
            };
        }
    }
    return {
        success: false,
        error: 'Clarification failed after repeated attempts. Please retry.',
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
