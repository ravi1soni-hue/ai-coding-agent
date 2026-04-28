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

    // --- State management per connection ---
    type Session = {
      progress: number;
      step: string;
      requirements: any;
      clarifications: any;
      confirmation: any;
      systemDesign: any;
      codeGen: any;
      testResult: any;
      deployment: any;
      pendingQuestions: string[];
      context: Record<string, any>;
    };
    const session: Session = {
      progress: 0,
      step: 'init',
      requirements: undefined,
      clarifications: undefined,
      confirmation: undefined,
      systemDesign: undefined,
      codeGen: undefined,
      testResult: undefined,
      deployment: undefined,
      pendingQuestions: [],
      context: {},
    };

    async function runFlow(userMsg: string | null, userClarificationAnswers: Record<string, any> | null = null) {
      try {
        // Step 1: Requirement Analysis
        if (session.step === 'init' || session.step === 'requirementAnalysis') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Analyzing requirements...' }));
          try {
            if (!userMsg) throw new Error('User message required for requirement analysis');
            session.requirements = await requirementAnalysisAgent({ user_message: userMsg });
            ws.send(JSON.stringify({ type: 'stream', token: `Requirements: ${JSON.stringify(session.requirements)}\n` }));
            session.step = 'clarification';
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Requirement analysis failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
            return;
          }
        }

        // Step 2: Clarification (multi-turn)
        while (session.step === 'clarification') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Clarifying requirements...' }));
          try {
            let clarInput = session.requirements || {};
            if (userClarificationAnswers && typeof userClarificationAnswers === 'object') {
              clarInput = { ...clarInput, ...userClarificationAnswers };
            }
            session.clarifications = await clarificationAgent(clarInput);
            if (session.clarifications && Array.isArray(session.clarifications.questions) && session.clarifications.questions.length > 0 && !session.clarifications.confirmed) {
              ws.send(JSON.stringify({ type: 'clarification', questions: session.clarifications.questions, context: clarInput }));
              session.pendingQuestions = session.clarifications.questions;
              session.step = 'clarification_wait';
              return;
            } else if (session.clarifications && !session.clarifications.confirmed) {
              ws.send(JSON.stringify({ type: 'clarification', questions: [], needsConfirmation: true, context: clarInput }));
              session.pendingQuestions = [];
              session.step = 'clarification_wait';
              return;
            } else {
              ws.send(JSON.stringify({ type: 'stream', token: `Clarifications: ${JSON.stringify(session.clarifications)}\n` }));
              session.step = 'confirmation';
            }
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Clarification failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
            return;
          }
        }

        // Step 3: Confirmation Gate (multi-turn)
        while (session.step === 'confirmation') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Confirming requirements...' }));
          try {
            if (!session.clarifications) throw new Error('Clarifications required for confirmation');
            session.confirmation = await confirmationGate(session.clarifications);
            ws.send(JSON.stringify({ type: 'stream', token: `Confirmation: ${JSON.stringify(session.confirmation)}\n` }));
            session.step = 'systemDesign';
          } catch (err) {
            ws.send(JSON.stringify({ type: 'confirmation', message: (err as any)?.message, context: session.clarifications }));
            session.step = 'confirmation_wait';
            return;
          }
        }

        // Step 4: System Design
        if (session.step === 'systemDesign') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Designing system...' }));
          try {
            session.systemDesign = await systemDesignAgent(session.requirements);
            ws.send(JSON.stringify({ type: 'stream', token: `System Design: ${JSON.stringify(session.systemDesign)}\n` }));
            session.step = 'codeGen';
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'System design failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
            return;
          }
        }

        // Step 5: Code Generation
        if (session.step === 'codeGen') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Generating code...' }));
          try {
            session.codeGen = await codeGenerationAgent(session.systemDesign);
            ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(session.codeGen)}\n` }));
            session.step = 'testFix';
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Code generation failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
            return;
          }
        }

        // Step 6: Test & Fix
        if (session.step === 'testFix') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Testing and fixing...' }));
          try {
            session.testResult = await testFixAgent({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) });
            ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(session.testResult)}\n` }));
            session.step = 'deploy';
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Test/fix failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
            return;
          }
        }

        // Step 7: Deployment
        if (session.step === 'deploy') {
          ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying...' }));
          try {
            session.deployment = await deploymentAgent({ frontend: 'frontend', backend: 'backend' });
            ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(session.deployment)}\n` }));
            session.step = 'done';
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Deployment failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
            return;
          }
        }

        if (session.step === 'done') {
          ws.send(JSON.stringify({ type: 'done' }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'AI process failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
      }
    }

    ws.on('message', async (message) => {
      // If waiting for clarification/confirmation, treat message as user answer
      if (session.step === 'clarification_wait') {
        // Assume message is JSON or plain text answer to questions
        let userAnswers: Record<string, any> = {};
        try {
          userAnswers = JSON.parse(message.toString());
        } catch {
          // fallback: treat as plain text, map to first question
          if (session.pendingQuestions && session.pendingQuestions.length > 0) {
            userAnswers[session.pendingQuestions[0] || 'answer'] = message.toString();
          }
        }
        session.step = 'clarification';
        await runFlow(null, userAnswers);
        return;
      } else if (session.step === 'confirmation_wait') {
        // User confirms, resume
        if (session.clarifications) session.clarifications.confirmed = true;
        session.step = 'confirmation';
        await runFlow(null, null);
        return;
      } else if (session.step !== 'init') {
        ws.send(JSON.stringify({ type: 'info', message: 'Please answer the pending questions or confirm to continue.' }));
        return;
      }
      // New session start
      await runFlow(message.toString(), null);
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
