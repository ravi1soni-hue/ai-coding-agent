import { Server } from 'ws';
import http from 'http';

import { handleRequirementAnalysis } from './handlers/requirementAnalysisHandler';
import { handleClarification } from './handlers/clarificationHandler';
import { handleConfirmation } from './handlers/confirmationHandler';
import { handleSystemDesign } from './handlers/systemDesignHandler';
import { handleUISpec } from './handlers/uiSpecHandler';
import { handleBlueprint } from './handlers/blueprintHandler';
import { handleCodeGeneration } from './handlers/codeGenerationHandler';
import { handleTestFix } from './handlers/testFixHandler';
import { handleDeployment } from './handlers/deploymentHandler';
import { runBuildWorker, cleanupWorkspace } from '../workers/buildWorker';
import {
  createProjectSession,
  getOrCreateActiveProjectSession,
  getUserFromSessionToken,
  isProjectOwnedByUser,
  parseCookie,
  touchProjectSession,
} from '../auth/authService';
import {
  appendProjectEvent,
  appendProjectTask,
  createProjectCodeRevision,
  getProjectBlackboard,
  getProjectSnapshot,
  listProjectTasks,
  saveProjectDeployment,
  updateProjectSnapshot,
  upsertProjectBlackboard,
} from '../db/projectStore';
import { materializeProjectWorkspace } from '../factory/projectFactory';
import { consolidateProjectSpec, validateProjectSpec } from '../agents/projectSpec';
import { formatConsistencyIssues, validateProjectConsistency } from '../agents/projectConsistency';
import { config } from '../config/env';
import { debug, error as logError } from '../utils/logger';
import { toClientErrorMessage } from '../utils/errors';
import { TTLSet } from '../utils/ttlSet';

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

function requiresBackendArchitecture(requirements: any): boolean {
  return Boolean(requirements?.backend_required || requirements?.auth_required);
}

function buildFrontendOnlySystemDesign(requirements: any) {
  return {
    frontend: {
      framework: 'react-vite',
      pages: Array.isArray(requirements?.pages) ? requirements.pages : [],
      components: [],
      styling: 'css',
    },
    backend: null,
    database: null,
    auth: null,
    hosting: {
      frontend: 'vercel',
      backend: null,
    },
  };
}

