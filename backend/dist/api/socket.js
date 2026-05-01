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
const buildWorker_1 = require("../workers/buildWorker");
const authService_1 = require("../auth/authService");
const projectStore_1 = require("../db/projectStore");
const projectFactory_1 = require("../factory/projectFactory");
function createSocketServer(server) {
    const wss = new ws_1.Server({ server });
    // Track projectIds with an active running pipeline to prevent concurrent corruption
    const activePipelines = new Set();
    const stageWeights = {
        requirementAnalysis: 0.12,
        clarification: 0.15,
        confirmation: 0.08,
        systemDesign: 0.12,
        codeGen: 0.25,
        testFix: 0.15,
        deploy: 0.13,
        codeGen_modification: 0.25,
        testFix_modification: 0.15,
        deploy_modification: 0.13,
    };
    function applyStageProgress(session, stage) {
        if (session.progressStages[stage])
            return;
        session.progressStages[stage] = true;
        session.progress = Math.min(1, session.progress + (stageWeights[stage] || 0));
    }
    function sendProgress(ws, session, stage, status, stageProgress) {
        applyStageProgress(session, stage);
        const payload = {
            type: 'progress',
            progress: Number(session.progress.toFixed(4)),
            status,
            stage,
        };
        if (typeof stageProgress === 'number') {
            payload.stageProgress = Math.max(0, Math.min(1, stageProgress));
        }
        ws.send(JSON.stringify(payload));
    }
    wss.on('connection', async (ws, request) => {
        const cookies = (0, authService_1.parseCookie)(request.headers.cookie);
        const token = cookies.sid;
        if (!token) {
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication required. Please login again.' }));
            ws.close();
            return;
        }
        const user = await (0, authService_1.getUserFromSessionToken)(token);
        if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session expired. Please login again.' }));
            ws.close();
            return;
        }
        const authedUser = user;
        const url = new URL(request.url || '/', 'http://localhost');
        const requestedProjectId = url.searchParams.get('projectId');
        let projectId = await (0, authService_1.getOrCreateActiveProjectSession)(authedUser.id);
        if (requestedProjectId) {
            const owned = await (0, authService_1.isProjectOwnedByUser)(authedUser.id, requestedProjectId);
            projectId = owned ? requestedProjectId : await (0, authService_1.createProjectSession)(authedUser.id);
        }
        await (0, authService_1.touchProjectSession)(authedUser.id, projectId);
        const wsAny = ws;
        const sendRaw = ws.send.bind(ws);
        wsAny.send = (data) => {
            sendRaw(data);
            try {
                const payload = typeof data === 'string' ? JSON.parse(data) : null;
                if (!payload || typeof payload !== 'object')
                    return;
                const roleMap = {
                    info: 'system',
                    progress: 'system',
                    stream: 'assistant',
                    clarification: 'assistant',
                    confirmation: 'assistant',
                    error: 'error',
                    done: 'system',
                };
                const text = payload.message ?? payload.token ?? payload.question ?? payload.status ?? (payload.type ? String(payload.type) : null);
                void (0, projectStore_1.appendProjectEvent)({
                    projectId,
                    userId: authedUser.id,
                    eventType: payload.type || 'outbound',
                    role: roleMap[payload.type] ?? 'system',
                    message: text,
                    payload,
                });
                if (payload.type === 'progress') {
                    void (0, projectStore_1.updateProjectSnapshot)({
                        projectId,
                        userId: authedUser.id,
                        status: 'active',
                        currentStep: session.step,
                        progress: Number(payload.progress) || 0,
                    });
                }
                if (payload.type === 'error') {
                    void (0, projectStore_1.updateProjectSnapshot)({
                        projectId,
                        userId: authedUser.id,
                        status: 'failed',
                        currentStep: session.step,
                    });
                }
                if (payload.type === 'done') {
                    void (0, projectStore_1.updateProjectSnapshot)({
                        projectId,
                        userId: authedUser.id,
                        status: 'completed',
                        currentStep: 'done',
                        progress: 1,
                        requirements: session.requirements,
                        clarifications: session.clarifications,
                        confirmation: session.confirmation,
                        systemDesign: session.systemDesign,
                        codeGen: session.codeGen,
                        testResult: session.testResult,
                        deployment: session.deployment,
                    });
                }
            }
            catch (err) {
                if (process.env.NODE_ENV !== 'production') {
                    console.warn('Skipping outbound project event persistence for non-JSON payload', err);
                }
            }
        };
        ws.send(JSON.stringify({ type: 'info', message: 'WebSocket connection established!' }));
        const snapshot = await (0, projectStore_1.getProjectSnapshot)({ userId: authedUser.id, projectId });
        const session = {
            progress: Number(snapshot?.progress) || 0,
            step: snapshot?.current_step || 'init',
            requirements: snapshot?.requirements,
            clarifications: snapshot?.clarifications,
            confirmation: snapshot?.confirmation,
            systemDesign: snapshot?.system_design,
            codeGen: snapshot?.code_gen,
            testResult: snapshot?.test_result,
            deployment: snapshot?.deployment,
            context: {},
            modification: undefined,
            modificationContext: undefined,
            lastClarificationQuestion: undefined,
            activeRevisionId: undefined,
            workspaceDir: undefined,
            sourceArchivePath: undefined,
            sourceHash: undefined,
            buildDir: undefined,
            codeRevisionDbId: undefined,
            progressStages: {},
        };
        if (session.step === 'done' || session.step === 'done_modification') {
            session.step = 'init';
            session.progress = 0;
            session.progressStages = {};
        }
        // Track answers for step-by-step clarification
        let clarificationAnswers = session.clarifications?.context?.clarificationAnswers && typeof session.clarifications.context.clarificationAnswers === 'object'
            ? { ...session.clarifications.context.clarificationAnswers }
            : {};
        let askedClarificationQuestions = Array.isArray(session.clarifications?.context?.askedQuestions)
            ? [...session.clarifications.context.askedQuestions]
            : [];
        async function runFlow(userMsg, userClarificationAnswers = null) {
            // Prevent two concurrent pipelines for the same projectId (e.g., two browser tabs)
            if (activePipelines.has(projectId)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Another pipeline is already running for this project. Please wait or open a new project.' }));
                return;
            }
            activePipelines.add(projectId);
            try {
                // Step 1: Requirement Analysis
                if (session.step === 'init' || session.step === 'requirementAnalysis') {
                    sendProgress(ws, session, 'requirementAnalysis', 'Analyzing requirements...');
                    try {
                        if (!userMsg)
                            throw new Error('User message required for requirement analysis');
                        session.requirements = await (0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: userMsg });
                        // Log technical details, but send only conversational message to UI
                        console.log('[REQUIREMENTS]', session.requirements);
                        ws.send(JSON.stringify({ type: 'stream', token: 'Got it! Let me clarify a few details about your project.' }));
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
                    sendProgress(ws, session, 'clarification', 'Clarifying requirements...');
                    try {
                        // Always wrap requirements in an object as expected by clarificationAgent
                        let clarInput = {
                            requirements: session.requirements || {},
                            clarificationAnswers,
                            askedQuestions: askedClarificationQuestions,
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
                            let questionMsg = session.clarifications.question;
                            // Defensive: if questionMsg is a JSON string, parse and extract .question
                            if (typeof questionMsg === 'string' && questionMsg.trim().startsWith('{')) {
                                try {
                                    const parsed = JSON.parse(questionMsg);
                                    if (parsed && typeof parsed.question === 'string')
                                        questionMsg = parsed.question;
                                }
                                catch { }
                            }
                            const normalizedQuestion = questionMsg.trim().toLowerCase();
                            if (askedClarificationQuestions.some((q) => q.trim().toLowerCase() === normalizedQuestion)) {
                                ws.send(JSON.stringify({ type: 'stream', token: 'Using your previous clarification. Moving to confirmation.' }));
                                session.step = 'confirmation';
                                continue;
                            }
                            askedClarificationQuestions.push(questionMsg);
                            session.lastClarificationQuestion = questionMsg;
                            ws.send(JSON.stringify({ type: 'clarification', question: questionMsg })); // Only send plain question string
                            session.step = 'clarification_wait';
                            return;
                        }
                        else if (session.clarifications && !session.clarifications.confirmed) {
                            ws.send(JSON.stringify({ type: 'confirmation', message: 'Could you please confirm the above details before we proceed?' })); // Only send plain confirmation message
                            session.step = 'clarification_wait';
                            return;
                        }
                        else {
                            ws.send(JSON.stringify({ type: 'stream', token: 'Thanks for clarifying! Moving to confirmation.' }));
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
                    sendProgress(ws, session, 'confirmation', 'Confirming requirements...');
                    try {
                        if (!session.clarifications)
                            throw new Error('Clarifications required for confirmation');
                        session.confirmation = await (0, confirmationGate_1.confirmationGate)(session.clarifications);
                        console.log('[CONFIRMATION]', session.confirmation);
                        ws.send(JSON.stringify({ type: 'stream', token: 'All requirements confirmed! I will now design the system.' }));
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
                    sendProgress(ws, session, 'systemDesign', 'Designing system...');
                    try {
                        session.systemDesign = await (0, systemDesignAgent_1.systemDesignAgent)(session.requirements);
                        console.log('[SYSTEM DESIGN]', session.systemDesign);
                        ws.send(JSON.stringify({ type: 'stream', token: 'System design is ready. Generating code...' }));
                        session.step = 'codeGen';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'System design failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 5: Code Generation
                if (session.step === 'codeGen') {
                    sendProgress(ws, session, 'codeGen', 'Generating code...', 0);
                    try {
                        session.codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)({ systemDesign: session.systemDesign, requirements: session.requirements });
                        const materialized = await (0, projectFactory_1.materializeProjectWorkspace)({
                            projectId,
                            codeGen: session.codeGen,
                        });
                        session.activeRevisionId = materialized.revisionId;
                        session.workspaceDir = materialized.workspaceDir;
                        session.sourceArchivePath = materialized.archivePath;
                        session.sourceHash = materialized.sourceHash;
                        session.codeRevisionDbId = await (0, projectStore_1.createProjectCodeRevision)({
                            projectId,
                            userId: authedUser.id,
                            workspacePath: materialized.workspaceDir,
                            sourceArchivePath: materialized.archivePath,
                            sourceHash: materialized.sourceHash,
                            patchPath: materialized.patchPath,
                            patchApplied: materialized.patchApplied,
                            patchApplyLog: materialized.patchApplyLog,
                            generationPayload: session.codeGen,
                        });
                        console.log('[CODE GEN]', session.codeGen);
                        sendProgress(ws, session, 'codeGen', 'Code generation complete.', 1);
                        ws.send(JSON.stringify({ type: 'stream', token: 'Code generated! Running tests and fixes...' }));
                        session.step = 'testFix';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Code generation failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 6: Test & Fix
                if (session.step === 'testFix') {
                    sendProgress(ws, session, 'testFix', 'Testing and fixing...', 0);
                    try {
                        session.testResult = await (0, testFixAgent_1.testFixAgent)({
                            buildFn: async () => {
                                const result = await (0, buildWorker_1.runBuildWorker)({ workspaceDir: session.workspaceDir });
                                if (result.success) {
                                    session.buildDir = result.buildDir;
                                }
                                return { success: result.success, logs: result.logs };
                            },
                            fixFn: async (logs) => {
                                ws.send(JSON.stringify({ type: 'stream', token: 'Build failed — asking AI to fix errors...' }));
                                const fixedCodeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)({
                                    systemDesign: session.systemDesign,
                                    requirements: session.requirements,
                                    modification: `Fix these build errors and produce corrected files:\n${logs.slice(-1500)}`,
                                });
                                const reMaterialized = await (0, projectFactory_1.materializeProjectWorkspace)({ projectId, codeGen: fixedCodeGen });
                                session.activeRevisionId = reMaterialized.revisionId;
                                session.workspaceDir = reMaterialized.workspaceDir;
                                session.sourceArchivePath = reMaterialized.archivePath;
                                session.sourceHash = reMaterialized.sourceHash;
                                session.codeGen = fixedCodeGen;
                                session.codeRevisionDbId = await (0, projectStore_1.createProjectCodeRevision)({
                                    projectId,
                                    userId: authedUser.id,
                                    workspacePath: reMaterialized.workspaceDir,
                                    sourceArchivePath: reMaterialized.archivePath,
                                    sourceHash: reMaterialized.sourceHash,
                                    patchPath: reMaterialized.patchPath,
                                    patchApplied: reMaterialized.patchApplied,
                                    patchApplyLog: reMaterialized.patchApplyLog,
                                    generationPayload: fixedCodeGen,
                                });
                            },
                        });
                        console.log('[TEST RESULT]', session.testResult);
                        sendProgress(ws, session, 'testFix', 'Testing complete.', 1);
                        ws.send(JSON.stringify({ type: 'stream', token: 'Tests complete! Deploying your project...' }));
                        session.step = 'deploy';
                    }
                    catch (err) {
                        ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Test/fix failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                        return;
                    }
                }
                // Step 7: Deployment
                if (session.step === 'deploy') {
                    sendProgress(ws, session, 'deploy', 'Deploying...', 0);
                    try {
                        if (!session.buildDir || !session.activeRevisionId) {
                            throw new Error('Build artifact missing for deployment.');
                        }
                        session.deployment = await (0, deploymentAgent_1.deploymentAgent)({
                            projectId,
                            revisionId: session.activeRevisionId,
                            buildDir: session.buildDir,
                            frontendProjectName: `proj-${projectId.slice(0, 10)}`,
                            backendService: 'backend',
                        });
                        await (0, projectStore_1.saveProjectDeployment)({
                            projectId,
                            userId: authedUser.id,
                            frontendUrl: session.deployment?.frontend_url,
                            backendUrl: session.deployment?.backend_url,
                            vercelDeploymentId: session.deployment?.vercel_deployment_id,
                            vercelInspectUrl: session.deployment?.vercel_inspect_url,
                            vercelStatus: session.deployment?.vercel_status,
                            vercelLogUrl: session.deployment?.vercel_log_url,
                            railwayDeploymentId: session.deployment?.railway_deployment_id,
                            railwayStatus: session.deployment?.railway_status,
                            railwayLogUrl: session.deployment?.railway_log_url,
                            railwayDashboardUrl: session.deployment?.railway_dashboard_url,
                            codeRevisionId: session.codeRevisionDbId,
                            sourceArchivePath: session.sourceArchivePath,
                            sourceHash: session.sourceHash,
                            raw: session.deployment,
                        });
                        console.log('[DEPLOYMENT]', session.deployment);
                        const deployedUrl = session.deployment?.frontend_url || '';
                        ws.send(JSON.stringify({ type: 'stream', token: `Your project is deployed! 🎉${deployedUrl ? `\n\n🔗 Live URL: ${deployedUrl}` : ''}` }));
                        if (session.deployment?.frontend_access_warning) {
                            ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
                        }
                        // Free disk: remove node_modules from workspace (dist/ already uploaded to Vercel)
                        if (session.workspaceDir)
                            void (0, buildWorker_1.cleanupWorkspace)(session.workspaceDir);
                        sendProgress(ws, session, 'deploy', 'Deployment queued.', 1);
                        session.step = 'done';
                    }
                    catch (err) {
                        const message = err?.message || 'Oops, something went wrong during deployment. Please try again later.';
                        console.error('[Deployment Error]', message);
                        ws.send(JSON.stringify({ type: 'error', message }));
                        return;
                    }
                }
                if (session.step === 'done') {
                    // Save project/session state for project management (simple example: log to file/db)
                    console.log('[PROJECT SAVED]', {
                        userId: authedUser.id,
                        projectId,
                        requirements: session.requirements,
                        clarifications: session.clarifications,
                        confirmation: session.confirmation,
                        systemDesign: session.systemDesign,
                        codeGen: session.codeGen,
                        testResult: session.testResult,
                        deployment: session.deployment,
                        timestamp: new Date().toISOString()
                    });
                    await (0, authService_1.touchProjectSession)(authedUser.id, projectId);
                    ws.send(JSON.stringify({
                        type: 'done',
                        projectId,
                        message: 'Project complete and saved. Start a new session for a new project!',
                        frontend_url: session.deployment?.frontend_url || null,
                        backend_url: session.deployment?.backend_url || null,
                        vercel_inspect_url: session.deployment?.vercel_inspect_url || null,
                        frontend_access_warning: session.deployment?.frontend_access_warning || null,
                    }));
                }
            }
            catch (err) {
                console.error('[General Error]', err);
                ws.send(JSON.stringify({ type: 'error', message: 'Oh no, something went wrong. Please try again or start a new session.' }));
            }
            finally {
                activePipelines.delete(projectId);
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
            const userText = typeof msg === 'object' ? msg.user_message || msg.answer || msg.modification : msg;
            if (typeof userText === 'string' && userText.trim()) {
                await (0, projectStore_1.appendProjectEvent)({
                    projectId,
                    userId: authedUser.id,
                    eventType: 'user_message',
                    role: 'user',
                    message: userText.trim(),
                    payload: msg,
                });
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
                    ws.send(JSON.stringify({ type: 'clarification', question: clarResult.question })); // Only send plain question string
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
                    ws.send(JSON.stringify({ type: 'clarification', question: clarResult.question })); // Only send plain question string
                    session.lastClarificationQuestion = clarResult.question;
                    return;
                }
                else {
                    session.step = 'codeGen_modification';
                }
            }
            // Handle code generation for modification
            if (session.step === 'codeGen_modification') {
                sendProgress(ws, session, 'codeGen_modification', 'Generating code patch for modification...', 0);
                try {
                    let codeGenInput = {
                        systemDesign: session.systemDesign,
                        requirements: session.requirements,
                        modification: session.modification,
                        context: session.modificationContext
                    };
                    session.codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)(codeGenInput);
                    const materialized = await (0, projectFactory_1.materializeProjectWorkspace)({
                        projectId,
                        codeGen: session.codeGen,
                    });
                    session.activeRevisionId = materialized.revisionId;
                    session.workspaceDir = materialized.workspaceDir;
                    session.sourceArchivePath = materialized.archivePath;
                    session.sourceHash = materialized.sourceHash;
                    session.codeRevisionDbId = await (0, projectStore_1.createProjectCodeRevision)({
                        projectId,
                        userId: authedUser.id,
                        workspacePath: materialized.workspaceDir,
                        sourceArchivePath: materialized.archivePath,
                        sourceHash: materialized.sourceHash,
                        patchPath: materialized.patchPath,
                        patchApplied: materialized.patchApplied,
                        patchApplyLog: materialized.patchApplyLog,
                        generationPayload: session.codeGen,
                    });
                    sendProgress(ws, session, 'codeGen_modification', 'Code patch generation complete.', 1);
                    ws.send(JSON.stringify({ type: 'stream', token: `Code patch generated. Proceeding to tests...` }));
                    session.step = 'testFix_modification';
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Code generation for modification failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                    return;
                }
            }
            // Test & Fix for modification
            if (session.step === 'testFix_modification') {
                sendProgress(ws, session, 'testFix_modification', 'Testing and fixing modification...', 0);
                try {
                    session.testResult = await (0, testFixAgent_1.testFixAgent)({
                        buildFn: async () => {
                            const result = await (0, buildWorker_1.runBuildWorker)({ workspaceDir: session.workspaceDir });
                            if (result.success) {
                                session.buildDir = result.buildDir;
                            }
                            return { success: result.success, logs: result.logs };
                        },
                        fixFn: async (logs) => {
                            ws.send(JSON.stringify({ type: 'stream', token: 'Build failed — asking AI to fix errors...' }));
                            const fixedCodeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)({
                                systemDesign: session.systemDesign,
                                requirements: session.requirements,
                                modification: `Fix these build errors and produce corrected files:\n${logs.slice(-1500)}`,
                            });
                            const reMaterialized = await (0, projectFactory_1.materializeProjectWorkspace)({ projectId, codeGen: fixedCodeGen });
                            session.activeRevisionId = reMaterialized.revisionId;
                            session.workspaceDir = reMaterialized.workspaceDir;
                            session.sourceArchivePath = reMaterialized.archivePath;
                            session.sourceHash = reMaterialized.sourceHash;
                            session.codeGen = fixedCodeGen;
                            session.codeRevisionDbId = await (0, projectStore_1.createProjectCodeRevision)({
                                projectId,
                                userId: authedUser.id,
                                workspacePath: reMaterialized.workspaceDir,
                                sourceArchivePath: reMaterialized.archivePath,
                                sourceHash: reMaterialized.sourceHash,
                                patchPath: reMaterialized.patchPath,
                                patchApplied: reMaterialized.patchApplied,
                                patchApplyLog: reMaterialized.patchApplyLog,
                                generationPayload: fixedCodeGen,
                            });
                        },
                    });
                    ws.send(JSON.stringify({ type: 'stream', token: `Tests complete. Deploying your project...` }));
                    session.step = 'deploy_modification';
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Test/fix for modification failed.', error: { name: err?.name, stack: err?.stack, details: err } }));
                    return;
                }
            }
            // Deploy modification
            if (session.step === 'deploy_modification') {
                sendProgress(ws, session, 'deploy_modification', 'Deploying modification...', 1);
                try {
                    if (!session.buildDir || !session.activeRevisionId) {
                        throw new Error('Build artifact missing for deployment.');
                    }
                    session.deployment = await (0, deploymentAgent_1.deploymentAgent)({
                        projectId,
                        revisionId: session.activeRevisionId,
                        buildDir: session.buildDir,
                        frontendProjectName: `proj-${projectId.slice(0, 10)}`,
                        backendService: 'backend',
                    });
                    await (0, projectStore_1.saveProjectDeployment)({
                        projectId,
                        userId: authedUser.id,
                        frontendUrl: session.deployment?.frontend_url,
                        backendUrl: session.deployment?.backend_url,
                        vercelDeploymentId: session.deployment?.vercel_deployment_id,
                        vercelInspectUrl: session.deployment?.vercel_inspect_url,
                        vercelStatus: session.deployment?.vercel_status,
                        vercelLogUrl: session.deployment?.vercel_log_url,
                        railwayDeploymentId: session.deployment?.railway_deployment_id,
                        railwayStatus: session.deployment?.railway_status,
                        railwayLogUrl: session.deployment?.railway_log_url,
                        railwayDashboardUrl: session.deployment?.railway_dashboard_url,
                        codeRevisionId: session.codeRevisionDbId,
                        sourceArchivePath: session.sourceArchivePath,
                        sourceHash: session.sourceHash,
                        raw: session.deployment,
                    });
                    ws.send(JSON.stringify({ type: 'stream', token: `Deployment complete!` }));
                    if (session.deployment?.frontend_access_warning) {
                        ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
                    }
                    // Free disk: remove node_modules from workspace
                    if (session.workspaceDir)
                        void (0, buildWorker_1.cleanupWorkspace)(session.workspaceDir);
                    session.step = 'done_modification';
                }
                catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: err?.message || 'Deployment for modification failed.', error: { name: err?.name, stack: err?.stack } }));
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
                askedClarificationQuestions = [];
                return;
            }
            // --- Original flow ---
            if (session.step === 'clarification_wait') {
                const answer = typeof msg === 'object' ? msg.answer : msg;
                if (session.lastClarificationQuestion && typeof answer === 'string' && answer.trim()) {
                    clarificationAnswers[session.lastClarificationQuestion] = answer.trim();
                }
                session.lastClarificationQuestion = undefined;
                session.step = 'clarification';
                await runFlow(null, { ...clarificationAnswers });
                return;
            }
            else if (session.step === 'confirmation_wait') {
                if (session.clarifications)
                    session.clarifications.confirmed = true;
                session.step = 'confirmation';
                await runFlow(null, null);
                return;
            }
            else if (session.step !== 'init') {
                // Recover from stale/non-resumable states by treating new user text as a fresh request.
                // This avoids dead-ends after reconnects where the snapshot step is in-progress
                // but no actionable clarification/confirmation prompt is actually pending.
                if (typeof userText === 'string' && userText.trim()) {
                    session.progress = 0;
                    session.step = 'init';
                    session.requirements = undefined;
                    session.clarifications = undefined;
                    session.confirmation = undefined;
                    session.systemDesign = undefined;
                    session.codeGen = undefined;
                    session.testResult = undefined;
                    session.deployment = undefined;
                    session.modification = undefined;
                    session.modificationContext = undefined;
                    session.lastClarificationQuestion = undefined;
                    session.progressStages = {};
                    clarificationAnswers = {};
                    askedClarificationQuestions = [];
                    ws.send(JSON.stringify({ type: 'stream', token: 'Starting a new request from your latest prompt.' }));
                    await runFlow(userText, null);
                    return;
                }
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
