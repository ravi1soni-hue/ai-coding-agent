// Simple WebSocket server using ws
import { Server } from 'ws';
import http from 'http';

import { requirementAnalysisAgent } from '../agents/requirementAnalysisAgent';
import { clarificationAgent } from '../agents/clarificationAgent';
import { confirmationGate } from '../agents/confirmationGate';
import { systemDesignAgent } from '../agents/systemDesignAgent';
import { codeGenerationAgent } from '../agents/codeGenerationAgent';
import { testFixAgent } from '../agents/testFixAgent';
import { deploymentAgent } from '../agents/deploymentAgent';


export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'info', message: 'WebSocket connection established!' }));

    ws.on('message', async (message) => {
      let progress = 0;
      try {
        const userMsg = message.toString();

        // Step 1: Requirement Analysis
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Analyzing requirements...' }));
        const requirements = await requirementAnalysisAgent({ user_message: userMsg });
        ws.send(JSON.stringify({ type: 'stream', token: `Requirements: ${JSON.stringify(requirements)}\n` }));

        // Step 2: Clarification
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Clarifying requirements...' }));
        const clarifications = await clarificationAgent(requirements);
        ws.send(JSON.stringify({ type: 'stream', token: `Clarifications: ${JSON.stringify(clarifications)}\n` }));

        // Step 3: Confirmation Gate
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Confirming requirements...' }));
        const confirmation = await confirmationGate(clarifications);
        ws.send(JSON.stringify({ type: 'stream', token: `Confirmation: ${JSON.stringify(confirmation)}\n` }));

        // Step 4: System Design
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Designing system...' }));
        const systemDesign = await systemDesignAgent(requirements);
        ws.send(JSON.stringify({ type: 'stream', token: `System Design: ${JSON.stringify(systemDesign)}\n` }));

        // Step 5: Code Generation
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Generating code...' }));
        const codeGen = await codeGenerationAgent(systemDesign);
        ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(codeGen)}\n` }));

        // Step 6: Test & Fix
        ws.send(JSON.stringify({ type: 'progress', progress: (progress += 0.12), status: 'Testing and fixing...' }));
        const testResult = await testFixAgent({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) });
        ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(testResult)}\n` }));

        // Step 7: Deployment
        ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying...' }));
        const deployment = await deploymentAgent({ frontend: 'frontend', backend: 'backend' });
        ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(deployment)}\n` }));

        ws.send(JSON.stringify({ type: 'done' }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'AI process failed.' }));
      }
    });
  });

  return wss;
}

async function runStep(fn: () => Promise<any>, ws: any, status: string) {
  try {
    return await fn();
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: status + ' failed: ' + ((err as any)?.message || err) }));
    throw err;
  }
}
