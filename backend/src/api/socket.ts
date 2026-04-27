// Simple WebSocket server using ws
import { Server } from 'ws';
import http from 'http';
import { runOrchestration } from '../orchestration/langgraph';

export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'info', message: 'WebSocket connection established!' }));

    ws.on('message', async (message) => {
      try {
        const userMsg = message.toString();
        let progress = 0;
        // Step 1: Requirement Analysis
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Analyzing requirements...' }));
        const requirements = await runStep(async () => await require('../orchestration/langgraph').requirementAnalysisAgent({ user_message: userMsg }), ws, 'Extracting requirements...');
        ws.send(JSON.stringify({ type: 'stream', token: `Requirements: ${JSON.stringify(requirements)}\n` }));

        // Step 2: Clarification
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Clarifying requirements...' }));
        const clarifications = await runStep(async () => await require('../orchestration/langgraph').clarificationAgent(requirements), ws, 'Clarifying...');
        ws.send(JSON.stringify({ type: 'stream', token: `Clarifications: ${JSON.stringify(clarifications)}\n` }));

        // Step 3: Confirmation Gate
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Confirming requirements...' }));
        const confirmation = await runStep(async () => await require('../orchestration/langgraph').confirmationGate(clarifications), ws, 'Confirming...');
        ws.send(JSON.stringify({ type: 'stream', token: `Confirmation: ${JSON.stringify(confirmation)}\n` }));

        // Step 4: System Design
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Designing system...' }));
        const systemDesign = await runStep(async () => await require('../orchestration/langgraph').systemDesignAgent(requirements), ws, 'Designing...');
        ws.send(JSON.stringify({ type: 'stream', token: `System Design: ${JSON.stringify(systemDesign)}\n` }));

        // Step 5: Code Generation
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Generating code...' }));
        const codeGen = await runStep(async () => await require('../orchestration/langgraph').codeGenerationAgent(systemDesign), ws, 'Generating code...');
        ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(codeGen)}\n` }));

        // Step 6: Test & Fix
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Testing and fixing...' }));
        const testResult = await runStep(async () => await require('../orchestration/langgraph').testFixAgent({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) }), ws, 'Testing...');
        ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(testResult)}\n` }));

        // Step 7: Deployment
        ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying...' }));
        const deployment = await runStep(async () => await require('../orchestration/langgraph').deploymentAgent({ frontend: 'frontend', backend: 'backend' }), ws, 'Deploying...');
        ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(deployment)}\n` }));

        ws.send(JSON.stringify({ type: 'done' }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'AI process failed.' }));
      }
    });
  });

  return wss;
}

async function runStep(fn: () => Promise<any>, ws: any, status: string) {
  try {
    return await fn();
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: status + ' failed: ' + (err?.message || err) }));
    throw err;
  }
}
