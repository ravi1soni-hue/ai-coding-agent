"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleConfirmation = handleConfirmation;
const confirmationGate_1 = require("../../agents/confirmationGate");
const timeout_1 = require("../../utils/timeout");
const logger_1 = require("../../utils/logger");
const TIMEOUT_MS = 2000;
async function handleConfirmation(input) {
    (0, logger_1.debug)('handleConfirmation', { projectId: input.projectId });
    try {
        if (!input.clarifications) {
            throw new Error('Clarifications required for confirmation');
        }
        const result = await (0, timeout_1.withTimeout)((0, confirmationGate_1.confirmationGate)(input.clarifications), TIMEOUT_MS, 'Confirmation');
        (0, logger_1.debug)('handleConfirmation:done', { projectId: input.projectId });
        return { success: true, data: result };
    }
    catch (err) {
        (0, logger_1.error)('handleConfirmation', err);
        return {
            success: false,
            error: toMessage(err, 'Confirmation failed'),
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
