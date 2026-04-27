"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSocketServer = createSocketServer;
// Simple WebSocket server using ws
const ws_1 = require("ws");
function createSocketServer(server) {
    const wss = new ws_1.Server({ server });
    wss.on('connection', (ws) => {
        ws.send(JSON.stringify({ type: 'info', message: 'WebSocket connection established!' }));
        ws.on('message', async (message) => {
            let progress = 0;
            try {
                const userMsg = message.toString();
                // Step 1: Requirement Analysis
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Analyzing requirements...' }));
                const requirements = await require('../orchestration/langgraph').requirementAnalysisAgent({ user_message: userMsg });
                ws.send(JSON.stringify({ type: 'stream', token: `Requirements: ${JSON.stringify(requirements)}\n` }));
                // Step 2: Clarification
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Clarifying requirements...' }));
                const clarifications = await require('../orchestration/langgraph').clarificationAgent(requirements);
                ws.send(JSON.stringify({ type: 'stream', token: `Clarifications: ${JSON.stringify(clarifications)}\n` }));
                // Step 3: Confirmation Gate
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Confirming requirements...' }));
                const confirmation = await require('../orchestration/langgraph').confirmationGate(clarifications);
                ws.send(JSON.stringify({ type: 'stream', token: `Confirmation: ${JSON.stringify(confirmation)}\n` }));
                // Step 4: System Design
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Designing system...' }));
                const systemDesign = await require('../orchestration/langgraph').systemDesignAgent(requirements);
                ws.send(JSON.stringify({ type: 'stream', token: `System Design: ${JSON.stringify(systemDesign)}\n` }));
                // Step 5: Code Generation
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Generating code...' }));
                const codeGen = await require('../orchestration/langgraph').codeGenerationAgent(systemDesign);
                ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(codeGen)}\n` }));
                // Step 6: Test & Fix
                ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Testing and fixing...' }));
                const testResult = await require('../orchestration/langgraph').testFixAgent({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) });
                ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(testResult)}\n` }));
                // Step 7: Deployment
                ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying...' }));
                const deployment = await require('../orchestration/langgraph').deploymentAgent({ frontend: 'frontend', backend: 'backend' });
                ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(deployment)}\n` }));
                ws.send(JSON.stringify({ type: 'done' }));
            }
            catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: err?.message || 'AI process failed.' }));
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
