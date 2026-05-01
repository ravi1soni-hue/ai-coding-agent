"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSystemDesign = handleSystemDesign;
const systemDesignAgent_1 = require("../../agents/systemDesignAgent");
const timeout_1 = require("../../utils/timeout");
const logger_1 = require("../../utils/logger");
const TIMEOUT_MS = 10000;
async function handleSystemDesign(input) {
    (0, logger_1.debug)('handleSystemDesign', { projectId: input.projectId });
    try {
        const result = await (0, timeout_1.withTimeout)((0, systemDesignAgent_1.systemDesignAgent)(input.requirements), TIMEOUT_MS, 'System design');
        (0, logger_1.debug)('handleSystemDesign:done', { projectId: input.projectId });
        return { success: true, data: result };
    }
    catch (err) {
        (0, logger_1.error)('handleSystemDesign', err);
        return {
            success: false,
            error: toMessage(err, 'System design failed'),
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