export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });
  const activePipelines = new TTLSet();

  const stageWeights: Record<string, number> = {
    requirementAnalysis: 0.08,
    clarification: 0.10,
    confirmation: 0.05,
    systemDesign: 0.08,
    uiSpec: 0.05,
    blueprint: 0.06,
    codeGen: 0.22,
    testFix: 0.18,
    deploy: 0.17,
    codeGen_modification: 0.20,
    testFix_modification: 0.15,
    deploy_modification: 0.17,
  };

  function applyStageProgress(session: any, stage: string) {
    if (session.progressStages[stage]) return;
    session.progressStages[stage] = true;
    session.progress = Math.min(1, session.progress + (stageWeights[stage] || 0));
  }

  function sendProgress(ws: any, session: any, stage: string, status: string, stageProgress?: number) {
    applyStageProgress(session, stage);
    const payload: any = { type: 'progress', progress: Number(session.progress.toFixed(4)), status, stage };
    if (typeof stageProgress === 'number') payload.stageProgress = Math.max(0, Math.min(1, stageProgress));
    ws.send(JSON.stringify(payload));
  }

  function sendError(ws: any, session: any, message: string, retryable = true) {
    ws.send(JSON.stringify({
      type: 'error',
      message,
      retryable,
      step: session.step,
    }));
  }

  wss.on('connection', async (ws, request) => {
    // Origin check
    const allowedOrigins = config.WS_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
    const origin = request.headers.origin || '';
    if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
      ws.send(JSON.stringify({ type: 'error', message: 'WebSocket origin not allowed.' }));
      ws.close();
      return;
    }

    // Auth
    const cookies = parseCookie(request.headers.cookie);
    const token = cookies.sid;
    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication required.' }));
      ws.close();
      return;
    }
    const user = await getUserFromSessionToken(token);
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session expired. Please login again.' }));
      ws.close();
      return;
    }
    const authedUser = user;

    // Project routing
    const url = new URL(request.url || '/', 'http://localhost');
    const requestedProjectId = url.searchParams.get('projectId');
    let projectId = await getOrCreateActiveProjectSession(authedUser.id);
    if (requestedProjectId) {
      const owned = await isProjectOwnedByUser(authedUser.id, requestedProjectId);
      projectId = owned ? requestedProjectId : await createProjectSession(authedUser.id);
    }
    await touchProjectSession(authedUser.id, projectId);

    // Intercept ws.send for persistence
    const wsAny = ws as any;
    const sendRaw = ws.send.bind(ws);
    wsAny.send = (data: any) => {
      sendRaw(data);
      try {
        const payload = typeof data === 'string' ? JSON.parse(data) : null;
        if (!payload || typeof payload !== 'object') return;
        const roleMap: Record<string, string> = {
          info: 'system', progress: 'system', stream: 'assistant',
          clarification: 'assistant', confirmation: 'assistant', error: 'error', done: 'system',
        };
        const text = payload.message ?? payload.token ?? payload.question ?? payload.status
          ?? (payload.type ? String(payload.type) : null);
        void appendProjectEvent({
          projectId, userId: authedUser.id,
          eventType: payload.type || 'outbound',
          role: roleMap[payload.type] ?? 'system',
          message: text, payload,
        });
        if (payload.type === 'progress') {
          void updateProjectSnapshot({
            projectId, userId: authedUser.id,
            status: 'active', currentStep: session.step,
            progress: Number(payload.progress) || 0,
          });
        }
        if (payload.type === 'error') {
          void updateProjectSnapshot({
            projectId, userId: authedUser.id,
            status: 'failed', currentStep: session.step,
          });
        }
        if (payload.type === 'done') {
          void updateProjectSnapshot({
            projectId, userId: authedUser.id,
            status: 'completed', currentStep: 'done', progress: 1,
            requirements: session.requirements,
            clarifications: session.clarifications,
            confirmation: session.confirmation,
            systemDesign: session.systemDesign,
            uiSpec: session.uiSpec,
            blueprint: session.blueprint,
            codeGen: session.codeGen,
            testResult: session.testResult,
            deployment: session.deployment,
          });
        }
      } catch { /* non-JSON frames silently skipped */ }
    };

    ws.send(JSON.stringify({ type: 'info', message: 'Connected!' }));

    const snapshot = await getProjectSnapshot({ userId: authedUser.id, projectId });
    const blackboardSnapshot = await getProjectBlackboard({ userId: authedUser.id, projectId });

    // Session state
    type Session = {
      progress: number;
      step: string;
      requirements: any;
      clarifications: any;
      confirmation: any;
      systemDesign: any;
      uiSpec?: any;
      blueprint?: any;
      codeGen: any;
      testResult: any;
      deployment: any;
      context: Record<string, any>;
      modification?: string;
      modificationContext?: any;
      lastClarificationQuestion?: string;
      activeRevisionId?: string;
      workspaceDir?: string;
      sourceArchivePath?: string;
      sourceHash?: string;
      buildDir?: string;
      backendDir?: string;
      codeRevisionDbId?: string;
      progressStages: Record<string, boolean>;
      stepRetries: Record<string, number>;
    };

    const session: Session = {
      progress: Number(snapshot?.progress || blackboardSnapshot?.progress) || 0,
      step: snapshot?.current_step || blackboardSnapshot?.currentStage || 'init',
      requirements: snapshot?.requirements,
      clarifications: snapshot?.clarifications,
      confirmation: snapshot?.confirmation,
      systemDesign: snapshot?.system_design,
      uiSpec: snapshot?.ui_spec,
      blueprint: undefined,
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
      backendDir: undefined,
      codeRevisionDbId: undefined,
      progressStages: {},
      stepRetries: {},
    };

    // Reset completed projects so a new message starts fresh
    if (session.step === 'done' || session.step === 'done_modification') {
      session.step = 'init';
      session.progress = 0;
      session.progressStages = {};
      session.stepRetries = {};
    }

      let clarificationAnswers: Record<string, string> =
      session.clarifications?.context?.clarificationAnswers &&
      typeof session.clarifications.context.clarificationAnswers === 'object'
        ? { ...session.clarifications.context.clarificationAnswers }
        : {};

    let askedClarificationQuestions: string[] =
      Array.isArray(session.clarifications?.context?.askedQuestions)
        ? [...session.clarifications.context.askedQuestions]
        : [];

    let pendingClarificationQuestions: string[] =
      Array.isArray(session.clarifications?.questions)
        ? [...session.clarifications.questions]
        : [];
    let pendingClarificationIndex = 0;

    function buildProjectSpec(overrides: { systemDesign?: any; uiSpec?: any; blueprint?: any; modification?: string; confirmations?: any } = {}) {
      if (!session.requirements || !session.clarifications) {
        return undefined;
      }
      const spec = consolidateProjectSpec({
        projectId,
        userMessage: session.requirements?.userMessage || '',
        requirements: session.requirements,
        clarifications: session.clarifications,
        clarificationAnswers,
        systemDesign: overrides.systemDesign ?? session.systemDesign,
        uiSpec: overrides.uiSpec ?? session.uiSpec,
        blueprint: overrides.blueprint ?? session.blueprint,
        modification: overrides.modification ?? session.modification,
      });
      return validateProjectSpec(spec);
    }

    function assertConsistencyOrThrow(projectSpec: any, context: { systemDesign?: any; uiSpec?: any; blueprint?: any; codeGen?: any }) {
      const report = validateProjectConsistency({
        projectSpec,
        requirementAnalysis: session.requirements,
        clarifications: session.clarifications,
        systemDesign: context.systemDesign ?? session.systemDesign,
        uiSpec: context.uiSpec ?? session.uiSpec,
        blueprint: context.blueprint ?? session.blueprint,
        codeGen: context.codeGen ?? session.codeGen,
      });
      if (!report.ok) {
        throw new Error(`Cross-stage consistency validation failed:\n${formatConsistencyIssues(report)}`);
      }
    }

    // -----------------------------------------------------------------------
    // Helper: rematerialize code into workspace
    // -----------------------------------------------------------------------
    async function persistBlackboardState(): Promise<void> {
      await upsertProjectBlackboard({
        projectId,
        userId: authedUser.id,
        state: {
          sessionId: projectId,
          deployment: {
            frontendUrl: session.deployment?.frontend_url || null,
            backendUrl: session.deployment?.backend_url || null,
            dbStatus: 'ready',
          },
          blueprint: session.systemDesign || null,
          taskQueue: await listProjectTasks({ projectId, userId: authedUser.id }).catch(() => []),
          terminalLogs: [],
          currentStage: session.step,
          status: session.step === 'done' ? 'completed' : 'active',
          progress: session.progress,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    async function rematerializeAndStore(codeGenData: any): Promise<void> {
      const mat = await materializeProjectWorkspace({ projectId, codeGen: codeGenData });
      session.activeRevisionId = mat.revisionId;
      session.workspaceDir = mat.workspaceDir;
      session.sourceArchivePath = mat.archivePath;
      session.sourceHash = mat.sourceHash;
      session.codeRevisionDbId = await createProjectCodeRevision({
        projectId,
        userId: authedUser.id,
        workspacePath: mat.workspaceDir,
        sourceArchivePath: mat.archivePath,
        sourceHash: mat.sourceHash,
        patchPath: mat.patchPath,
        patchApplied: mat.patchApplied,
        patchApplyLog: mat.patchApplyLog,
        generationPayload: codeGenData,
      });
      await persistBlackboardState();
    }

    // -----------------------------------------------------------------------
    // Helper: build + fix loop (shared between main and modification flows)
    // -----------------------------------------------------------------------
    async function runBuildAndFix(flowLabel: string): Promise<boolean> {
      sendProgress(ws, session, flowLabel, 'Building and testing...', 0);
      const tfResult = await handleTestFix({
        buildFn: async () => {
          const result = await runBuildWorker({ workspaceDir: session.workspaceDir });
          if (result.success) {
            session.buildDir = result.buildDir;
            session.backendDir = result.backendDir;
          }
          return { success: result.success, logs: result.logs };
        },
        fixFn: async (logs: string) => {
          const logPrefix = '--- buildWorker logs (raw) ---\n';
          const logSuffix = '\n--- end buildWorker logs ---';
          const normalizedLogs = typeof logs === 'string' ? logs : String(logs);

          // Chunk large logs so the UI can render them reliably.
          const chunkSize = 8000;

          ws.send(JSON.stringify({
            type: 'stream',
            token: `${logPrefix}${normalizedLogs.slice(0, chunkSize)}`,
          }));

          for (let i = chunkSize; i < normalizedLogs.length; i += chunkSize) {
            ws.send(JSON.stringify({
              type: 'stream',
              token: normalizedLogs.slice(i, i + chunkSize),
            }));
          }

          if (normalizedLogs.length === 0) {
            ws.send(JSON.stringify({ type: 'stream', token: '(no build logs captured)' }));
          } else {
            ws.send(JSON.stringify({ type: 'stream', token: logSuffix }));
          }

          ws.send(JSON.stringify({ type: 'stream', token: 'Build failed — asking AI to fix errors...' }));

          const fixResult = await handleCodeGeneration({
            systemDesign: session.systemDesign,
            requirements: {
              ...session.requirements,
              clarificationAnswers: Object.keys(clarificationAnswers).length > 0 ? clarificationAnswers : undefined,
            },
            blueprint: session.blueprint,
            uiSpec: session.uiSpec,
            modification: `Fix these build errors and produce corrected complete files:\n${normalizedLogs.slice(-2000)}`,
            projectId,
            userId: authedUser.id,
            emitEvent: (event) => ws.send(JSON.stringify({
              type: event.type,
              message: event.message,
              token: event.token,
              filePath: event.filePath,
              payload: event.payload,
            })),
          });
          if (!fixResult.success) {
            debug(`socket:${flowLabel}-fixFn-failed`, { projectId, error: fixResult.error });
            return;
          }
          session.codeGen = fixResult.data;
          await rematerializeAndStore(fixResult.data);
        },
        files: session.codeGen?.files,
        workspaceDir: session.workspaceDir,
        projectId,
      });

      if (!tfResult.success) {
        // BLOCK deployment — do not deploy broken code
        sendError(
          ws,
          session,
          `Build failed after all fix attempts. ${tfResult.error || 'Check generated code.'} Reply to retry code generation.`
        );
        session.step = 'codeGen'; // step back to codeGen so retry regenerates code
        return false;
      }

      session.testResult = tfResult.data;
      sendProgress(ws, session, flowLabel, 'Build passed!', 1);
      return true;
    }

    // -----------------------------------------------------------------------
    // Helper: save deployment to DB
    // -----------------------------------------------------------------------
    async function persistDeployment(): Promise<void> {
      await saveProjectDeployment({
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
    }

    // -----------------------------------------------------------------------
    // Main pipeline — each stage handles its own errors and retries
    // -----------------------------------------------------------------------
    async function runFlow(userMsg: string | null, userClarificationAnswers: Record<string, any> | null = null) {
      if (activePipelines.has(projectId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Pipeline already running. Please wait.' }));
        return;
      }
      activePipelines.add(projectId);

      try {
        // ── Stage 1: Requirement Analysis ──────────────────────────────────
        if (session.step === 'init' || session.step === 'requirementAnalysis') {
          sendProgress(ws, session, 'requirementAnalysis', 'Analyzing your requirements...');
          if (!userMsg) {
            sendError(ws, session, 'Please describe what you want to build.');
            return;
          }
          const raResult = await handleRequirementAnalysis({ userMessage: userMsg, projectId, userId: authedUser.id });
          if (!raResult.success) {
            session.step = 'requirementAnalysis'; // stay here so user can retry
            sendError(ws, session, toClientErrorMessage(raResult.error, 'Failed to analyze requirements. Please try again.'));
            return;
          }
          session.requirements = { ...raResult.data, userMessage: userMsg };
          await appendProjectTask({
            projectId,
            userId: authedUser.id,
            phase: 'PM',
            action: 'ANALYZE_REQUIREMENTS',
            status: 'completed',
            payload: raResult.data,
            priority: 10,
          });
          session.stepRetries['requirementAnalysis'] = 0;
          debug('socket:requirementAnalysis', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Got it! Let me ask a couple of quick questions.' }));
          session.step = 'clarification';
        }

        // ── Stage 2: Clarification (multi-question queue) ─────────────────
        while (session.step === 'clarification') {
          sendProgress(ws, session, 'clarification', 'Clarifying requirements...');

          if (pendingClarificationQuestions.length > 0 && pendingClarificationIndex < pendingClarificationQuestions.length) {
            const questionMsg = pendingClarificationQuestions[pendingClarificationIndex];
            pendingClarificationIndex += 1;
            session.lastClarificationQuestion = questionMsg;
            askedClarificationQuestions.push(questionMsg);
            ws.send(JSON.stringify({ type: 'clarification', question: questionMsg }));
            session.step = 'clarification_wait';
            return;
          }

          const clarInput = {
            requirements: session.requirements || {},
            clarificationAnswers: {
              ...clarificationAnswers,
              ...(userClarificationAnswers && typeof userClarificationAnswers === 'object' ? userClarificationAnswers : {}),
            },
            askedQuestions: askedClarificationQuestions,
            modification: session.modification,
            lastQuestion: session.lastClarificationQuestion,
            lastAnswer: undefined as string | undefined,
            projectId,
          };

          const clarResult = await handleClarification(clarInput);

          if (!clarResult.success) {
            debug('socket:clarification-fallback', { projectId, error: clarResult.error });
            ws.send(JSON.stringify({ type: 'stream', token: 'Skipping clarification, proceeding with what we have.' }));
            session.step = 'confirmation';
            break;
          }

          session.clarifications = clarResult.data;
          pendingClarificationQuestions = Array.isArray(session.clarifications?.questions) ? [...session.clarifications.questions] : [];
          pendingClarificationIndex = 0;
          debug('socket:clarification', { projectId, questionCount: pendingClarificationQuestions.length });

          if (pendingClarificationQuestions.length > 0) {
            continue;
          }

          ws.send(JSON.stringify({ type: 'stream', token: 'Thanks for the details! Confirming your requirements...' }));
          session.step = 'confirmation';
        }

        // ── Stage 3: Confirmation Gate ─────────────────────────────────────
        while (session.step === 'confirmation') {
          sendProgress(ws, session, 'confirmation', 'Confirming requirements...');
          if (!session.clarifications) {
            if (session.requirements) {
              session.clarifications = { confirmed: true, context: { clarificationAnswers, askedQuestions: askedClarificationQuestions } };
            } else {
              sendError(ws, session, 'Requirements missing. Please start over.');
              return;
            }
          }
          const confResult = await handleConfirmation({ clarifications: session.clarifications, projectId });
          if (!confResult.success) {
            ws.send(JSON.stringify({ type: 'confirmation', message: confResult.error, context: session.clarifications }));
            session.step = 'confirmation_wait';
            return;
          }
          session.confirmation = confResult.data;
          await persistBlackboardState();
          debug('socket:confirmation', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Requirements confirmed! Designing the system now...' }));
          session.step = 'systemDesign';
        }

        // ── Stage 4: System Design ─────────────────────────────────────────
        if (session.step === 'systemDesign') {
          sendProgress(ws, session, 'systemDesign', 'Designing system architecture...');
          const projectSpec = buildProjectSpec();
          if (requiresBackendArchitecture(session.requirements)) {
            const sdResult = await handleSystemDesign({ requirements: session.requirements, projectSpec, projectId });
            if (!sdResult.success) {
              session.step = 'systemDesign'; // stay, allow retry
              sendError(ws, session, toClientErrorMessage(sdResult.error, 'System design failed. Reply to retry.'));
              return;
            }
            session.systemDesign = sdResult.data;
          } else {
            session.systemDesign = buildFrontendOnlySystemDesign(session.requirements);
          }
          await persistBlackboardState();
          session.stepRetries['systemDesign'] = 0;
          debug('socket:systemDesign', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Architecture ready! Designing UI structure...' }));
          session.step = 'uiSpec';
        }

        // ── Stage 4.5: UI Specification ────────────────────────────────────
        if (session.step === 'uiSpec') {
          sendProgress(ws, session, 'uiSpec', 'Designing UI structure and data flow...');
          const uiSpecResult = await handleUISpec({
            systemDesign: session.systemDesign,
            requirements: session.requirements,
            modification: session.modification,
            projectId,
            userId: authedUser.id,
          });
          if (!uiSpecResult.success) {
            session.step = 'uiSpec'; // stay, allow retry
            sendError(ws, session, toClientErrorMessage(uiSpecResult.error, 'UI specification failed. Reply to retry.'));
            return;
          }
          session.uiSpec = uiSpecResult.data;
          await persistBlackboardState();
          session.stepRetries['uiSpec'] = 0;
          debug('socket:uiSpec', { projectId, componentCount: session.uiSpec?.components?.length });
          ws.send(JSON.stringify({ type: 'stream', token: 'UI structure designed! Planning file architecture...' }));
          session.step = 'blueprint';
        }

        // ── Stage 4.75: Blueprint ──────────────────────────────────────────
        if (session.step === 'blueprint') {
          sendProgress(ws, session, 'blueprint', 'Planning file architecture and API contracts...');
          const bpResult = await handleBlueprint({
            requirements: session.requirements,
            systemDesign: session.systemDesign,
            uiSpec: session.uiSpec,
            projectId,
          });
          if (!bpResult.success) {
            session.step = 'blueprint';
            sendError(ws, session, toClientErrorMessage(bpResult.error, 'Blueprint generation failed. Reply to retry.'));
            return;
          }
          session.blueprint = bpResult.data;
          await persistBlackboardState();
          session.stepRetries['blueprint'] = 0;
          debug('socket:blueprint', { projectId, title: session.blueprint?.title, fileCount: session.blueprint?.files?.length });
          ws.send(JSON.stringify({ type: 'stream', token: 'Architecture blueprint ready! Generating your code now...' }));
          session.step = 'codeGen';
        }

        // ── Stage 5: Code Generation ───────────────────────────────────────
        if (session.step === 'codeGen') {
          sendProgress(ws, session, 'codeGen', 'Generating code...', 0);
          const cgResult = await handleCodeGeneration({
            systemDesign: session.systemDesign,
            requirements: {
              ...session.requirements,
              clarificationAnswers: Object.keys(clarificationAnswers).length > 0 ? clarificationAnswers : undefined,
            },
            blueprint: session.blueprint,
            uiSpec: session.uiSpec,
            projectId,
            userId: authedUser.id,
            emitEvent: (event) => ws.send(JSON.stringify({
              type: event.type,
              message: event.message,
              token: event.token,
              filePath: event.filePath,
              payload: event.payload,
            })),
          });
          if (!cgResult.success) {
            session.step = 'codeGen'; // stay, allow retry
            sendError(ws, session, toClientErrorMessage(cgResult.error, 'Code generation failed. Reply to retry.'));
            return;
          }
          session.codeGen = cgResult.data;
          await rematerializeAndStore(cgResult.data);
          session.stepRetries['codeGen'] = 0;
          debug('socket:codeGen', { projectId, fileCount: session.codeGen?.files?.length });
          sendProgress(ws, session, 'codeGen', 'Code generated!', 1);
          const genFiles = Array.isArray(session.codeGen?.files) ? session.codeGen.files : [];
          const fileCount = genFiles.length;
          const previewPaths = genFiles.slice(0, 20).map((f: any) => f?.path).filter(Boolean) as string[];

          ws.send(JSON.stringify({
            type: 'stream',
            token: `Code generated ✅ (${fileCount} files).` +
              (previewPaths.length ? `\nFiles: ${previewPaths.join(', ')}${fileCount > previewPaths.length ? ', …' : ''}` : '') +
              `\nBuilding and testing...`,
          }));
          session.step = 'testFix';
        }

        // ── Stage 6: Test & Fix ────────────────────────────────────────────
        if (session.step === 'testFix') {
          const buildPassed = await runBuildAndFix('testFix');
          if (!buildPassed) return; // error already sent, step set back to codeGen
          debug('socket:testFix', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Build passed! Deploying your project...' }));
          session.step = 'deploy';
        }

        // ── Stage 7: Deployment ────────────────────────────────────────────
        if (session.step === 'deploy') {
          sendProgress(ws, session, 'deploy', 'Deploying...', 0);
          if (!session.buildDir || !session.activeRevisionId) {
            sendError(ws, session, 'Build output missing. Reply to retry from code generation.');
            session.step = 'codeGen';
            return;
          }
          const deployResult = await handleDeployment({
            projectId,
            revisionId: session.activeRevisionId,
            buildDir: session.buildDir,
            backendDir: session.backendDir,
            frontendProjectName: `proj-${projectId.slice(0, 10)}`,
            backendService: 'backend',
            hasBackend: Boolean(session.systemDesign?.backend),
          });

          if (!deployResult.success) {
            session.step = 'deploy'; // stay, allow retry
            sendError(ws, session, toClientErrorMessage(deployResult.error, 'Deployment failed. Reply to retry.'));
            return;
          }

          session.deployment = deployResult.data;
          await persistDeployment();
          await persistBlackboardState();

          debug('socket:deploy', { projectId, frontend_url: session.deployment?.frontend_url });
          const frontendUrl = session.deployment?.frontend_url || '';
          const backendUrl = session.deployment?.backend_url || '';
          ws.send(JSON.stringify({ type: 'stream', token: `Project deployed! 🎉\n\n🔗 Frontend: ${frontendUrl}${backendUrl ? `\n🔗 Backend: ${backendUrl}` : ''}` }));
          if (session.deployment?.frontend_access_warning) {
            ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
          }
          if (session.workspaceDir) void cleanupWorkspace(session.workspaceDir);
          sendProgress(ws, session, 'deploy', 'Deployment complete!', 1);
          session.step = 'done';
        }

        if (session.step === 'done') {
          debug('socket:done', { projectId });
          await touchProjectSession(authedUser.id, projectId);
          ws.send(JSON.stringify({
            type: 'done',
            projectId,
            message: 'Project complete! You can now send feedback or changes to update it.',
            frontend_url: session.deployment?.frontend_url || null,
            backend_url: session.deployment?.backend_url || null,
            vercel_inspect_url: session.deployment?.vercel_inspect_url || null,
            frontend_access_warning: session.deployment?.frontend_access_warning || null,
          }));
        }

      } catch (err) {
        logError('socket:runFlow', err);
        sendError(ws, session, toClientErrorMessage(err, 'Something went wrong. Reply to retry from the current step.'));
      } finally {
        activePipelines.delete(projectId);
      }
    }

    // -----------------------------------------------------------------------
    // Modification pipeline (re-uses same build/deploy helpers)
    // -----------------------------------------------------------------------
    async function runModificationFlow(modification: string) {
      if (activePipelines.has(projectId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Pipeline already running. Please wait.' }));
        return;
      }
      activePipelines.add(projectId);

      try {
        // Step 1: Clarify modification (preserving existing questions)
        const clarResult = await handleClarification({
          requirements: session.requirements,
          clarificationAnswers,
          askedQuestions: askedClarificationQuestions, // PRESERVE — don't reset
          modification,
          projectId,
        });

        if (clarResult.success && clarResult.data?.question && !clarResult.data?.confirmed) {
          ws.send(JSON.stringify({ type: 'clarification', question: clarResult.data.question }));
          session.step = 'clarification_wait_modification';
          session.lastClarificationQuestion = clarResult.data.question;
          return;
        }

        session.step = 'codeGen_modification';

        // Step 2: Re-run system design if modification is architectural
        sendProgress(ws, session, 'systemDesign', 'Re-evaluating architecture for your changes...');
        const projectSpec = buildProjectSpec({ modification });
        const sdResult = await handleSystemDesign({ requirements: session.requirements, projectSpec, modification, projectId });
        if (sdResult.success) {
          session.systemDesign = sdResult.data;
        }

        session.step = 'uiSpec_modification';

        // Step 2.5: Re-generate UI spec for modifications
        sendProgress(ws, session, 'uiSpec_modification', 'Re-evaluating UI structure for your changes...');
        const uiSpecResult = await handleUISpec({
          systemDesign: session.systemDesign,
          requirements: session.requirements,
          modification,
          projectId,
          userId: authedUser.id,
        });
        if (uiSpecResult.success) {
          session.uiSpec = uiSpecResult.data;
        }

        // Step 2.75: Re-generate blueprint for modifications
        sendProgress(ws, session, 'blueprint', 'Re-planning architecture for your changes...');
        const bpModResult = await handleBlueprint({
          requirements: session.requirements,
          systemDesign: session.systemDesign,
          uiSpec: session.uiSpec,
          modification,
          projectId,
        });
        if (bpModResult.success) {
          session.blueprint = bpModResult.data;
        }

        session.step = 'codeGen_modification';

        // Step 3: Code generation
        sendProgress(ws, session, 'codeGen_modification', 'Generating updated code...', 0);
        const cgResult = await handleCodeGeneration({
          systemDesign: session.systemDesign,
          requirements: session.requirements,
          blueprint: session.blueprint,
          modification,
          uiSpec: session.uiSpec,
          context: session.modificationContext,
          projectId,
          userId: authedUser.id,
          emitEvent: (event) => ws.send(JSON.stringify({
            type: event.type,
            message: event.message,
            token: event.token,
            filePath: event.filePath,
            payload: event.payload,
          })),
        });

        if (!cgResult.success) {
          session.step = 'codeGen_modification';
          sendError(ws, session, toClientErrorMessage(cgResult.error, 'Code generation for modification failed. Reply to retry.'));
          return;
        }

        session.codeGen = cgResult.data;
        await rematerializeAndStore(cgResult.data);
        sendProgress(ws, session, 'codeGen_modification', 'Updated code generated!', 1);
        const modFiles = Array.isArray(session.codeGen?.files) ? session.codeGen.files : [];
        const modFileCount = modFiles.length;
        const modPreviewPaths = modFiles.slice(0, 20).map((f: any) => f?.path).filter(Boolean) as string[];

        ws.send(JSON.stringify({
          type: 'stream',
          token: `Code updated ✅ (${modFileCount} files).` +
            (modPreviewPaths.length ? `\nFiles: ${modPreviewPaths.join(', ')}${modFileCount > modPreviewPaths.length ? ', …' : ''}` : '') +
            `\nBuilding and testing...`,
        }));
        session.step = 'testFix_modification';

        // Step 4: Build + Fix
        const buildPassed = await runBuildAndFix('testFix_modification');
        if (!buildPassed) return;

        ws.send(JSON.stringify({ type: 'stream', token: 'Build passed! Deploying your updates...' }));
        session.step = 'deploy_modification';

        // Step 5: Deploy
        sendProgress(ws, session, 'deploy_modification', 'Deploying updates...', 0);
        if (!session.buildDir || !session.activeRevisionId) {
          sendError(ws, session, 'Build output missing. Reply to retry.');
          session.step = 'codeGen_modification';
          return;
        }

        const deployResult = await handleDeployment({
          projectId,
          revisionId: session.activeRevisionId,
          buildDir: session.buildDir,
          backendDir: session.backendDir,
          frontendProjectName: `proj-${projectId.slice(0, 10)}`,
          backendService: 'backend',
          hasBackend: Boolean(session.systemDesign?.backend),
        });

        if (!deployResult.success) {
          session.step = 'deploy_modification';
          sendError(ws, session, toClientErrorMessage(deployResult.error, 'Deployment failed. Reply to retry.'));
          return;
        }

        session.deployment = deployResult.data;
        await persistDeployment();
        await persistBlackboardState();

        const frontendUrl = session.deployment?.frontend_url || '';
        const backendUrl = session.deployment?.backend_url || '';
        ws.send(JSON.stringify({ type: 'stream', token: `Updates deployed! 🎉\n\n🔗 Frontend: ${frontendUrl}${backendUrl ? `\n🔗 Backend: ${backendUrl}` : ''}` }));
        if (session.deployment?.frontend_access_warning) {
          ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
        }
        if (session.workspaceDir) void cleanupWorkspace(session.workspaceDir);
        sendProgress(ws, session, 'deploy_modification', 'Deployed!', 1);
        session.step = 'done_modification';

        await touchProjectSession(authedUser.id, projectId);
        ws.send(JSON.stringify({
          type: 'done',
          modification: true,
          projectId,
          message: 'Changes deployed! Send more feedback to keep improving.',
          frontend_url: session.deployment?.frontend_url || null,
          backend_url: session.deployment?.backend_url || null,
          vercel_inspect_url: session.deployment?.vercel_inspect_url || null,
        }));
        session.step = 'done';
        session.modification = undefined;
        session.modificationContext = undefined;

      } catch (err) {
        logError('socket:runModificationFlow', err);
        sendError(ws, session, toClientErrorMessage(err, 'Modification failed. Reply to retry.'));
      } finally {
        activePipelines.delete(projectId);
      }
    }

    // -----------------------------------------------------------------------
    // Message router
    // -----------------------------------------------------------------------
    ws.on('message', async (message) => {
      let msg: any;
      try { msg = JSON.parse(message.toString()); }
      catch { msg = message.toString(); }

      const userText = typeof msg === 'object'
        ? msg.user_message || msg.answer || msg.modification
        : msg;

      if (typeof userText === 'string' && userText.trim()) {
        void appendProjectEvent({
          projectId, userId: authedUser.id,
          eventType: 'user_message', role: 'user',
          message: userText.trim(), payload: msg,
        });
      }

      // ── Modification request (any time after first completion) ──────────
      if (typeof msg === 'object' && msg.type === 'modification' && msg.modification) {
        if (!session.requirements) {
          ws.send(JSON.stringify({ type: 'error', message: 'No project to modify. Please build something first.' }));
          return;
        }
        session.modification = msg.modification;
        session.modificationContext = msg.context || {};
        await runModificationFlow(msg.modification);
        return;
      }

      // ── Clarification answer for modification ───────────────────────────
      if (session.step === 'clarification_wait_modification') {
        const answer = typeof msg === 'object' ? (msg.answer || msg.user_message) : msg;
        if (session.lastClarificationQuestion && typeof answer === 'string' && answer.trim()) {
          clarificationAnswers[session.lastClarificationQuestion] = answer.trim();
          askedClarificationQuestions.push(session.lastClarificationQuestion);
        }
        const modification = session.modification || '';
        session.step = 'codeGen_modification';
        await runModificationFlow(modification);
        return;
      }

      // ── Original flow: clarification answer ─────────────────────────────
      if (session.step === 'clarification_wait') {
        const answer = typeof msg === 'object' ? (msg.answer || msg.user_message) : msg;
        if (session.lastClarificationQuestion && typeof answer === 'string' && answer.trim()) {
          clarificationAnswers[session.lastClarificationQuestion] = answer.trim();
          pendingClarificationQuestions = pendingClarificationQuestions.filter((question) => question !== session.lastClarificationQuestion);
        }
        session.lastClarificationQuestion = undefined;
        session.step = 'clarification';
        await runFlow(null, { ...clarificationAnswers });
        return;
      }

      // ── Original flow: confirmation answer ──────────────────────────────
      if (session.step === 'confirmation_wait') {
        if (session.clarifications) session.clarifications.confirmed = true;
        session.step = 'confirmation';
        await runFlow(null, null);
        return;
      }

      // ── Retry from a failed/paused step ─────────────────────────────────
      if (session.step !== 'init' && session.step !== 'done') {
        if (typeof userText === 'string' && userText.trim()) {
          const retryableSteps = [
            'requirementAnalysis', 'systemDesign', 'uiSpec', 'blueprint', 'codeGen', 'testFix', 'deploy',
            'codeGen_modification', 'testFix_modification', 'deploy_modification',
          ];
          if (retryableSteps.includes(session.step)) {
            // Retry from current step (don't reset)
            ws.send(JSON.stringify({ type: 'stream', token: `Retrying from step: ${session.step}...` }));
            await runFlow(userText, null);
            return;
          }

          // For any other stuck state, treat as fresh request
          session.progress = 0;
          await persistBlackboardState();
          session.step = 'init';
          session.requirements = undefined;
          session.clarifications = undefined;
          session.confirmation = undefined;
          session.systemDesign = undefined;
          session.uiSpec = undefined;
          session.blueprint = undefined;
          session.codeGen = undefined;
          session.testResult = undefined;
          session.deployment = undefined;
          session.modification = undefined;
          session.modificationContext = undefined;
          session.lastClarificationQuestion = undefined;
          session.progressStages = {};
          session.stepRetries = {};
          clarificationAnswers = {};
          askedClarificationQuestions = [];
          ws.send(JSON.stringify({ type: 'stream', token: 'Starting fresh with your new request.' }));
          await runFlow(userText, null);
          return;
        }

        ws.send(JSON.stringify({ type: 'info', message: 'Please answer the pending question or send your request.' }));
        return;
      }

      // ── Initial message ──────────────────────────────────────────────────
      await runFlow(typeof msg === 'object' ? msg.user_message : msg, null);
    });
  });

  return wss;
}
