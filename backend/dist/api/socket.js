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
        const session = {
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
        // Track answers for step-by-step clarification
        let clarificationAnswers = {};
        let clarificationIndex = 0;
        async function runFlow(userMsg, userClarificationAnswers = null) {
            try {
                // Step 1: Requirement Analysis
                if (session.step === 'init' || session.step === 'requirementAnalysis') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Analyzing requirements...' }));
                    try {
                        if (!userMsg)
                            throw new Error('User message required for requirement analysis');
                        session.requirements = await (0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: userMsg });
                        ws.send(JSON.stringify({ type: 'stream', token: `Requirements: ${JSON.stringify(session.requirements)}\n` }));
                        session.step = 'clarification';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Requirement analysis failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 2: Clarification (multi-turn)
                while (session.step === 'clarification') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Clarifying requirements...' }));
                    try {
                        let clarInput = session.requirements || {};
                        // Merge all previous answers
                        clarInput = { ...clarInput, ...clarificationAnswers };
                        if (userClarificationAnswers && typeof userClarificationAnswers === 'object') {
                            clarInput = { ...clarInput, ...userClarificationAnswers };
                        }
                        session.clarifications = await (0, clarificationAgent_1.clarificationAgent)(clarInput);
                        if (session.clarifications && Array.isArray(session.clarifications.questions) && session.clarifications.questions.length > 0 && !session.clarifications.confirmed) {
                            session.pendingQuestions = session.clarifications.questions;
                            // Send only the next unanswered question
                            if (clarificationIndex < session.pendingQuestions.length) {
                                ws.send(JSON.stringify({ type: 'clarification', question: session.pendingQuestions[clarificationIndex], index: clarificationIndex + 1, total: session.pendingQuestions.length, context: clarInput }));
                                session.step = 'clarification_wait';
                                return;
                            }
                        }
                        else if (session.clarifications && !session.clarifications.confirmed) {
                            ws.send(JSON.stringify({ type: 'clarification', questions: [], needsConfirmation: true, context: clarInput }));
                            session.pendingQuestions = [];
                            session.step = 'clarification_wait';
                            return;
                        }
                        else {
                            ws.send(JSON.stringify({ type: 'stream', token: `Clarifications: ${JSON.stringify(session.clarifications)}\n` }));
                            session.step = 'confirmation';
                        }
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Clarification failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 3: Confirmation Gate (multi-turn)
                while (session.step === 'confirmation') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Confirming requirements...' }));
                    try {
                        if (!session.clarifications)
                            throw new Error('Clarifications required for confirmation');
                        session.confirmation = await (0, confirmationGate_1.confirmationGate)(session.clarifications);
                        ws.send(JSON.stringify({ type: 'stream', token: `Confirmation: ${JSON.stringify(session.confirmation)}\n` }));
                        session.step = 'systemDesign';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'confirmation', message: err?.message, context: session.clarifications }));
                        session.step = 'confirmation_wait';
                        return;
                    }
                }
                // Step 4: System Design
                if (session.step === 'systemDesign') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Designing system...' }));
                    try {
                        session.systemDesign = await (0, systemDesignAgent_1.systemDesignAgent)(session.requirements);
                        ws.send(JSON.stringify({ type: 'stream', token: `System Design: ${JSON.stringify(session.systemDesign)}\n` }));
                        session.step = 'codeGen';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'System design failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 5: Code Generation
                if (session.step === 'codeGen') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Generating code...' }));
                    try {
                        session.codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)(session.systemDesign);
                        ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(session.codeGen)}\n` }));
                        session.step = 'testFix';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Code generation failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 6: Test & Fix
                if (session.step === 'testFix') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Testing and fixing...' }));
                    try {
                        session.testResult = await (0, testFixAgent_1.testFixAgent)({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) });
                        ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(session.testResult)}\n` }));
                        session.step = 'deploy';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Test/fix failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 7: Deployment
                if (session.step === 'deploy') {
                    ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying...' }));
                    try {
                        session.deployment = await (0, deploymentAgent_1.deploymentAgent)({ frontend: 'frontend', backend: 'backend' });
                        ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(session.deployment)}\n` }));
                        session.step = 'done';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Deployment failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                if (session.step === 'done') {
                    ws.send(JSON.stringify({ type: 'done' }));
                }
            }
            catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: err?.message || 'AI process failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
            }
        }
        ws.on('message', async (message) => {
            // If waiting for clarification/confirmation, treat message as user answer
            if (session.step === 'clarification_wait') {
                // Only one question at a time
                let answer = message.toString();
                // Map answer to the current question
                if (session.pendingQuestions && clarificationIndex < session.pendingQuestions.length) {
                    clarificationAnswers[session.pendingQuestions[clarificationIndex]] = answer;
                    clarificationIndex++;
                }
                // If more questions, ask next; else, continue
                if (clarificationIndex < session.pendingQuestions.length) {
                    ws.send(JSON.stringify({ type: 'clarification', question: session.pendingQuestions[clarificationIndex], index: clarificationIndex + 1, total: session.pendingQuestions.length, context: session.requirements }));
                    return;
                }
                else {
                    session.step = 'clarification';
                    await runFlow(null, clarificationAnswers);
                    return;
                }
            }
            else if (session.step === 'confirmation_wait') {
                // User confirms, resume
                if (session.clarifications)
                    session.clarifications.confirmed = true;
                session.step = 'confirmation';
                await runFlow(null, null);
                return;
            }
            else if (session.step !== 'init') {
                ws.send(JSON.stringify({ type: 'info', message: 'Please answer the pending questions or confirm to continue.' }));
                return;
            }
            // New session start
            await runFlow(message.toString(), null);
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
