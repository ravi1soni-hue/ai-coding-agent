"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.error = exports.warn = exports.debug = void 0;
/**
 * Centralised debug logger. Emits nothing unless DEBUG=true is set in the
 * environment, keeping log volume well below Railway's 500 logs/sec limit in
 * production while still being useful during local development.
 */
const debug = (label, data) => {
    if (process.env.DEBUG === 'true') {
        // eslint-disable-next-line no-console
        console.log(`[${label}]`, data !== undefined ? data : '');
    }
};
exports.debug = debug;
const warn = (label, data) => {
    // Warnings are always emitted — they indicate degraded behaviour, not
    // routine progress, so the volume stays low.
    // eslint-disable-next-line no-console
    console.warn(`[${label}]`, data !== undefined ? data : '');
};
exports.warn = warn;
const error = (label, data) => {
    // Errors are always emitted.
    // eslint-disable-next-line no-console
    console.error(`[${label}]`, data !== undefined ? data : '');
};
exports.error = error;
