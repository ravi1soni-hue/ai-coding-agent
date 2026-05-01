"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSocketServer = createSocketServer;
// WebSocket server — lightweight message router dispatching to independent handlers
const ws_1 = require("ws");
const requirementAnalysisHandler_1 = require("./handlers/requirementAnalysisHandler");
const clarificationHandler_1 = require("./handlers/clarificationHandler");
const confirmationHandler_1 = require("./handlers/confirmationHandler");
const systemDesignHandler_1 = require("./handlers/systemDesignHandler");
const codeGenerationHandler_1 = require("./handlers/codeGenerationHandler");
const testFixHandler_1 = require("./handlers/testFixHandler");
const deploymentHandler_1 = require("./handlers/deploymentHandler");
const buildWorker_1 = require("../workers/buildWorker");
const authService_1 = require("../auth/authService");
const projectStore_1 = require("../db/projectStore");
const projectFactory_1 = require("../factory/projectFactory");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toClientErrorMessage(err, fallback) {
    const raw = String(err?.message || '').trim();
    if (!raw)
        return fallback;
    const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280) {
        return fallback;
    }
    return sanitized;
}
// ---------------------------------------------------------------------------
// activePipelines with 5-minute TTL to prevent stale-entry leaks
// ---------------------------------------------------------------------------
const PIPELINE_TTL_MS = 5 * 60 * 1000; // 5 minutes
class TTLSet {
    constructor() {
        this.entries = new Map(); // key → expiry timestamp
    }
    has(key) {
        const expiry = this.entries.get(key);
        if (expiry === undefined)
            return false;
        if (Date.now() > expiry) {
            this.entries.delete(key);
            return false;
        }
        return true;
    }
    add(key) {
        this.entries.set(key, Date.now() + PIPELINE_TTL_MS);
    }
    delete(key) {
        this.entries.delete(key);
    }
}
// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------
function createSocketServer(server) {
    const wss = new ws_1.Server({ server });
    const activePipelines = new TTLSet();
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
        const allowedOrigins = env_1.config.WS_ALLOWED_ORIGINS
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean);
        const origin = request.headers.origin || '';
        if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
            ws.send(JSON.stringify({ type: 'error', message: 'WebSocket origin is not allowed.' }));
            ws.close();
            return;
        }
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
                // Non-JSON payloads (e.g. binary frames) are silently skipped.
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
        let clarificationAnswers = session.clarifications?.context?.clarificationAnswers && typeof session.clarifications.context.clarificationAnswers === 'object'
            ? { ...session.clarifications.context.clarificationAnswers }
            : {};
        let askedClarificationQuestions = Array.isArray(session.clarifications?.context?.askedQuestions)
            ? [...session.clarifications.context.askedQuestions]
            : [];
        // -----------------------------------------------------------------------
        // Main pipeline — each stage dispatches to its own handler with an
        // independent error boundary. One stage failing does NOT crash the others.
        // -----------------------------------------------------------------------
        async function runFlow(userMsg, userClarificationAnswers = null) {
            if (activePipelines.has(projectId)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Another pipeline is already running for this project. Please wait or open a new project.' }));
                return;
            }
            activePipelines.add(projectId);
            try {
                // ------------------------------------------------------------------
                // Stage 1: Requirement Analysis
                // ------------------------------------------------------------------
                if (session.step === 'init' || session.step === 'requirementAnalysis') {
                    sendProgress(ws, session, 'requirementAnalysis', 'Analyzing requirements...');
                    if (!userMsg) {
                        ws.send(JSON.stringify({ type: 'error', message: 'User message required for requirement analysis' }));
                        return;
                    }
                    const raResult = await (0, requirementAnalysisHandler_1.handleRequirementAnalysis)({ userMessage: userMsg, projectId, userId: authedUser.id });
                    if (!raResult.success) {
                        ws.send(JSON.stringify({ type: 'error', message: raResult.error || 'Failed to analyze requirements. Please try again.' }));
                        return;
                    }
                    session.requirements = raResult.data;
                    (0, logger_1.debug)('socket:requirementAnalysis', { projectId });
                    ws.send(JSON.stringify({ type: 'stream', token: 'Got it! Let me clarify a few details about your project.' }));
                    session.step = 'clarification';
                }
                // ------------------------------------------------------------------
                // Stage 2: Clarification (multi-turn)
                // ------------------------------------------------------------------
                while (session.step === 'clarification') {
                    sendProgress(ws, session, 'clarification', 'Clarifying requirements...');
                    const clarInput = {
                        requirements: session.requirements || {},
                        clarificationAnswers: {
                            ...clarificationAnswers,
                            ...(userClarificationAnswers && typeof userClarificationAnswers === 'object' ? userClarificationAnswers : {}),
                        },
                        askedQuestions: askedClarificationQuestions,
                        modification: session.modification,
                        lastQuestion: session.lastClarificationQuestion,
                        lastAnswer: undefined,
                        projectId,
                    };
                    const clarResult = await (0, clarificationHandler_1.handleClarification)(clarInput);
                    if (!clarResult.success) {
                        // Graceful fallback: skip clarification and proceed
                        (0, logger_1.debug)('socket:clarification-fallback', { projectId, error: clarResult.error });
                        ws.send(JSON.stringify({ type: 'stream', token: 'Skipping clarification due to an error. Moving to confirmation.' }));
                        session.step = 'confirmation';
                        break;
                    }
                    session.clarifications = clarResult.data;
                    (0, logger_1.debug)('socket:clarification', { projectId });
                    if (session.clarifications?.question && !session.clarifications.confirmed) {
                        let questionMsg = session.clarifications.question;
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
                        ws.send(JSON.stringify({ type: 'clarification', question: questionMsg }));
                        session.step = 'clarification_wait';
                        return;
                    }
                    else if (session.clarifications && !session.clarifications.confirmed) {
                        ws.send(JSON.stringify({ type: 'confirmation', message: 'Could you please confirm the above details before we proceed?' }));
                        session.step = 'clarification_wait';
                        return;
                    }
                    else {
                        ws.send(JSON.stringify({ type: 'stream', token: 'Thanks for clarifying! Moving to confirmation.' }));
                        session.step = 'confirmation';
                    }
                }
                // ------------------------------------------------------------------
                // Stage 3: Confirmation Gate (multi-turn)
                // ------------------------------------------------------------------
                while (session.step === 'confirmation') {
                    sendProgress(ws, session, 'confirmation', 'Confirming requirements...');
                    if (!session.clarifications) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Clarifications required for confirmation' }));
                        return;
                    }
                    const confResult = await (0, confirmationHandler_1.handleConfirmation)({ clarifications: session.clarifications, projectId });
                    if (!confResult.success) {
                        ws.send(JSON.stringify({ type: 'confirmation', message: confResult.error, context: session.clarifications }));
                        session.step = 'confirmation_wait';
                        return;
                    }
                    session.confirmation = confResult.data;
                    (0, logger_1.debug)('socket:confirmation', { projectId });
                    ws.send(JSON.stringify({ type: 'stream', token: 'All requirements confirmed! I will now design the system.' }));
                    session.step = 'systemDesign';
                }
                // ------------------------------------------------------------------
                // Stage 4: System Design
                // ------------------------------------------------------------------
                if (session.step === 'systemDesign') {
                    sendProgress(ws, session, 'systemDesign', 'Designing system...');
                    const sdResult = await (0, systemDesignHandler_1.handleSystemDesign)({ requirements: session.requirements, projectId });
                    if (!sdResult.success) {
                        ws.send(JSON.stringify({ type: 'error', message: sdResult.error || 'System design failed. Please try again.' }));
                        return;
                    }
                    session.systemDesign = sdResult.data;
                    (0, logger_1.debug)('socket:systemDesign', { projectId });
                    ws.send(JSON.stringify({ type: 'stream', token: 'System design is ready. Generating code...' }));
                    session.step = 'codeGen';
                }
                // ------------------------------------------------------------------
                // Stage 5: Code Generation
                // ------------------------------------------------------------------
                if (session.step === 'codeGen') {
                    sendProgress(ws, session, 'codeGen', 'Generating code...', 0);
                    const cgResult = await (0, codeGenerationHandler_1.handleCodeGeneration)({
                        systemDesign: session.systemDesign,
                        requirements: session.requirements,
                        projectId,
                        userId: authedUser.id,
                    });
                    if (!cgResult.success) {
                        ws.send(JSON.stringify({ type: 'error', message: cgResult.error || 'Code generation failed. Please try again.' }));
                        return;
                    }
                    session.codeGen = cgResult.data;
                    const materialized = await (0, projectFactory_1.materializeProjectWorkspace)({ projectId, codeGen: session.codeGen });
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
                    (0, logger_1.debug)('socket:codeGen', { projectId });
                    sendProgress(ws, session, 'codeGen', 'Code generation complete.', 1);
                    ws.send(JSON.stringify({ type: 'stream', token: 'Code generated! Running tests and fixes...' }));
                    session.step = 'testFix';
                }
                // ------------------------------------------------------------------
                // Stage 6: Test & Fix
                // ------------------------------------------------------------------
                if (session.step === 'testFix') {
                    sendProgress(ws, session, 'testFix', 'Testing and fixing...', 0);
                    const tfResult = await (0, testFixHandler_1.handleTestFix)({
                        buildFn: async () => {
                            const result = await (0, buildWorker_1.runBuildWorker)({ workspaceDir: session.workspaceDir });
                            if (result.success) {
                                session.buildDir = result.buildDir;
                            }
                            return { success: result.success, logs: result.logs };
                        },
                        fixFn: async (logs) => {
                            ws.send(JSON.stringify({ type: 'stream', token: 'Build failed — asking AI to fix errors...' }));
                            const fixResult = await (0, codeGenerationHandler_1.handleCodeGeneration)({
                                systemDesign: session.systemDesign,
                                requirements: session.requirements,
                                modification: `Fix these build errors and produce corrected files:\n${logs.slice(-1500)}`,
                                projectId,
                                userId: authedUser.id,
                            });
                            if (!fixResult.success) {
                                // Log but don't throw — testFixAgent will retry with the same code
                                (0, logger_1.debug)('socket:testFix-fixFn-failed', { projectId, error: fixResult.error });
                                return;
                            }
                            const fixedCodeGen = fixResult.data;
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
                        files: session.codeGen?.files,
                        workspaceDir: session.workspaceDir,
                        projectId,
                    });
                    if (!tfResult.success) {
                        // Non-fatal: warn but continue to deployment with whatever build output exists
                        (0, logger_1.debug)('socket:testFix-failed', { projectId, error: tfResult.error });
                        ws.send(JSON.stringify({ type: 'stream', token: 'Tests encountered issues. Attempting deployment with current build...' }));
                    }
                    else {
                        session.testResult = tfResult.data;
                    }
                    (0, logger_1.debug)('socket:testFix', { projectId, success: tfResult.success });
                    sendProgress(ws, session, 'testFix', 'Testing complete.', 1);
                    ws.send(JSON.stringify({ type: 'stream', token: 'Tests complete! Deploying your project...' }));
                    session.step = 'deploy';
                }
                // ------------------------------------------------------------------
                // Stage 7: Deployment
                // ------------------------------------------------------------------
                if (session.step === 'deploy') {
                    sendProgress(ws, session, 'deploy', 'Deploying...', 0);
                    if (!session.buildDir || !session.activeRevisionId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Build artifact missing for deployment. Please try again.' }));
                        return;
                    }
                    const deployResult = await (0, deploymentHandler_1.handleDeployment)({
                        projectId,
                        revisionId: session.activeRevisionId,
                        buildDir: session.buildDir,
                        frontendProjectName: `proj-${projectId.slice(0, 10)}`,
                        backendService: 'backend',
                        hasBackend: Boolean(session.systemDesign?.backend),
                    });
                    if (!deployResult.success) {
                        ws.send(JSON.stringify({ type: 'error', message: deployResult.error || 'Deployment failed. Please try again later.' }));
                        return;
                    }
                    session.deployment = deployResult.data;
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
                    (0, logger_1.debug)('socket:deploy', { projectId, frontend_url: session.deployment?.frontend_url });
                    const deployedUrl = session.deployment?.frontend_url || '';
                    ws.send(JSON.stringify({ type: 'stream', token: `Your project is deployed! 🎉${deployedUrl ? `\n\n🔗 Live URL: ${deployedUrl}` : ''}` }));
                    if (session.deployment?.frontend_access_warning) {
                        ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
                    }
                    if (session.workspaceDir)
                        void (0, buildWorker_1.cleanupWorkspace)(session.workspaceDir);
                    sendProgress(ws, session, 'deploy', 'Deployment queued.', 1);
                    session.step = 'done';
                }
                if (session.step === 'done') {
                    (0, logger_1.debug)('socket:done', { projectId });
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
                (0, logger_1.error)('socket:runFlow', err);
                ws.send(JSON.stringify({ type: 'error', message: 'Oh no, something went wrong. Please try again or start a new session.' }));
            }
            finally {
                activePipelines.delete(projectId);
            }
        }
        // -----------------------------------------------------------------------
        // Message router
        // -----------------------------------------------------------------------
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
            // Modification request (can come at any time after initial flow)
            if (typeof msg === 'object' && msg.type === 'modification' && msg.modification) {
                session.step = 'modification';
                session.modification = msg.modification;
                session.modificationContext = msg.context || {};
                const clarResult = await (0, clarificationHandler_1.handleClarification)({
                    requirements: session.requirements,
                    clarificationAnswers,
                    askedQuestions: [],
                    modification: session.modification,
                    projectId,
                });
                if (!clarResult.success || !clarResult.data?.question) {
                    session.step = 'codeGen_modification';
                }
                else {
                    ws.send(JSON.stringify({ type: 'clarification', question: clarResult.data.question }));
                    session.step = 'clarification_wait_modification';
                    session.lastClarificationQuestion = clarResult.data.question;
                    return;
                }
            }
            // Handle clarification answer for modification
            if (session.step === 'clarification_wait_modification') {
                const answer = typeof msg === 'object' ? msg.answer : msg;
                if (session.lastClarificationQuestion) {
                    clarificationAnswers[session.lastClarificationQuestion] = answer;
                }
                const clarResult = await (0, clarificationHandler_1.handleClarification)({
                    requirements: session.requirements,
                    clarificationAnswers,
                    askedQuestions: [],
                    modification: session.modification,
                    lastQuestion: session.lastClarificationQuestion,
                    lastAnswer: answer,
                    projectId,
                });
                if (!clarResult.success || !clarResult.data?.question) {
                    session.step = 'codeGen_modification';
                }
                else {
                    ws.send(JSON.stringify({ type: 'clarification', question: clarResult.data.question }));
                    session.lastClarificationQuestion = clarResult.data.question;
                    return;
                }
            }
            // Code generation for modification
            if (session.step === 'codeGen_modification') {
                sendProgress(ws, session, 'codeGen_modification', 'Generating code patch for modification...', 0);
                const cgResult = await (0, codeGenerationHandler_1.handleCodeGeneration)({
                    systemDesign: session.systemDesign,
                    requirements: session.requirements,
                    modification: session.modification,
                    context: session.modificationContext,
                    projectId,
                    userId: authedUser.id,
                });
                if (!cgResult.success) {
                    ws.send(JSON.stringify({ type: 'error', message: cgResult.error || 'Code generation for modification failed. Please try again.' }));
                    return;
                }
                session.codeGen = cgResult.data;
                const materialized = await (0, projectFactory_1.materializeProjectWorkspace)({ projectId, codeGen: session.codeGen });
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
                ws.send(JSON.stringify({ type: 'stream', token: 'Code patch generated. Proceeding to tests...' }));
                session.step = 'testFix_modification';
            }
            // Test & Fix for modification
            if (session.step === 'testFix_modification') {
                sendProgress(ws, session, 'testFix_modification', 'Testing and fixing modification...', 0);
                const tfResult = await (0, testFixHandler_1.handleTestFix)({
                    buildFn: async () => {
                        const result = await (0, buildWorker_1.runBuildWorker)({ workspaceDir: session.workspaceDir });
                        if (result.success) {
                            session.buildDir = result.buildDir;
                        }
                        return { success: result.success, logs: result.logs };
                    },
                    fixFn: async (logs) => {
                        ws.send(JSON.stringify({ type: 'stream', token: 'Build failed — asking AI to fix errors...' }));
                        const fixResult = await (0, codeGenerationHandler_1.handleCodeGeneration)({
                            systemDesign: session.systemDesign,
                            requirements: session.requirements,
                            modification: `Fix these build errors and produce corrected files:\n${logs.slice(-1500)}`,
                            projectId,
                            userId: authedUser.id,
                        });
                        if (!fixResult.success) {
                            (0, logger_1.debug)('socket:testFix_modification-fixFn-failed', { projectId, error: fixResult.error });
                            return;
                        }
                        const fixedCodeGen = fixResult.data;
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
                    files: session.codeGen?.files,
                    workspaceDir: session.workspaceDir,
                    projectId,
                });
                if (!tfResult.success) {
                    (0, logger_1.debug)('socket:testFix_modification-failed', { projectId, error: tfResult.error });
                    ws.send(JSON.stringify({ type: 'stream', token: 'Tests encountered issues. Attempting deployment with current build...' }));
                }
                else {
                    session.testResult = tfResult.data;
                }
                ws.send(JSON.stringify({ type: 'stream', token: 'Tests complete. Deploying your project...' }));
                session.step = 'deploy_modification';
            }
            // Deploy modification
            if (session.step === 'deploy_modification') {
                sendProgress(ws, session, 'deploy_modification', 'Deploying modification...', 1);
                if (!session.buildDir || !session.activeRevisionId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Build artifact missing for deployment.' }));
                    return;
                }
                const deployResult = await (0, deploymentHandler_1.handleDeployment)({
                    projectId,
                    revisionId: session.activeRevisionId,
                    buildDir: session.buildDir,
                    frontendProjectName: `proj-${projectId.slice(0, 10)}`,
                    backendService: 'backend',
                    hasBackend: Boolean(session.systemDesign?.backend),
                });
                if (!deployResult.success) {
                    ws.send(JSON.stringify({ type: 'error', message: deployResult.error || 'Deployment for modification failed. Please try again.' }));
                    return;
                }
                session.deployment = deployResult.data;
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
                ws.send(JSON.stringify({ type: 'stream', token: 'Deployment complete!' }));
                if (session.deployment?.frontend_access_warning) {
                    ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
                }
                if (session.workspaceDir)
                    void (0, buildWorker_1.cleanupWorkspace)(session.workspaceDir);
                session.step = 'done_modification';
            }
            if (session.step === 'done_modification') {
                ws.send(JSON.stringify({ type: 'done', modification: true }));
                session.step = 'done';
                session.modification = undefined;
                session.modificationContext = undefined;
                clarificationAnswers = {};
                askedClarificationQuestions = [];
                return;
            }
            // --- Original flow routing ---
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
