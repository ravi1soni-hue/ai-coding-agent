"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testFixAgent = testFixAgent;
// Test & Fix Agent: simulates build/test/fix loop
async function testFixAgent(input) {
    let retries = 0;
    let result;
    try {
        do {
            result = await input.buildFn();
            if (result.success)
                return { ...result, fixed: retries > 0 };
            retries++;
        } while (retries < 3);
        throw new Error('Build/test failed after 3 retries.');
    }
    catch (err) {
        return { success: false, logs: result?.logs || '', fixed: false, error: err?.message || String(err) };
    }
}
