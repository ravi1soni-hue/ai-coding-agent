"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCodeGeneration = handleCodeGeneration;
const codeGenerationAgent_1 = require("../../agents/codeGenerationAgent");
const timeout_1 = require("../../utils/timeout");
const logger_1 = require("../../utils/logger");
const TIMEOUT_MS = 300000;
async function handleCodeGeneration(input) {
    (0, logger_1.debug)('handleCodeGeneration', { projectId: input.projectId });
    try {
        const result = await (0, timeout_1.withTimeout)((0, codeGenerationAgent_1.codeGenerationAgent)({
            systemDesign: input.systemDesign,
            requirements: input.requirements,
            modification: input.modification,
            context: input.context,
        }), TIMEOUT_MS, 'Code generation');
        (0, logger_1.debug)('handleCodeGeneration:done', { projectId: input.projectId });
        return { success: true, data: result };
    }
    catch (err) {
        (0, logger_1.error)('handleCodeGeneration', err);
        return {
            success: false,
            error: toMessage(err, 'Code generation failed'),
            fallback: null,
        };
    }
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
