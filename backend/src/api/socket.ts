// WebSocket server — lightweight message router dispatching to independent handlers
import { Server } from 'ws';
import http from 'http';

import { handleRequirementAnalysis } from './handlers/requirementAnalysisHandler';
import { handleClarification } from './handlers/clarificationHandler';
import { handleConfirmation } from './handlers/confirmationHandler';
import { handleSystemDesign } from './handlers/systemDesignHandler';
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
  createProjectCodeRevision,
  getProjectSnapshot,
  saveProjectDeployment,
  updateProjectSnapshot,
} from '../db/projectStore';
import { materializeProjectWorkspace } from '../factory/projectFactory';
import { config } from '../config/env';
import { debug, error as logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toClientErrorMessage(err: unknown, fallback: string): string {
  const raw = String((err as any)?.message || '').trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 300) {
    return fallback;
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// activePipelines TTL set — prevents concurrent runs + stale-entry leaks
// ---------------------------------------------------------------------------

const PIPELINE_TTL_MS = 10 * 60 * 1000; // 10 minutes

class TTLSet {
  private entries = new Map<string, number>();
  has(key: string): boolean {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) { this.entries.delete(key); return false; }
    return true;
  }
  add(key: string): void { this.entries.set(key, Date.now() + PIPELINE_TTL_MS); }
  delete(key: string): void { this.entries.delete(key); }
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });
  const activePipelines = new TTLSet();

  const stageWeights: Record<string, number> = {
    requirementAnalysis: 0.10,
    clarification: 0.12,
    confirmation: 0.06,
    systemDesign: 0.10,
    codeGen: 0.25,
    testFix: 0.18,
    deploy: 0.19,
    codeGen_modification: 0.22,
    testFix_modification: 0.18,
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
            codeGen: session.codeGen,
            testResult: session.testResult,
            deployment: session.deployment,
          });
        }
      } catch { /* non-JSON frames silently skipped */ }
    };

    ws.send(JSON.stringify({ type: 'info', message: 'Connected!' }));

    const snapshot = await getProjectSnapshot({ userId: authedUser.id, projectId });

    // Session state
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

    // -----------------------------------------------------------------------
    // Helper: rematerialize code into workspace
    // -----------------------------------------------------------------------
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
          ws.send(JSON.stringify({ type: 'stream', token: 'Build failed — asking AI to fix errors...' }));
          const fixResult = await handleCodeGeneration({
            systemDesign: session.systemDesign,
            requirements: session.requirements,
            modification: `Fix these build errors and produce corrected complete files:\n${logs.slice(-2000)}`,
            projectId,
            userId: authedUser.id,
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
          session.requirements = raResult.data;
          session.stepRetries['requirementAnalysis'] = 0;
          debug('socket:requirementAnalysis', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Got it! Let me ask a couple of quick questions.' }));
          session.step = 'clarification';
        }

        // ── Stage 2: Clarification (multi-turn) ────────────────────────────
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
          debug('socket:clarification', { projectId });

          if (session.clarifications?.question && !session.clarifications.confirmed) {
            let questionMsg: string = session.clarifications.question;
            if (typeof questionMsg === 'string' && questionMsg.trim().startsWith('{')) {
              try {
                const parsed = JSON.parse(questionMsg);
                if (parsed?.question) questionMsg = parsed.question;
              } catch {}
            }
            const normalizedQ = questionMsg.trim().toLowerCase();
            if (askedClarificationQuestions.some(q => q.trim().toLowerCase() === normalizedQ)) {
              ws.send(JSON.stringify({ type: 'stream', token: 'All clear! Moving to confirmation.' }));
              session.step = 'confirmation';
              continue;
            }
            askedClarificationQuestions.push(questionMsg);
            session.lastClarificationQuestion = questionMsg;
            ws.send(JSON.stringify({ type: 'clarification', question: questionMsg }));
            session.step = 'clarification_wait';
            return;
          } else {
            ws.send(JSON.stringify({ type: 'stream', token: 'Thanks for the details! Confirming your requirements...' }));
            session.step = 'confirmation';
          }
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
          debug('socket:confirmation', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Requirements confirmed! Designing the system now...' }));
          session.step = 'systemDesign';
        }

        // ── Stage 4: System Design ─────────────────────────────────────────
        if (session.step === 'systemDesign') {
          sendProgress(ws, session, 'systemDesign', 'Designing system architecture...');
          const sdResult = await handleSystemDesign({ requirements: session.requirements, projectId });
          if (!sdResult.success) {
            session.step = 'systemDesign'; // stay, allow retry
            sendError(ws, session, toClientErrorMessage(sdResult.error, 'System design failed. Reply to retry.'));
            return;
          }
          session.systemDesign = sdResult.data;
          session.stepRetries['systemDesign'] = 0;
          debug('socket:systemDesign', { projectId });
          ws.send(JSON.stringify({ type: 'stream', token: 'Architecture ready! Generating your code now...' }));
          session.step = 'codeGen';
        }

        // ── Stage 5: Code Generation ───────────────────────────────────────
        if (session.step === 'codeGen') {
          sendProgress(ws, session, 'codeGen', 'Generating code...', 0);
          const cgResult = await handleCodeGeneration({
            systemDesign: session.systemDesign,
            requirements: session.requirements,
            projectId,
            userId: authedUser.id,
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
          ws.send(JSON.stringify({ type: 'stream', token: `Code generated (${session.codeGen?.files?.length || 0} files). Building and testing...` }));
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
        const sdResult = await handleSystemDesign({ requirements: session.requirements, modification, projectId });
        if (sdResult.success) {
          session.systemDesign = sdResult.data;
        }

        // Step 3: Code generation
        sendProgress(ws, session, 'codeGen_modification', 'Generating updated code...', 0);
        const cgResult = await handleCodeGeneration({
          systemDesign: session.systemDesign,
          requirements: session.requirements,
          modification,
          context: session.modificationContext,
          projectId,
          userId: authedUser.id,
        });

        if (!cgResult.success) {
          session.step = 'codeGen_modification';
          sendError(ws, session, toClientErrorMessage(cgResult.error, 'Code generation for modification failed. Reply to retry.'));
          return;
        }

        session.codeGen = cgResult.data;
        await rematerializeAndStore(cgResult.data);
        sendProgress(ws, session, 'codeGen_modification', 'Updated code generated!', 1);
        ws.send(JSON.stringify({ type: 'stream', token: 'Changes generated. Building and testing...' }));
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

        const frontendUrl = session.deployment?.frontend_url || '';
        const backendUrl = session.deployment?.backend_url || '';
        ws.send(JSON.stringify({ type: 'stream', token: `Updates deployed! 🎉\n\n🔗 Frontend: ${frontendUrl}${backendUrl ? `\n🔗 Backend: ${backendUrl}` : ''}` }));
        if (session.deployment?.frontend_access_warning) {
          ws.send(JSON.stringify({ type: 'stream', token: `⚠️ ${session.deployment.frontend_access_warning}` }));
        }
        if (session.workspaceDir) void cleanupWorkspace(session.workspaceDir);
        sendProgress(ws, session, 'deploy_modification', 'Deployed!', 1);
        session.step = 'done_modification';

      } catch (err) {
        logError('socket:runModificationFlow', err);
        sendError(ws, session, toClientErrorMessage(err, 'Modification failed. Reply to retry.'));
      } finally {
        activePipelines.delete(projectId);
      }

      if (session.step === 'done_modification') {
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
            'requirementAnalysis', 'systemDesign', 'codeGen', 'testFix', 'deploy',
            'codeGen_modification', 'testFix_modification', 'deploy_modification',
          ];
          if (retryableSteps.includes(session.step)) {
            // Retry from current step (don't reset)
            ws.send(JSON.stringify({ type: 'stream', token: `Retrying from step: ${session.step}...` }));
            await runFlow(null, null);
            return;
          }

          // For any other stuck state, treat as fresh request
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
