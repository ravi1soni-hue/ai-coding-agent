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
import { runBuildWorker } from '../workers/buildWorker';
import {
  createProjectSession,
  getOrCreateActiveProjectSession,
  getUserFromSessionToken,
  isProjectOwnedByUser,
  parseCookie,
  touchProjectSession,
} from '../auth/authService';
import { appendProjectEvent, createProjectCodeRevision, getProjectSnapshot, saveProjectDeployment, updateProjectSnapshot } from '../db/projectStore';
import { materializeProjectWorkspace } from '../factory/projectFactory';


export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });

  wss.on('connection', async (ws, request) => {
    const cookies = parseCookie(request.headers.cookie);
    const token = cookies.sid;
    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication required. Please login again.' }));
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

    const url = new URL(request.url || '/', 'http://localhost');
    const requestedProjectId = url.searchParams.get('projectId');
    let projectId = await getOrCreateActiveProjectSession(authedUser.id);
    if (requestedProjectId) {
      const owned = await isProjectOwnedByUser(authedUser.id, requestedProjectId);
      projectId = owned ? requestedProjectId : await createProjectSession(authedUser.id);
    }

    await touchProjectSession(authedUser.id, projectId);

    const wsAny = ws as any;
    const sendRaw = ws.send.bind(ws);

    wsAny.send = (data: any) => {
      sendRaw(data);
      try {
        const payload = typeof data === 'string' ? JSON.parse(data) : null;
        if (!payload || typeof payload !== 'object') return;

        const roleMap: Record<string, string> = {
          info: 'system',
          progress: 'system',
          stream: 'assistant',
          clarification: 'assistant',
          confirmation: 'assistant',
          error: 'error',
          done: 'system',
        };

        const text =
          payload.message ?? payload.token ?? payload.question ?? payload.status ?? (payload.type ? String(payload.type) : null);

        void appendProjectEvent({
          projectId,
          userId: authedUser.id,
          eventType: payload.type || 'outbound',
          role: roleMap[payload.type] ?? 'system',
          message: text,
          payload,
        });

        if (payload.type === 'progress') {
          void updateProjectSnapshot({
            projectId,
            userId: authedUser.id,
            status: 'active',
            currentStep: session.step,
            progress: Number(payload.progress) || 0,
          });
        }

        if (payload.type === 'error') {
          void updateProjectSnapshot({
            projectId,
            userId: authedUser.id,
            status: 'failed',
            currentStep: session.step,
          });
        }

        if (payload.type === 'done') {
          void updateProjectSnapshot({
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
      } catch {
        // no-op for non-JSON socket payloads
      }
    };

    ws.send(JSON.stringify({ type: 'info', message: 'WebSocket connection established!' }));

    const snapshot = await getProjectSnapshot({ userId: authedUser.id, projectId });

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
      // For modification flow
      modification?: string;
      modificationContext?: any;
      lastClarificationQuestion?: string;
      activeRevisionId?: string;
      workspaceDir?: string;
      sourceArchivePath?: string;
      sourceHash?: string;
      buildDir?: string;
      codeRevisionDbId?: string;
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
      pendingQuestions: [],
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
    };

    if (session.step === 'done' || session.step === 'done_modification') {
      session.step = 'init';
      session.progress = 0;
    }

    // Track answers for step-by-step clarification
    let clarificationAnswers: Record<string, string> = {};
    let clarificationIndex = 0;

    async function runFlow(userMsg: string | null, userClarificationAnswers: Record<string, any> | null = null) {
      try {
        // Step 1: Requirement Analysis
        if (session.step === 'init' || session.step === 'requirementAnalysis') {
          session.progress += 0.12;
          ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Analyzing requirements...' }));
          try {
            if (!userMsg) throw new Error('User message required for requirement analysis');
            session.requirements = await requirementAnalysisAgent({ user_message: userMsg });
            // Log technical details, but send only conversational message to UI
            console.log('[REQUIREMENTS]', session.requirements);
            ws.send(JSON.stringify({ type: 'stream', token: 'Got it! Let me clarify a few details about your project.' }));
            session.step = 'clarification';
          } catch (err) {
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
            session.clarifications = await clarificationAgent(clarInput);
            // Log technical details
            console.log('[CLARIFICATION]', session.clarifications);
            // Conversational flow
            if (session.clarifications && session.clarifications.question && !session.clarifications.confirmed) {
              let questionMsg = session.clarifications.question;
              // Defensive: if questionMsg is a JSON string, parse and extract .question
              if (typeof questionMsg === 'string' && questionMsg.trim().startsWith('{')) {
                try {
                  const parsed = JSON.parse(questionMsg);
                  if (parsed && typeof parsed.question === 'string') questionMsg = parsed.question;
                } catch {}
              }
              ws.send(JSON.stringify({ type: 'clarification', question: questionMsg })); // Only send plain question string
              session.step = 'clarification_wait';
              return;
            } else if (session.clarifications && !session.clarifications.confirmed) {
              ws.send(JSON.stringify({ type: 'confirmation', message: 'Could you please confirm the above details before we proceed?' })); // Only send plain confirmation message
              session.pendingQuestions = [];
              session.step = 'clarification_wait';
              return;
            } else {
              ws.send(JSON.stringify({ type: 'stream', token: 'Thanks for clarifying! Moving to confirmation.' }));
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
            console.log('[CONFIRMATION]', session.confirmation);
            ws.send(JSON.stringify({ type: 'stream', token: 'All requirements confirmed! I will now design the system.' }));
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
            console.log('[SYSTEM DESIGN]', session.systemDesign);
            ws.send(JSON.stringify({ type: 'stream', token: 'System design is ready. Generating code...' }));
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
            const materialized = await materializeProjectWorkspace({
              projectId,
              codeGen: session.codeGen,
            });
            session.activeRevisionId = materialized.revisionId;
            session.workspaceDir = materialized.workspaceDir;
            session.sourceArchivePath = materialized.archivePath;
            session.sourceHash = materialized.sourceHash;
            session.codeRevisionDbId = await createProjectCodeRevision({
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
            ws.send(JSON.stringify({ type: 'stream', token: 'Code generated! Running tests and fixes...' }));
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
            session.testResult = await testFixAgent({
              buildFn: async () => {
                const result = await runBuildWorker({ workspaceDir: session.workspaceDir });
                if (result.success) {
                  session.buildDir = result.buildDir;
                }
                return { success: result.success, logs: result.logs };
              },
            });
            console.log('[TEST RESULT]', session.testResult);
            ws.send(JSON.stringify({ type: 'stream', token: 'Tests complete! Deploying your project...' }));
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
            if (!session.buildDir || !session.activeRevisionId) {
              throw new Error('Build artifact missing for deployment.');
            }
            session.deployment = await deploymentAgent({
              projectId,
              revisionId: session.activeRevisionId,
              buildDir: session.buildDir,
              frontendProjectName: `proj-${projectId.slice(0, 10)}`,
              backendService: 'backend',
            });
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
            console.log('[DEPLOYMENT]', session.deployment);
            ws.send(JSON.stringify({ type: 'stream', token: 'Your project is deployed! 🎉' }));
            session.step = 'done';
          } catch (err) {
            console.error('[Deployment Error]', err);
            ws.send(JSON.stringify({ type: 'error', message: 'Oops, something went wrong during deployment. Please try again later.' }));
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
          await touchProjectSession(authedUser.id, projectId);
          ws.send(
            JSON.stringify({
              type: 'done',
              projectId,
              message: 'Project complete and saved. Start a new session for a new project!',
            }),
          );
        }
      } catch (err) {
        console.error('[General Error]', err);
        ws.send(JSON.stringify({ type: 'error', message: 'Oh no, something went wrong. Please try again or start a new session.' }));
      }
    }

    ws.on('message', async (message) => {
      let msg;
      try {
        msg = JSON.parse(message.toString());
      } catch {
        msg = message.toString();
      }

      const userText = typeof msg === 'object' ? msg.user_message || msg.answer || msg.modification : msg;
      if (typeof userText === 'string' && userText.trim()) {
        await appendProjectEvent({
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
        let clarResult = await clarificationAgent(clarInput);
        if (clarResult.question) {
          ws.send(JSON.stringify({ type: 'clarification', question: clarResult.question })); // Only send plain question string
          session.step = 'clarification_wait_modification';
          session.lastClarificationQuestion = clarResult.question;
          return;
        } else {
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
        let clarResult = await clarificationAgent(clarInput);
        if (clarResult.question) {
          ws.send(JSON.stringify({ type: 'clarification', question: clarResult.question })); // Only send plain question string
          session.lastClarificationQuestion = clarResult.question;
          return;
        } else {
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
          session.codeGen = await codeGenerationAgent(codeGenInput);
          const materialized = await materializeProjectWorkspace({
            projectId,
            codeGen: session.codeGen,
          });
          session.activeRevisionId = materialized.revisionId;
          session.workspaceDir = materialized.workspaceDir;
          session.sourceArchivePath = materialized.archivePath;
          session.sourceHash = materialized.sourceHash;
          session.codeRevisionDbId = await createProjectCodeRevision({
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
          ws.send(JSON.stringify({ type: 'stream', token: `Code patch generated. Proceeding to tests...` }));
          session.step = 'testFix_modification';
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Code generation for modification failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
          return;
        }
      }

      // Test & Fix for modification
      if (session.step === 'testFix_modification') {
        ws.send(JSON.stringify({ type: 'progress', progress: session.progress, status: 'Testing and fixing modification...' }));
        try {
          session.testResult = await testFixAgent({
            buildFn: async () => {
              const result = await runBuildWorker({ workspaceDir: session.workspaceDir });
              if (result.success) {
                session.buildDir = result.buildDir;
              }
              return { success: result.success, logs: result.logs };
            },
          });
          ws.send(JSON.stringify({ type: 'stream', token: `Tests complete. Deploying your project...` }));
          session.step = 'deploy_modification';
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Test/fix for modification failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
          return;
        }
      }

      // Deploy modification
      if (session.step === 'deploy_modification') {
        ws.send(JSON.stringify({ type: 'progress', progress: 1, status: 'Deploying modification...' }));
        try {
          if (!session.buildDir || !session.activeRevisionId) {
            throw new Error('Build artifact missing for deployment.');
          }
          session.deployment = await deploymentAgent({
            projectId,
            revisionId: session.activeRevisionId,
            buildDir: session.buildDir,
            frontendProjectName: `proj-${projectId.slice(0, 10)}`,
            backendService: 'backend',
          });
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
          ws.send(JSON.stringify({ type: 'stream', token: `Deployment complete!` }));
          session.step = 'done_modification';
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: (err as any)?.message || 'Deployment for modification failed.', error: { name: (err as any)?.name, stack: (err as any)?.stack, details: err } }));
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
        // Always pass updated clarificationAnswers to runFlow
        if (clarificationIndex < session.pendingQuestions.length) {
          ws.send(JSON.stringify({ type: 'clarification', question: session.pendingQuestions[clarificationIndex], index: clarificationIndex + 1, total: session.pendingQuestions.length, context: session.requirements }));
          return;
        } else {
          session.step = 'clarification';
          await runFlow(null, { ...clarificationAnswers });
          return;
        }
      } else if (session.step === 'confirmation_wait') {
        if (session.clarifications) session.clarifications.confirmed = true;
        session.step = 'confirmation';
        await runFlow(null, null);
        return;
      } else if (session.step !== 'init') {
        ws.send(JSON.stringify({ type: 'info', message: 'Please answer the pending questions or confirm to continue.' }));
        return;
      }
      await runFlow(typeof msg === 'object' ? msg.user_message : msg, null);
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
