"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSocketServer = createSocketServer;
// Simple WebSocket server using ws
const ws_1 = require("ws");
const requirementAnalysisAgent_1 = require("../agents/requirementAnalysisAgent");
const clarificationAgent_1 = require("../agents/clarificationAgent");
const confirmationGate_1 = require("../agents/confirmationGate");
const systemDesignAgent_1 = require("../agents/systemDesignAgent");
const codeGenerationAgent_1 = require("../agents/codeGenerationAgent");
const testFixAgent_1 = require("../agents/testFixAgent");
const deploymentAgent_1 = require("../agents/deploymentAgent");
function createSocketServer(server) {
    const wss = new ws_1.Server({ server });
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'info', message: 'WebSocket connection established!' }));
        ws.on('message', async (message) => {
            let progress = 0;
            try {
                const userMsg = message.toString();
                // Step 1: Requirement Analysis
                console.log('[socket] Step 1: Requirement Analysis start', { userMsg });
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Analyzing requirements...' }));
                let requirements;
                try {
                    requirements = await (0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: userMsg });
                    console.log('[socket] Step 1: Requirement Analysis result', requirements);
                    ws.send(JSON.stringify({ type: 'stream', token: `Requirements: ${JSON.stringify(requirements)}\n` }));
                }
                catch (err) {
                    console.error('[socket] Step 1: Requirement Analysis error', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'Requirement analysis failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                // Step 2: Clarification
                console.log('[socket] Step 2: Clarification start', { requirements });
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Clarifying requirements...' }));
                let clarifications;
                try {
                    clarifications = await (0, clarificationAgent_1.clarificationAgent)(requirements);
                    console.log('[socket] Step 2: Clarification result', clarifications);
                    ws.send(JSON.stringify({ type: 'stream', token: `Clarifications: ${JSON.stringify(clarifications)}\n` }));
                }
                catch (err) {
                    console.error('[socket] Step 2: Clarification error', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'Clarification failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                // Step 3: Confirmation Gate
                console.log('[socket] Step 3: Confirmation Gate start', { clarifications });
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Confirming requirements...' }));
                let confirmation;
                try {
                    confirmation = await (0, confirmationGate_1.confirmationGate)(clarifications);
                    console.log('[socket] Step 3: Confirmation Gate result', confirmation);
                    ws.send(JSON.stringify({ type: 'stream', token: `Confirmation: ${JSON.stringify(confirmation)}\n` }));
                }
                catch (err) {
                    console.error('[socket] Step 3: Confirmation Gate error', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'Confirmation failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                // Step 4: System Design
                console.log('[socket] Step 4: System Design start', { requirements });
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Designing system...' }));
                let systemDesign;
                try {
                    systemDesign = await (0, systemDesignAgent_1.systemDesignAgent)(requirements);
                    console.log('[socket] Step 4: System Design result', systemDesign);
                    ws.send(JSON.stringify({ type: 'stream', token: `System Design: ${JSON.stringify(systemDesign)}\n` }));
                }
                catch (err) {
                    console.error('[socket] Step 4: System Design error', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'System design failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                // Step 5: Code Generation
                console.log('[socket] Step 5: Code Generation start', { systemDesign });
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Generating code...' }));
                let codeGen;
                try {
                    codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)(systemDesign);
                    console.log('[socket] Step 5: Code Generation result', codeGen);
                    ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(codeGen)}\n` }));
                }
                catch (err) {
                    console.error('[socket] Step 5: Code Generation error', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'Code generation failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                // Step 6: Test & Fix
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Testing and fixing...' }));
                let testResult;
                try {
                    testResult = await (0, testFixAgent_1.testFixAgent)({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) });
                    ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(testResult)}\n` }));
                }
                catch (err) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'Test/fix failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                // Step 7: Deployment
                ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying...' }));
                let deployment;
                try {
                    deployment = await (0, deploymentAgent_1.deploymentAgent)({ frontend: 'frontend', backend: 'backend' });
                    ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(deployment)}\n` }));
                }
                catch (err) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: err?.message || 'Deployment failed.',
                        error: {
                            name: err?.name,
                            stack: err?.stack,
                            details: err
                        }
                    }));
                    return;
                }
                ws.send(JSON.stringify({ type: 'done' }));
            }
            catch (err) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: err?.message || 'AI process failed.',
                    error: {
                        name: err?.name,
                        stack: err?.stack,
                        details: err
                    }
                }));
            }
        });
    });
    return wss;
}
async function runStep(fn, ws, status) {
    try {
        return await fn();
    }
    catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: status + ' failed: ' + (err?.message || err) }));
        throw err;
    }
}
