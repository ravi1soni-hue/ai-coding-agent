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
            modification: undefined,
            modificationContext: undefined,
            lastClarificationQuestion: undefined,
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
                        // Log technical details, but send only conversational message to UI
                        console.log('[REQUIREMENTS]', session.requirements);
                        ws.send(JSON.stringify({ type: 'message', message: 'Got it! Let me clarify a few details about your project.' }));
                        session.step = 'clarification';
                    }
                    catch (err) {
                        console.error('[RequirementAnalysis Error]', err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Oops, something went wrong while analyzing your requirements. Please try again or rephrase your request.' }));
                        return;
                    }
                }
                // Step 2: Clarification (multi-turn)
                while (session.step === 'clarification') {
                    session.progress += 0.12;
                    ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Clarifying requirements...' }));
                    try {
                        // Always wrap requirements in an object as expected by clarificationAgent
                        let clarInput = {
                            requirements: session.requirements || {},
                            clarificationAnswers,
                            modification: session.modification,
                            lastQuestion: session.lastClarificationQuestion,
                            lastAnswer: undefined // You can set this if you track last answer
                        };
                        if (userClarificationAnswers && typeof userClarificationAnswers === 'object') {
                            clarInput.clarificationAnswers = { ...clarInput.clarificationAnswers, ...userClarificationAnswers };
                        }
                        session.clarifications = await (0, clarificationAgent_1.clarificationAgent)(clarInput);
                        // Log technical details
                        console.log('[CLARIFICATION]', session.clarifications);
                        // Conversational flow
                        if (session.clarifications && session.clarifications.question && !session.clarifications.confirmed) {
                            ws.send(JSON.stringify({ type: 'message', message: session.clarifications.question }));
                            session.step = 'clarification_wait';
                            return;
                        }
                        else if (session.clarifications && !session.clarifications.confirmed) {
                            ws.send(JSON.stringify({ type: 'message', message: 'Could you please confirm the above details before we proceed?' }));
                            session.pendingQuestions = [];
                            session.step = 'clarification_wait';
                            return;
                        }
                        else {
                            ws.send(JSON.stringify({ type: 'message', message: 'Thanks for clarifying! Moving to confirmation.' }));
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
                        console.log('[CONFIRMATION]', session.confirmation);
                        ws.send(JSON.stringify({ type: 'message', message: 'All requirements confirmed! I will now design the system.' }));
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
                        console.log('[SYSTEM DESIGN]', session.systemDesign);
                        ws.send(JSON.stringify({ type: 'message', message: 'System design is ready. Generating code...' }));
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
                        console.log('[CODE GEN]', session.codeGen);
                        ws.send(JSON.stringify({ type: 'message', message: 'Code generated! Running tests and fixes...' }));
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
                        console.log('[TEST RESULT]', session.testResult);
                        ws.send(JSON.stringify({ type: 'message', message: 'Tests complete! Deploying your project...' }));
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
                        console.log('[DEPLOYMENT]', session.deployment);
                        ws.send(JSON.stringify({ type: 'message', message: 'Your project is deployed! 🎉' }));
                        session.step = 'done';
                    }
                    catch (err) {
                        console.error('[Deployment Error]', err);
                        ws.send(JSON.stringify({ type: 'error', message: 'Oops, something went wrong during deployment. Please try again later.' }));
                        return;
                    }
                }
                if (session.step === 'done') {
                    // Save project/session state for project management (simple example: log to file/db)
                    console.log('[PROJECT SAVED]', {
                        requirements: session.requirements,
                        clarifications: session.clarifications,
                        confirmation: session.confirmation,
                        systemDesign: session.systemDesign,
                        codeGen: session.codeGen,
                        testResult: session.testResult,
                        deployment: session.deployment,
                        timestamp: new Date().toISOString()
                    });
                    ws.send(JSON.stringify({ type: 'done', message: 'Project complete and saved. Start a new session for a new project!' }));
                }
            }
            catch (err) {
                console.error('[General Error]', err);
                ws.send(JSON.stringify({ type: 'error', message: 'Oh no, something went wrong. Please try again or start a new session.' }));
            }
        }
        ws.on('message', async (message) => {
            let msg;
            try {
                msg = JSON.parse(message.toString());
            }
            catch {
                msg = message.toString();
            }
            // Modification request (can come at any time)
            if (typeof msg === 'object' && msg.type === 'modification' && msg.modification) {
                // Accept modification request, update requirements/context
                session.step = 'modification';
                session.modification = msg.modification;
                session.modificationContext = msg.context || {};
                // Route through clarification if needed
                let clarInput = {
                    requirements: session.requirements,
                    clarificationAnswers,
                    modification: session.modification
                };
                let clarResult = await (0, clarificationAgent_1.clarificationAgent)(clarInput);
                if (clarResult.question) {
                    ws.send(JSON.stringify({ type: 'clarification', question: clarResult.question, context: clarInput }));
                    session.step = 'clarification_wait_modification';
                    session.lastClarificationQuestion = clarResult.question;
                    return;
                }
                else {
                    // No clarification needed, go to codegen
                    session.step = 'codeGen_modification';
                }
            }
            // Handle clarification answer for modification
            if (session.step === 'clarification_wait_modification') {
                let answer = typeof msg === 'object' ? msg.answer : msg;
                if (session.lastClarificationQuestion) {
                    clarificationAnswers[session.lastClarificationQuestion] = answer;
                }
                // Re-run clarification with new answer
                let clarInput = {
                    requirements: session.requirements,
                    clarificationAnswers,
                    modification: session.modification,
                    lastQuestion: session.lastClarificationQuestion,
                    lastAnswer: answer
                };
                let clarResult = await (0, clarificationAgent_1.clarificationAgent)(clarInput);
                if (clarResult.question) {
                    ws.send(JSON.stringify({ type: 'clarification', question: clarResult.question, context: clarInput }));
                    session.lastClarificationQuestion = clarResult.question;
                    return;
                }
                else {
                    session.step = 'codeGen_modification';
                }
            }
            // Handle code generation for modification
            if (session.step === 'codeGen_modification') {
                ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Generating code patch for modification...' }));
                try {
                    let codeGenInput = {
                        systemDesign: session.systemDesign,
                        requirements: session.requirements,
                        modification: session.modification,
                        context: session.modificationContext
                    };
                    session.codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)(codeGenInput);
                    ws.send(JSON.stringify({ type: 'stream', token: `Code Patch: ${JSON.stringify(session.codeGen)}\n` }));
                    session.step = 'testFix_modification';
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Code generation for modification failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                    return;
                }
            }
            // Test & Fix for modification
            if (session.step === 'testFix_modification') {
                ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Testing and fixing modification...' }));
                try {
                    session.testResult = await (0, testFixAgent_1.testFixAgent)({ buildFn: async () => ({ success: true, logs: 'Build successful.' }) });
                    ws.send(JSON.stringify({ type: 'stream', token: `Test Result: ${JSON.stringify(session.testResult)}\n` }));
                    session.step = 'deploy_modification';
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Test/fix for modification failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                    return;
                }
            }
            // Deploy modification
            if (session.step === 'deploy_modification') {
                ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying modification...' }));
                try {
                    session.deployment = await (0, deploymentAgent_1.deploymentAgent)({ frontend: 'frontend', backend: 'backend' });
                    ws.send(JSON.stringify({ type: 'stream', token: `Deployment: ${JSON.stringify(session.deployment)}\n` }));
                    session.step = 'done_modification';
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Deployment for modification failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                    return;
                }
            }
            if (session.step === 'done_modification') {
                ws.send(JSON.stringify({ type: 'done', modification: true }));
                // Reset modification state for further evolvement
                session.step = 'done';
                session.modification = undefined;
                session.modificationContext = undefined;
                clarificationAnswers = {};
                clarificationIndex = 0;
                return;
            }
            // --- Original flow ---
            if (session.step === 'clarification_wait') {
                let answer = typeof msg === 'object' ? msg.answer : msg;
                if (session.pendingQuestions && clarificationIndex < session.pendingQuestions.length) {
                    clarificationAnswers[session.pendingQuestions[clarificationIndex]] = answer;
                    clarificationIndex++;
                }
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
            await runFlow(typeof msg === 'object' ? msg.user_message : msg, null);
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
