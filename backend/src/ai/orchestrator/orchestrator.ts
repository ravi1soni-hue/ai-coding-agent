import { requirementAnalysisAgent } from '../../agents/requirementAnalysisAgent';
import { clarificationAgent } from '../../agents/clarificationAgent';
import { systemDesignAgent } from '../../agents/systemDesignAgent';
import { uiSpecAgent } from '../../agents/uiSpecAgent';
import { blueprintAgent } from '../../agents/blueprintAgent';
import { codeGenerationAgent } from '../../agents/codeGenerationAgent';
import { testFixAgent } from '../../agents/testFixAgent';
import { deploymentAgent } from '../../agents/deploymentAgent';
import { reviewerAgent } from '../../agents/reviewerAgent';
import { reviewStage } from '../../agents/stageReviewer';
import { fixStage } from '../../agents/stageFixer';
import { getModelPriorityChain } from '../../agents/modelRouter';
import { LLMProxyClient } from '../../agents/llmProxyClient';
import { materializeProjectWorkspace, writeGeneratedFile } from '../../factory/projectFactory';
import { runBuildWorker, cleanupWorkspace } from '../../workers/buildWorker';
import { consolidateProjectSpec, validateProjectSpec } from '../../agents/projectSpec';
import { validateProjectConsistency, formatConsistencyIssues, type ConsistencyIssue } from '../../agents/projectConsistency';
import { classifyError } from './errorClassifier';
import { buildExecutionPlan } from './executionPlan';
import type { RequirementAnalysisOutput } from '../../agents/requirementAnalysisAgent';
import type { ClarificationOutput } from '../../agents/clarificationAgent';
import {
  appendHistory,
  appendIssue,
  createInitialMemory,
  finalizeMemory,
  hashInput,
  markStage,
  recordFix,
  saveCheckpoint,
  createCheckpointSnapshot,
  setBlueprint,
  setClarifications,
  setCode,
  setConfirmation,
  setDeployment,
  setExecutionPlan,
  setModification,
  setRequirements,
  setSystemDesign,
  setTests,
  setUISpec,
} from './memory';
import {
  createFailedResult,
  createNeedsFixResult,
  createNeedsInputResult,
  createSuccessResult,
  decideRecoveryAction,
  shouldAttemptRepair,
  shouldRetryStage,
} from './recovery';
import { resolveRecoveryRoute, normalizePipelineStage, stageIndex, type PipelineStage } from '../../orchestration/pipelineStateMachine';
import { error as logError } from '../../utils/logger';
import type {
  OrchestrationAdapter,
  OrchestrationCommand,
  OrchestrationResult,
  OrchestrationState,
  PersistenceAdapter,
  ProjectMemory,
  RetryPolicy,
  StageResult,
} from '../contracts/orchestration';

import { OUTER_FSM_ORDER, getStartingOuterFsmState, firstInternalStageForOuterState } from './stateCoordinator';
import { config } from '../../config/env';
import { initBudget } from '../../utils/tokenBudget';
import { withTimeout } from '../../utils/timeout';

const DEFAULT_POLICY: Record<OrchestrationState, RetryPolicy> = {
  requirements: { maxAttempts: 2, maxFixAttempts: 1, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  clarification: { maxAttempts: 2, maxFixAttempts: 1, relaxOnRetry: true, allowFallback: true, allowUserQuestion: true },
  confirmation: { maxAttempts: 1, maxFixAttempts: 0, relaxOnRetry: false, allowFallback: true, allowUserQuestion: true },
  system_design: { maxAttempts: 2, maxFixAttempts: 2, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  ui_spec: { maxAttempts: 2, maxFixAttempts: 2, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  blueprint: { maxAttempts: 2, maxFixAttempts: 2, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  execution_plan: { maxAttempts: 2, maxFixAttempts: 2, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  code_generation: { maxAttempts: 2, maxFixAttempts: 3, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  testing: { maxAttempts: 3, maxFixAttempts: 3, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  deployment: { maxAttempts: 2, maxFixAttempts: 2, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  modification: { maxAttempts: 2, maxFixAttempts: 2, relaxOnRetry: true, allowFallback: true, allowUserQuestion: false },
  done: { maxAttempts: 1, maxFixAttempts: 0, relaxOnRetry: false, allowFallback: true, allowUserQuestion: false },
  failed: { maxAttempts: 1, maxFixAttempts: 0, relaxOnRetry: false, allowFallback: true, allowUserQuestion: false },
};

type RequirementAnalysisShape = RequirementAnalysisOutput;

type ClarificationShape = {
  questions: string[];
  confirmed: boolean;
  done: boolean;
  context: {
    clarificationAnswers: Record<string, string>;
    askedQuestions: string[];
    modification?: string;
    lastQuestion?: string;
    lastAnswer?: string;
  };
};

function requiresBackendArchitecture(requirements: any): boolean {
  return Boolean(requirements?.backend_required || requirements?.auth_required);
}

function isFrontendOnlyRequirements(requirements: any): boolean {
  return !requiresBackendArchitecture(requirements);
}


function currentPolicy(memory: ProjectMemory): RetryPolicy {
  return DEFAULT_POLICY[memory.currentState] || DEFAULT_POLICY.requirements;
}

function toRequirementAnalysisOutput(result: RequirementAnalysisShape): RequirementAnalysisShape {
  return {
    website_type: result.website_type || 'business',
    pages: Array.isArray(result.pages) ? result.pages : [],
    backend_required: Boolean(result.backend_required),
    auth_required: Boolean(result.auth_required),
    deployment_pref: result.deployment_pref || 'auto',
    notes: result.notes,
  };
}

function toClarificationOutput(result: ClarificationShape, clarificationAnswers: Record<string, string>): ClarificationShape {
  return {
    questions: Array.isArray(result.questions) ? result.questions : [],
    confirmed: Boolean(result.confirmed),
    done: Boolean(result.done),
    context: {
      clarificationAnswers,
      askedQuestions: Array.isArray(result.context?.askedQuestions) ? result.context.askedQuestions : [],
      modification: result.context?.modification,
      lastQuestion: result.context?.lastQuestion,
      lastAnswer: result.context?.lastAnswer,
    },
  };
}

function toBuildArtifact(result: Awaited<ReturnType<typeof testFixAgent>>): { buildDir?: string; backendDir?: string } {
  return {
    buildDir: (result as { buildDir?: string }).buildDir,
    backendDir: (result as { backendDir?: string }).backendDir,
  };
}

function routeRecoveryTarget(stage: OrchestrationState, issueType: string): OrchestrationState {
  const route = /schema_mismatch|api_contract_error|semantic_inconsistency/i.test(issueType)
    ? resolveRecoveryRoute(stage, 2)
    : /state_transition_error|unknown_error|deployment_error/i.test(issueType)
      ? resolveRecoveryRoute(stage, 3)
      : resolveRecoveryRoute(stage, 1);

  switch (route.targetStage) {
    case 'blueprint':
      return 'blueprint';
    case 'systemDesign':
      return 'system_design';
    case 'codeGen':
      return 'code_generation';
    case 'clarification':
      return 'clarification';
    default:
      return 'code_generation';
  }
}

type StageOptions = {
  adapter?: OrchestrationAdapter;
  persistence?: PersistenceAdapter;
  percent?: number;
  /** Global wall-clock deadline for automated orchestration work. */
  deadlineAt?: number;
  /**
   * Called before each retry attempt (attempt >= 1) with the error from the
   * previous attempt. Handlers can mutate their captured input to inject error
   * context (e.g. previousIssues) so that the LLM sees what went wrong and
   * corrects it, rather than re-running with identical inputs blindly.
   */
  onRetry?: (attempt: number, lastError: unknown) => void;
};

async function persistMemory(memory: ProjectMemory, persistence?: PersistenceAdapter): Promise<void> {
  if (!persistence?.saveSnapshot) return;
  try {
    await persistence.saveSnapshot(memory);
  } catch (err) {
    // persistenceAdapter.writeSnapshot() is responsible for best-effort heavy artifact fields.
    // Any error that escapes here indicates cursor-phase durability failure (status/current_step/progress).
    // That MUST NOT be swallowed: otherwise resume scanners can see NULL cursor fields and treat pipelines as stuck.
    logError('orchestrator:persist_snapshot_failed', {
      projectId: memory.projectId,
      stage: memory.currentState,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function persistLastEvent(memory: ProjectMemory, persistence?: PersistenceAdapter): Promise<void> {
  if (!persistence?.appendEvent) return;
  const last = memory.history[memory.history.length - 1];
  if (!last) return;
  try {
    await persistence.appendEvent(last);
  } catch {
    // best-effort
  }
}

async function stageWrap<T>(
  memory: ProjectMemory,
  stage: OrchestrationState,
  input: unknown,
  handler: () => Promise<T>,
  options: StageOptions = {}
): Promise<StageResult<T>> {
  const { adapter, persistence, percent, deadlineAt, onRetry } = options;
  const policy = currentPolicy(memory);
  // NOTE: sessionId is intentionally excluded from inputHash — sessionId changes on every
  // server restart, which would cause all prior checkpoints to be cache-misses, breaking
  // crash-resume. projectId alone provides the necessary isolation.
  const inputHash = hashInput({ stage, input, projectId: memory.projectId });
  const cached = memory.checkpoints.find((item) => item.stage === stage && item.inputHash === inputHash);
    if (cached && cached.output !== undefined) {
      // Keep FSM outer state consistent when resuming from checkpoints.
      // Otherwise, memory.currentState may still reflect the previous stage
      // (e.g. system_design), causing downstream markStage() to throw on an
      // invalid transition (e.g. system_design -> blueprint).
      markStage(memory, stage);
      adapter?.emit?.({ type: 'info', stage, message: `resumed ${stage} from checkpoint` });
      // Persist immediately so REST snapshot readers can see current_step
      // even if downstream emits are missing/stalled.
      await persistMemory(memory, persistence);
      return createSuccessResult(stage, cached.output as T, undefined, cached.issues);
    }

  // Defensive: if we are already past this stage (memory advanced further in a prior run)
  // and there's a hash-matching checkpoint, use it. We intentionally do NOT fall back to
  // a hash-mismatched checkpoint — doing so would silently load stale output from a prior
  // run with different input (e.g. a different user message for the same projectId),
  // causing the entire pipeline to execute against the wrong requirements.
  const normalizedCurrent = normalizePipelineStage(memory.currentState);
  const normalizedTarget = normalizePipelineStage(stage);
  const currentIdx = stageIndex(normalizedCurrent);
  const targetIdx = stageIndex(normalizedTarget);
  if (currentIdx > targetIdx) {
    // No checkpoint at all for a stage we passed — mark it so the state machine
    // stays consistent, then re-run the stage.
    memory.currentState = stage as OrchestrationState;
  }

  adapter?.emit?.({ type: 'stage_start', stage });
  if (typeof percent === 'number') {
    adapter?.emit?.({ type: 'progress', stage, percent, message: `entering ${stage}` });
  }

  let attempt = 0;
  let fixAttempt = 0;
  let lastError: unknown = null;

  while (shouldRetryStage(attempt, policy)) {
    try {
      // Give the caller a chance to mutate its captured input (e.g. inject
      // previousIssues) before each retry so the handler sees what failed.
      if (attempt > 0 && lastError !== null && onRetry) {
        try { onRetry(attempt, lastError); } catch { /* best-effort */ }
      }
      markStage(memory, stage);

      // Persist immediately on stage entry so REST snapshot readers see
      // non-null current_step even while downstream work is in-progress.
      await persistMemory(memory, persistence);

      let output: T;
      if (typeof deadlineAt === 'number') {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw new Error('Orchestration timeout');
        output = await withTimeout(handler(), remainingMs, 'Orchestration');
      } else {
        output = await handler();
      }

      const checkpoint = saveCheckpoint(memory, stage, inputHash, output, [], attempt);
      appendHistory(memory, stage, 'stage_complete', `Completed ${stage}`, undefined);
      await persistMemory(memory, persistence);
      await persistLastEvent(memory, persistence);
      if (persistence?.saveCheckpoint) {
        let retries = 3;
        while (retries > 0) {
          try {
            await persistence.saveCheckpoint(checkpoint);
            break;
          } catch (err) {
            retries--;
            if (retries === 0) {
              logError('orchestrator:persistence_failed', { stage, attempt, error: err });
              // Continue without failing the pipeline
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
            }
          }
        }
      }
      // Do NOT ship `output` over the WS for every stage.
      // For code_generation in particular it carries the entire generated
      // file set (hundreds of KB) — which has caused WS frame truncation,
      // mid-stream disconnects, and the client's JSON.parse fallback to
      // dump the raw frame into chat as an "assistant" message.
      // The client never reads `output`; files are already streamed via
      // per-file FILE_WRITTEN / file_generated events.
      adapter?.emit?.({ type: 'stage_complete', stage });
      return createSuccessResult(stage, output, undefined, []);
    } catch (error) {
      lastError = error;
      const issue = classifyError({
        projectId: memory.projectId,
        sessionId: memory.sessionId,
        stage,
        error,
        details: { input },
      });
      appendIssue(memory, issue);
      appendHistory(memory, stage, 'stage_error', issue.message, issue);
      adapter?.emit?.({ type: 'stage_error', stage, issue });
      await persistMemory(memory, persistence);
      await persistLastEvent(memory, persistence);

      // Phase 6 global orchestration timeout: deterministic terminal failure.
      // withTimeout() rejects with `${label} timeout after ${ms}ms`.
      // We must bypass retry/repair/fallback loops and transition to FAILED immediately.
      const errMessage = error instanceof Error ? error.message : String(error);
      if (errMessage === 'Orchestration timeout' || errMessage.startsWith('Orchestration timeout after')) {
        const issue = classifyError({
          projectId: memory.projectId,
          sessionId: memory.sessionId,
          stage,
          error,
          details: { input },
        });
        appendIssue(memory, issue);
        appendHistory(memory, stage, 'stage_error', issue.message, issue);

        if (persistence?.saveCheckpoint) {
          try {
            const checkpoint = createCheckpointSnapshot(memory, stage, inputHash, undefined, [issue], 0);
            await persistence.saveCheckpoint(checkpoint);
          } catch (err) {
            logError('orchestrator:persistence_timeout_checkpoint_failed', {
              stage,
              projectId: memory.projectId,
              error: err,
            });
          }
        }

        return createFailedResult(stage, [issue], 'failed');
      }

      // Phase 3 budget controller: deterministic terminal failure.
      // tokenBudget.enforceBudgetOrThrow throws Error("Budget Exceeded").
      // We must bypass retry/repair/fallback loops and transition to FAILED immediately.
      if (errMessage === 'Budget Exceeded') {
        if (persistence?.saveCheckpoint) {
          try {
            const checkpoint = createCheckpointSnapshot(memory, stage, inputHash, undefined, [issue], 0);
            await persistence.saveCheckpoint(checkpoint);
          } catch (err) {
            logError('orchestrator:persistence_budget_checkpoint_failed', {
              stage,
              projectId: memory.projectId,
              error: err,
            });
          }
        }
        return createFailedResult(stage, [issue], 'failed');
      }

      // Phase 1 durability: checkpoint even on non-success paths
      // (stage_error, needs_input, needs_fix) so resume can restore
      // the exact coordinator context, not only successful outputs.
      if (persistence?.saveCheckpoint) {
        try {
          const checkpoint = createCheckpointSnapshot(memory, stage, inputHash, undefined, [issue], attempt);
          await persistence.saveCheckpoint(checkpoint);
        } catch (err) {
          logError('orchestrator:persistence_checkpoint_failed', {
            stage,
            attempt,
            projectId: memory.projectId,
            error: err,
          });
        }
      }

      const action = decideRecoveryAction(issue, policy);

      if (action === 'ask_user') {
        return createNeedsInputResult(stage, [issue], routeRecoveryTarget(stage, issue.type));
      }

      if (action === 'repair' && shouldAttemptRepair(fixAttempt, policy)) {
        recordFix(memory, stage, `Repair attempt ${fixAttempt + 1} for ${stage}`);
        fixAttempt += 1;
        attempt += 1;
        continue;
      }

      if (action === 'fallback' && policy.allowFallback) {
        return createNeedsFixResult(stage, [issue], routeRecoveryTarget(stage, issue.type));
      }

      attempt += 1;
    }
  }

  const finalIssue = lastError
    ? classifyError({
        projectId: memory.projectId,
        sessionId: memory.sessionId,
        stage,
        error: lastError,
        details: { input },
      })
    : classifyError({
        projectId: memory.projectId,
        sessionId: memory.sessionId,
        stage,
        error: new Error(`Stage ${stage} failed`),
        details: { input },
      });

  return createFailedResult(stage, [finalIssue], routeRecoveryTarget(stage, finalIssue.type));
}

async function runFinalAudit(projectSpec: any, memory: ProjectMemory): Promise<void> {
  const report = validateProjectConsistency({
    projectSpec,
    requirementAnalysis: memory.requirements,
    clarifications: memory.clarifications,
    systemDesign: memory.systemDesign,
    uiSpec: memory.uiSpec,
    blueprint: memory.blueprint?.blueprint,
    codeGen: memory.code,
    activeStage: 'done',
  });

  if (!report.ok) {
    throw new Error(`Final audit failed:\n${formatConsistencyIssues(report)}`);
  }

  const reviewed = await reviewerAgent({
    projectId: memory.projectId,
    blueprint: memory.blueprint?.blueprint,
    files: memory.code?.files,
    reviewerName: 'Final Audit Reviewer',
  } as any);

  if (!reviewed.approved || !reviewed.approved.approved) {
    throw new Error(`Final audit reviewer rejected blueprint: ${(reviewed.approved?.notes || []).join('; ')}`);
  }
}

// Extract the most actionable error lines from build logs.
// Build errors appear early (TypeScript/Vite diagnostics) and at the end (summary).
// We keep both ends plus any "error TS" / "error:" lines in between.
function extractBuildErrors(logs: string): string {
  const raw = String(logs);
  const lines = raw.split('\n');

  // Collect lines that look like actual errors (TypeScript, Vite, esbuild, Node)
  const errorLines = lines.filter((l) =>
    /error TS\d+|error:|\bERROR\b|✘|✗|failed|Cannot find|is not exported|Duplicate|Expected|Unexpected|SyntaxError/i.test(l)
  );

  // Skip npm install noise (lines before "npm run build" or "> vite build") for the head section.
  // npm install output is not actionable for code-gen self-heal — only the actual build errors are.
  const buildStartIdx = lines.findIndex((l) => /vite build|tsc --build|esbuild|> build|npm run build/i.test(l));
  const buildLines = buildStartIdx >= 0 ? lines.slice(buildStartIdx) : lines;
  const buildHead = buildLines.slice(0, 60).join('\n');

  // Always include the last 2000 chars (summary / exit status section)
  const tail = raw.slice(-2000);
  const middle = errorLines.slice(0, 80).join('\n');

  const combined = [buildHead, middle, tail].join('\n---\n');
  // Deduplicate adjacent identical lines and cap total length
  return combined.replace(/(.+\n)\1+/g, '$1').slice(0, 8000);
}

async function selfHealWithCodeGeneration(
  memory: ProjectMemory,
  command: OrchestrationCommand,
  projectSpec: any,
  logs: string,
  projectId: string,
  deadlineAt?: number
): Promise<void> {
  if (deadlineAt && deadlineAt - Date.now() < 60_000) {
    throw new Error(`Orchestration timeout — insufficient budget for self-heal (${Math.max(0, deadlineAt - Date.now())}ms remaining)`);
  }

  // Surface stub files from blueprint self-heal so the code-gen agent knows which
  // files were never fully generated and need real content, not just build-error fixes.
  const stubPaths = (memory.code?.files ?? [])
    .filter((f) => f.content.includes('STUB_COMPONENT:'))
    .map((f) => f.path);
  const stubContext = stubPaths.length > 0
    ? `\n\nThe following component files were NOT generated (stubs only — they need real implementations):\n${stubPaths.map((p) => `  - ${p}`).join('\n')}`
    : '';

  const repaired = await codeGenerationAgent({
    systemDesign: memory.systemDesign,
    uiSpec: memory.uiSpec?.structuredSpec,
    structuredSpec: memory.uiSpec?.structuredSpec,
    blueprint: memory.blueprint?.blueprint,
    requirements: memory.requirements,
    modification: `Fix the build errors below and regenerate complete files:${stubContext}\n\nBuild errors:\n${extractBuildErrors(logs)}`,
    projectSpec,
    projectId,
    user_id: command.sessionId,
  });
  setCode(memory, { files: repaired.files || [], patch: repaired.patch || '' });
  recordFix(memory, 'code_generation', 'Applied automated repair after test failure');
}

async function loadOrCreateMemory(
  command: OrchestrationCommand,
  sessionId: string,
  persistence: PersistenceAdapter
): Promise<ProjectMemory> {
  let memory: ProjectMemory | null = null;

  // Phase 1 durability: if resume provides the persisted full context snapshot,
  // prefer it over the coarse project_sessions snapshot.
  if (command.recoveryContextSnapshot) {
    try {
      memory = command.recoveryContextSnapshot;
      memory.projectId = command.projectId;
      memory.sessionId = sessionId;
    } catch {
      // fall through to other sources
      memory = null;
    }
  }

  if (!memory && persistence.loadSnapshot) {
    try {
      memory = await persistence.loadSnapshot(command.projectId);
    } catch {
      // fall through to fresh memory
    }
  }

  if (!memory) {
    const deploymentMode = command.step === 'deployment' ? 'full-stack' : 'frontend-only';
    memory = createInitialMemory({
      projectId: command.projectId,
      sessionId,
      userMessage: command.userMessage,
      deploymentMode,
    });
  }

  // If resuming at a specific stage boundary, force it.
  if (command.step) {
    memory.currentState = command.step;
  } else if (command.recoveryFsmState) {
    memory.currentState = firstInternalStageForOuterState(command.recoveryFsmState);
  }

  // Ensure invariant fields exist even if the snapshot was partially corrupted.
  memory.history = Array.isArray(memory.history) ? memory.history : [];
  memory.errors = Array.isArray(memory.errors) ? memory.errors : [];
  memory.fixes = Array.isArray(memory.fixes) ? memory.fixes : [];
  memory.checkpoints = Array.isArray(memory.checkpoints) ? memory.checkpoints : [];

  // Rehydrate stage checkpoints so stageWrap() can actually resume.
  if (persistence.loadCheckpoints) {
    try {
      memory.checkpoints = await persistence.loadCheckpoints(command.projectId);
    } catch {
      // best-effort
      memory.checkpoints = memory.checkpoints ?? [];
    }
  }

  return memory;
}

function buildProjectSpec(memory: ProjectMemory, command: OrchestrationCommand) {
  return validateProjectSpec(
    consolidateProjectSpec({
      projectId: command.projectId,
      userMessage: command.userMessage,
      requirements: {
        website_type: (memory.requirements?.website_type || 'business') as RequirementAnalysisOutput['website_type'],
        pages: (Array.isArray(memory.requirements?.pages) && memory.requirements!.pages.length > 0) ? memory.requirements!.pages : ['home'],
        backend_required: Boolean(memory.requirements?.backend_required),
        auth_required: Boolean(memory.requirements?.auth_required),
        deployment_pref: memory.requirements?.deployment_pref || 'auto',
        notes: memory.requirements?.notes,
      },
      clarifications: memory.clarifications
        ? {
            questions: memory.clarifications.questions || [],
            confirmed: Boolean(memory.clarifications.confirmed),
            done: Boolean(memory.clarifications.done),
            context: {
              clarificationAnswers: memory.clarifications.answers || {},
              askedQuestions: memory.clarifications.askedQuestions || [],
              modification: command.modification,
            },
          }
        : {
            questions: [],
            confirmed: true,
            done: true,
            context: {
              clarificationAnswers: command.clarificationAnswers || {},
              askedQuestions: [],
              modification: command.modification,
            },
          },
      clarificationAnswers: command.clarificationAnswers || {},
      systemDesign: memory.systemDesign,
      uiSpec: memory.uiSpec?.structuredSpec,
      blueprint: memory.blueprint?.blueprint,
      modification: command.modification,
    }),
    { partial: true }
  );
}

function finalizePartial(
  memory: ProjectMemory,
  pausedAt: OrchestrationState,
  persistence: PersistenceAdapter
): Promise<OrchestrationResult> {
  markStage(memory, pausedAt);
  memory.status = 'paused';

  // Phase 1 durability: even though we're pausing (interactive state),
  // persist a full context_snapshot checkpoint so recovery can restore
  // outer FSM context precisely.
  const checkpointStage = pausedAt;
  const pauseInputHash = hashInput({ stage: checkpointStage, input: { paused: true }, memory: { projectId: memory.projectId, sessionId: memory.sessionId } });

  if (persistence?.saveCheckpoint) {
    try {
      const checkpoint = createCheckpointSnapshot(memory, checkpointStage, pauseInputHash, undefined, [], 0);
      void persistence.saveCheckpoint(checkpoint);
    } catch {
      // best-effort
    }
  }

  return Promise.resolve(persistMemory(memory, persistence)).then(() => ({
    projectId: memory.projectId,
    sessionId: memory.sessionId,
    frontendUrl: memory.deployment?.frontendUrl || null,
    backendUrl: memory.deployment?.backendUrl || null,
    status: 'partial' as const,
    memory,
  }));
}

async function runClarificationLoop(
  memory: ProjectMemory,
  command: OrchestrationCommand,
  options: StageOptions
): Promise<{ done: boolean; questions: string[] }> {
  const incomingAnswers = { ...(memory.clarifications?.answers || {}), ...(command.clarificationAnswers || {}) };
  const priorAsked = memory.clarifications?.askedQuestions || [];

  const result = await stageWrap(
    memory,
    'clarification',
    { answers: incomingAnswers, askedQuestions: priorAsked },
    async () => {
      const agentResult = await clarificationAgent({
        projectId: command.projectId,
        requirements: {
          website_type: memory.requirements?.website_type || 'business',
          pages: memory.requirements?.pages || [],
          backend_required: Boolean(memory.requirements?.backend_required),
          auth_required: Boolean(memory.requirements?.auth_required),
          deployment_pref: memory.requirements?.deployment_pref,
          notes: memory.requirements?.notes,
        },
        clarificationAnswers: incomingAnswers,
        askedQuestions: priorAsked,
        projectSpec: {
          userMessage: command.userMessage,
          requirements: memory.requirements,
          askedQuestions: priorAsked,
          clarificationAnswers: incomingAnswers,
        },
        modification: command.modification,
      });
      const clarification = toClarificationOutput(agentResult.output, incomingAnswers);
      setClarifications(memory, {
        questions: clarification.questions,
        confirmed: clarification.confirmed,
        done: clarification.done,
        answers: clarification.context.clarificationAnswers,
        askedQuestions: clarification.context.askedQuestions,
      });
      return clarification;
    },
    options
  );

  if (result.status !== 'success') {
    return { done: false, questions: memory.clarifications?.questions || [] };
  }

  if (memory.clarifications?.done) {
    return { done: true, questions: [] };
  }

  // Pick the next unanswered, not-yet-asked question
  const candidates = memory.clarifications?.questions || [];
  const askedSet = new Set((memory.clarifications?.askedQuestions || []).map((q) => q.trim().toLowerCase()));
  const answeredSet = new Set(Object.keys(memory.clarifications?.answers || {}).map((q) => q.trim().toLowerCase()));
  const nextQuestion = candidates.find((q) => {
    const norm = q.trim().toLowerCase();
    return norm.length > 0 && !askedSet.has(norm) && !answeredSet.has(norm);
  });

  if (!nextQuestion) {
    // Agent did not signal done but produced no askable question; treat as done
    if (memory.clarifications) memory.clarifications.done = true;
    return { done: true, questions: [] };
  }

  if (memory.clarifications) {
    memory.clarifications.lastQuestion = nextQuestion;
    memory.clarifications.askedQuestions = Array.from(new Set([...(memory.clarifications.askedQuestions || []), nextQuestion]));
  }

  options.adapter?.emit?.({ type: 'clarification_request', stage: 'clarification', questions: [nextQuestion] });
  return { done: false, questions: [nextQuestion] };
}

async function refineRequirementsFromClarifications(
  memory: ProjectMemory,
  command: OrchestrationCommand,
  options: StageOptions
): Promise<void> {
  const answers = memory.clarifications?.answers || {};
  const answerEntries = Object.entries(answers).filter(([q, a]) => q?.trim() && typeof a === 'string' && a.trim());
  if (answerEntries.length === 0) return;

  const augmentedMessage = [
    command.userMessage.trim(),
    '',
    'Clarifications:',
    ...answerEntries.map(([q, a]) => `Q: ${q}\nA: ${a}`),
  ].join('\n');

  try {
    const result = await requirementAnalysisAgent({ user_message: augmentedMessage });
    const refined = toRequirementAnalysisOutput(
      (result as { output?: RequirementAnalysisShape }).output || (result as unknown as RequirementAnalysisShape)
    );
    const existingPages = Array.isArray(memory.requirements?.pages) ? memory.requirements!.pages : [];
    const mergedPages = Array.from(new Set([...existingPages, ...refined.pages].filter((p) => typeof p === 'string' && p.trim())));

    // Detect explicit backend/auth signals in the clarification answers. These
    // must NEVER be silently downgraded by a re-run of requirementAnalysis
    // (the "portfolio" semantic override historically did this).
    const answersBlob = answerEntries.map(([, a]) => String(a)).join(' \n ').toLowerCase();
    const backendSignals = /\b(admin\s*panel|dashboard|cms|login|sign[-\s]?in|sign[-\s]?up|auth|account|user\s+(account|profile|management)|database|postgres|sql|crud|api|endpoint|server|backend|payment|stripe|checkout|order|booking|reservation|submit\s+(a\s+)?form|contact\s+form|store\s+submissions?|save\s+to|persist|upload|chat|message|notification|role[-\s]?based)\b/.test(answersBlob);
    const authSignals = /\b(login|sign[-\s]?in|sign[-\s]?up|auth|account|password|role[-\s]?based|admin|protected\s+route)\b/.test(answersBlob);

    const prevBackend = Boolean(memory.requirements?.backend_required);
    const prevAuth = Boolean(memory.requirements?.auth_required);
    const refinedBackend = typeof refined.backend_required === 'boolean' ? refined.backend_required : prevBackend;
    const refinedAuth = typeof refined.auth_required === 'boolean' ? refined.auth_required : prevAuth;

    setRequirements(memory, {
      userMessage: command.userMessage,
      website_type: refined.website_type || memory.requirements?.website_type || 'business',
      pages: mergedPages.length > 0 ? mergedPages : (existingPages.length > 0 ? existingPages : ['home']),
      backend_required: refinedBackend || prevBackend || backendSignals,
      auth_required: refinedAuth || prevAuth || authSignals,
      deployment_pref: refined.deployment_pref || memory.requirements?.deployment_pref || 'auto',
      notes: [memory.requirements?.notes, refined.notes].filter(Boolean).join(' ') || undefined,
    });
    appendHistory(memory, 'clarification', 'requirements_refined', 'Requirements refined from clarification answers', memory.requirements);
    await persistMemory(memory, options.persistence);
    options.adapter?.emit?.({ type: 'progress', stage: 'clarification', percent: options.percent || 16, message: 'requirements refined from clarifications' });
  } catch (err) {
    // Refinement is best-effort; downstream defensive fallback covers empty pages.
    logError('orchestrator:refine-requirements-failed', { error: err instanceof Error ? err.message : String(err), projectId: memory.projectId });
  }
}

async function runConfirmationGate(
  memory: ProjectMemory,
  command: OrchestrationCommand,
  projectSpec: any,
  options: StageOptions
): Promise<{ confirmed: boolean }> {
  if (memory.confirmation?.confirmed) return { confirmed: true };

  if (command.confirmation?.confirmed) {
    setConfirmation(memory, {
      confirmed: true,
      summary: projectSpec,
      userResponse: command.confirmation.userResponse,
    });
    appendHistory(memory, 'confirmation', 'confirmation_received', 'User confirmed project spec');
    await persistMemory(memory, options.persistence);
    await persistLastEvent(memory, options.persistence);
    options.adapter?.emit?.({ type: 'stage_complete', stage: 'confirmation' });
    return { confirmed: true };
  }

  markStage(memory, 'confirmation');
  appendHistory(memory, 'confirmation', 'confirmation_request', 'Awaiting user confirmation', projectSpec);
  await persistMemory(memory, options.persistence);
  await persistLastEvent(memory, options.persistence);
  options.adapter?.emit?.({ type: 'confirmation_request', stage: 'confirmation', summary: projectSpec });
  return { confirmed: false };
}

type StageRepair = (memory: ProjectMemory, issues: ConsistencyIssue[], command: OrchestrationCommand) => string[];

function runConsistencyReport(memory: ProjectMemory, command: OrchestrationCommand, activeStage: OrchestrationState) {
  const projectSpec = buildProjectSpec(memory, command);
  return validateProjectConsistency({
    projectSpec,
    requirementAnalysis: memory.requirements,
    clarifications: memory.clarifications,
    systemDesign: memory.systemDesign,
    uiSpec: memory.uiSpec,
    blueprint: memory.blueprint?.blueprint,
    codeGen: memory.code,
    activeStage,
  });
}

/**
 * Self-healing consistency gate. Validates the cross-stage report; if it fails,
 * runs a stage-specific deterministic repair that mutates memory in place; then
 * re-validates. Loops up to 3 passes with a strict monotonic-decrease invariant
 * on the issue count so a non-progressing repair fails loudly instead of spinning.
 *
 * Why this lives at the orchestrator boundary instead of inside each agent:
 * the systemDesign frontend-only path (buildFrontendOnlySystemDesign) bypasses
 * systemDesignAgent entirely, so agent-local repair would miss it. Centralising
 * here ensures every stage's consistency surface gets the same repair semantics
 * regardless of how the artifact was produced.
 */
function assertConsistencyWithSelfHeal(
  memory: ProjectMemory,
  command: OrchestrationCommand,
  activeStage: OrchestrationState,
  repair?: StageRepair
): void {
  let lastIssueCount = Infinity;
  for (let pass = 0; pass < 3; pass += 1) {
    const report = runConsistencyReport(memory, command, activeStage);
    if (report.ok) return;
    if (!repair) break;
    if (report.issues.length >= lastIssueCount) {
      throw new Error(
        `Cross-stage consistency self-heal stalled at ${activeStage} after ${pass} pass(es):\n${formatConsistencyIssues(report)}`
      );
    }
    lastIssueCount = report.issues.length;
    const repairs = repair(memory, report.issues, command);
    appendHistory(memory, activeStage, 'self_heal_repair', `Applied ${repairs.length} repair(s)`, repairs);
    if (repairs.length === 0) {
      throw new Error(
        `Cross-stage consistency validation failed at ${activeStage} (no repair pattern matched):\n${formatConsistencyIssues(report)}`
      );
    }
  }
  // Final report after the budget is exhausted.
  const finalReport = runConsistencyReport(memory, command, activeStage);
  if (!finalReport.ok) {
    throw new Error(
      `Cross-stage consistency validation failed at ${activeStage} after self-heal budget:\n${formatConsistencyIssues(finalReport)}`
    );
  }
}

// ---- Per-stage repair functions ---------------------------------------------

function repairSystemDesign(memory: ProjectMemory, issues: ConsistencyIssue[]): string[] {
  const repairs: string[] = [];
  const sd: any = memory.systemDesign || {};
  sd.frontend = sd.frontend || { framework: 'react-vite', pages: [], components: [], styling: 'css' };
  sd.frontend.pages = Array.isArray(sd.frontend.pages) ? sd.frontend.pages : [];

  for (const issue of issues) {
    const missingPage = /missing page from requirements:\s*(.+)$/i.exec(issue.message);
    if (missingPage) {
      const page = missingPage[1].trim();
      if (!sd.frontend.pages.some((p: unknown) => String(p).toLowerCase() === page.toLowerCase())) {
        sd.frontend.pages.push(page);
        repairs.push(`added page "${page}" to systemDesign.frontend.pages`);
      }
      continue;
    }
    if (/required backend architecture is missing/i.test(issue.message)) {
      sd.backend = sd.backend || { framework: 'node-ts', api_style: 'rest', endpoints: [] };
      sd.database = sd.database || { type: 'postgresql', tables: [] };
      repairs.push('seeded missing backend/database scaffolding');
    }
  }
  memory.systemDesign = sd;
  return repairs;
}

function repairUiSpec(_memory: ProjectMemory, issues: ConsistencyIssue[]): string[] {
  const repairs: string[] = [];
  for (const issue of issues) {
    // UI spec missing: cannot synthesize deterministically — surface as a hard failure
    // rather than the misleading "no repair pattern matched" generic message.
    if (/UI spec is missing/i.test(issue.message)) {
      throw new Error(`ui_spec consistency failure: ${issue.message}. The UI spec agent must be re-run.`);
    }
    // System design page-coverage mismatches reported at this stage are already handled
    // by repairSystemDesign on the previous stage boundary; they cannot be fixed here.
    if (/missing page from requirements/i.test(issue.message)) {
      repairs.push(`deferred page-coverage issue to upstream system_design repair: ${issue.message}`);
    }
  }
  return repairs;
}

function repairCode(memory: ProjectMemory, issues: ConsistencyIssue[]): string[] {
  const repairs: string[] = [];
  if (!memory.code) memory.code = { files: [], patch: '' };
  memory.code.files = Array.isArray(memory.code.files) ? memory.code.files : [];

  const componentNameFromPath = (filePath: string): string => {
    const base = filePath.replace(/\\/g, '/').split('/').pop() || 'Component';
    return base.replace(/\.[^./]+$/, '').replace(/[^a-zA-Z0-9]/g, '') || 'Component';
  };

  // Normalize a component file path so "Foo.jsx" and "FooPage.jsx" / "FooSection.jsx"
  // are treated as equivalent when checking whether a page already has coverage.
  const normalizeComponentPath = (p: string) =>
    p.replace(/\\/g, '/').replace(/^\/+/, '')
     .replace(/src\/components\//, '')
     .replace(/\.(jsx|tsx)$/, '')
     .replace(/(Page|Section|View|Screen|Panel|Container|Layout|Wrapper)$/i, '')
     .toLowerCase();

  for (const issue of issues) {
    const missingFile = /missing generated file for expected path:\s*(.+)$/i.exec(issue.message);
    if (missingFile) {
      const filePath = missingFile[1].trim();
      const normalizedMissing = normalizeComponentPath(filePath);

      // Exact match — already generated.
      if (memory.code.files.some((f) => String(f.path).replace(/\\/g, '/').replace(/^\/+/, '') === filePath)) continue;

      // Fuzzy match — a variant like FooPage.jsx already covers Foo.jsx; skip the stub.
      if (
        filePath.startsWith('src/components/') &&
        memory.code.files.some((f) => {
          const fp = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '');
          return fp.startsWith('src/components/') && normalizeComponentPath(fp) === normalizedMissing;
        })
      ) continue;

      const path = filePath;

      let content = '';
      if (path === 'src/App.jsx') {
        // Minimal but renderable App shell — renders nothing visible but does not crash.
        content = `import React from 'react';\nexport default function App() {\n  return <div id="app" />;\n}\n`;
      } else if (path === 'src/index.css') {
        content = `:root { color-scheme: light; }\nbody { margin: 0; font-family: system-ui, sans-serif; }\n`;
      } else if (/\.jsx$/.test(path)) {
        const name = componentNameFromPath(path);
        // Use the STUB_COMPONENT marker so testFixAgent and selfHealWithCodeGeneration
        // both recognise this file as needing real implementation, not just build-error fixes.
        content = `import React from 'react';\n/* STUB_COMPONENT: ${name} — needs real implementation */\nexport default function ${name}() {\n  return <div className="section">${name}</div>;\n}\n`;
      } else {
        content = '';
      }
      memory.code.files.push({ path, content });
      repairs.push(`added stub file ${path}`);
      continue;
    }

    if (/generated App\.jsx is missing default App export/i.test(issue.message)) {
      const appFile = memory.code.files.find((f) => String(f.path).replace(/\\/g, '/').replace(/^\/+/, '') === 'src/App.jsx');
      if (appFile) {
        const original = String(appFile.content || '');
        appFile.content = `${original}\n\nexport default function App() {\n  return <div id="app" />;\n}\n`;
        repairs.push('appended default App export to src/App.jsx');
      }
    }
  }
  return repairs;
}

// Backwards-compatible thin wrapper so existing call sites without a repair
// function still work as a non-self-healing assertion.
function assertConsistency(memory: ProjectMemory, command: OrchestrationCommand, activeStage: OrchestrationState): void {
  assertConsistencyWithSelfHeal(memory, command, activeStage);
}

/**
 * Decide whether a downstream failure (currently only blueprint stage) carries
 * diagnostics that an upstream agent could plausibly act on if re-run with
 * feedback. Returns the upstream stage to replay and the human-readable hints
 * to inject into that agent's prompt. Returns empty result when the failure is
 * either non-actionable upstream (orchestrator-level routing problem) or
 * already handled by the agent's own self-heal (and thus not worth replaying).
 *
 * The classification is intentionally pattern-based on issue messages — those
 * messages are the same strings produced by validateProjectConsistency, so we
 * have a single source of truth for what each pattern means.
 */
/**
 * LLM-assisted fallback for upstream triage. Only invoked when the rule-based
 * classifier cannot map any issue to an upstream stage but issues remain —
 * those would otherwise terminate the pipeline as a dead-end. The LLM is asked
 * to pick the single upstream stage (ui_spec or system_design) most likely to
 * unblock the run when re-entered with hints. Failures degrade silently to "no
 * route" so a flaky proxy can never make routing worse than the deterministic
 * baseline.
 */
async function llmTriageUpstreamFeedback(
  issues: import('../contracts/orchestration').OrchestrationIssue[],
  projectId: string,
): Promise<{ targetStage: OrchestrationState | ''; issues: string[] }> {
  const chain = getModelPriorityChain('orchestration');
  const [primary, ...fallbacks] = chain;
  if (!primary?.apiKey) return { targetStage: '', issues: [] };

  const client = new LLMProxyClient({ apiKey: primary.apiKey, projectId, fallbacks });
  const issueLines = issues
    .map((i) => `- [${i.type}] ${String(i.message || '').slice(0, 240)}`)
    .slice(0, 25)
    .join('\n');

  const system = [
    'You triage blueprint-stage failures in a multi-agent code generation pipeline.',
    'Decide which upstream stage to re-enter with hints. Allowed stages: "ui_spec", "system_design", or "" (none / not actionable upstream).',
    'Respond with strict JSON: {"targetStage": "ui_spec"|"system_design"|"", "issues": string[]}.',
    'Each entry in "issues" is a concrete hint the upstream agent can act on. If no upstream re-entry would help, return targetStage="" and issues=[].',
  ].join(' ');
  const user = `Blueprint-stage issues:\n${issueLines}\n\nReturn JSON only.`;

  try {
    const response = await client.chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      primary.model,
      0.1,
      0.9,
      400,
    );
    const text = String(response?.choices?.[0]?.message?.content ?? response?.content ?? '').trim();
    if (!text) return { targetStage: '', issues: [] };
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { targetStage: '', issues: [] };
    const parsed = JSON.parse(text.slice(start, end + 1));
    const target = parsed?.targetStage;
    const hints = Array.isArray(parsed?.issues)
      ? parsed.issues.map((s: unknown) => String(s)).filter((s: string) => s.trim().length > 0)
      : [];
    if ((target === 'ui_spec' || target === 'system_design') && hints.length > 0) {
      return { targetStage: target, issues: hints };
    }
    return { targetStage: '', issues: [] };
  } catch (err: any) {
    logError('orchestrator:llm_triage_failed', { error: err?.message || String(err), projectId });
    return { targetStage: '', issues: [] };
  }
}

function extractUpstreamFeedback(issues: import('../contracts/orchestration').OrchestrationIssue[]): { targetStage: OrchestrationState | ''; issues: string[] } {
  const uiSpecHints: string[] = [];
  const systemDesignHints: string[] = [];

  for (const issue of issues) {
    const text = String(issue?.message || '');
    // Page coverage issues map to ui_spec — components for that page are missing.
    if (/blueprint missing route for system design page:\s*(.+)/i.test(text)) {
      const m = /blueprint missing route for system design page:\s*(.+)/i.exec(text);
      const page = m?.[1]?.trim() || '';
      uiSpecHints.push(`Add a top-level component for the page "${page}" so the blueprint can wire a route to it. The page name was requested explicitly in requirements.`);
      continue;
    }
    // UI component wiring issues map to ui_spec — the spec listed a component the blueprint can't realise.
    if (/missing wiring for UI component:\s*(.+)/i.test(text)) {
      const m = /missing wiring for UI component:\s*(.+)/i.exec(text);
      const comp = m?.[1]?.trim() || '';
      uiSpecHints.push(`The previous spec listed component "${comp}" but the blueprint could not place it. Either omit it, or ensure it is referenced by another component's "dependencies" so it has an owner.`);
      continue;
    }
    // System design page-coverage maps back to system_design.
    if (/missing page from requirements:\s*(.+)/i.test(text)) {
      const m = /missing page from requirements:\s*(.+)/i.exec(text);
      const page = m?.[1]?.trim() || '';
      systemDesignHints.push(`Include the page "${page}" in frontend.pages — it appears in the canonical requirements list.`);
      continue;
    }
    if (/required backend architecture is missing/i.test(text)) {
      systemDesignHints.push('A backend was requested in requirements; emit a non-null backend block with concrete routes and a database block with concrete tables.');
      continue;
    }
    // Wiring-only issues (App.jsx mustInclude tokens) are blueprint-internal —
    // already handled by blueprintAgent's self-heal pass and not actionable upstream.
  }

  // Prefer routing to ui_spec first when present (closer to the symptom); fall back to system_design.
  if (uiSpecHints.length > 0) return { targetStage: 'ui_spec', issues: uiSpecHints };
  if (systemDesignHints.length > 0) return { targetStage: 'system_design', issues: systemDesignHints };
  return { targetStage: '', issues: [] };
}

/**
 * Stage-scoped review + fix loop. Returns when approved or when the fix
 * budget is exhausted; caller handles non-approval (typically regenerate).
 *
 * Fails safe: a null fixer result (LLM error or schema-invalid patch) ends
 * the loop so the caller can fall back to regeneration. The fixer enforces
 * the stage's schema, so a malformed patch can never reach memory.
 */
async function runStageReviewFixLoop(args: {
  stage: import('../../agents/stageReviewer').ReviewableStage;
  projectId: string;
  memory: ProjectMemory;
  getArtifact: () => unknown;
  installFix: (patched: unknown) => void;
  maxFixLoops?: number;
}): Promise<{ approved: boolean; notes: string[]; hints: string[] }> {
  const maxFixLoops = args.maxFixLoops ?? 2;
  let fixLoops = 0;
  while (true) {
    const review = await reviewStage({
      stage: args.stage,
      projectId: args.projectId,
      requirements: args.memory.requirements,
      clarifications: args.memory.clarifications,
      artifact: args.getArtifact(),
    });
    if (review.approved) return { approved: true, notes: [], hints: [] };
    if (fixLoops >= maxFixLoops) return { approved: false, notes: review.notes, hints: review.hints };

    const fixed = await fixStage({
      stage: args.stage,
      projectId: args.projectId,
      artifact: args.getArtifact(),
      notes: review.hints,
      requirements: args.memory.requirements,
      clarifications: args.memory.clarifications,
    });
    if (!fixed) return { approved: false, notes: review.notes, hints: review.hints };

    args.installFix(fixed.artifact);
    appendHistory(
      args.memory,
      args.stage,
      'stage_fix_applied',
      `fixer applied ${fixed.applied.length}, rejected ${fixed.rejected.length}`,
      { applied: fixed.applied, rejected: fixed.rejected },
    );

    // Fixer pushed back on every note — re-reviewing produces the same notes,
    // so accept the fixer's judgement and stop looping.
    if (fixed.allRejected) {
      appendHistory(
        args.memory,
        args.stage,
        'stage_review_overridden',
        `fixer rejected all ${fixed.rejected.length} note(s) as false positives — accepting`,
        fixed.rejected,
      );
      return { approved: true, notes: [], hints: [] };
    }

    fixLoops += 1;
  }
}

function invalidateDownstream(memory: ProjectMemory, fromStage: OrchestrationState): void {
  const order: OrchestrationState[] = [
    'requirements',
    'clarification',
    'confirmation',
    'system_design',
    'ui_spec',
    'blueprint',
    'execution_plan',
    'code_generation',
    'testing',
    'deployment',
  ];
  const idx = order.indexOf(fromStage);
  if (idx < 0) return;
  const drop = new Set(order.slice(idx));
  memory.checkpoints = memory.checkpoints.filter((cp) => !drop.has(cp.stage));
}

export async function runAIOrchestration(
  command: OrchestrationCommand,
  adapter: OrchestrationAdapter = {},
  persistence: PersistenceAdapter = {}
): Promise<OrchestrationResult> {
  const sessionId = command.sessionId || command.projectId;
  const memory = await loadOrCreateMemory(command, sessionId, persistence);

  // Phase 3 budget controller: initialize budget tracking for this project
  // before any LLM proxy call is made.
  initBudget(memory.projectId, config.LIMITS.maxTokensPerProject);

  const orchestratorDeadlineAt = Date.now() + config.LIMITS.maxOrchestrationMs;
  const opts: StageOptions = { adapter, persistence, deadlineAt: orchestratorDeadlineAt };
  // codeGenDeadlineAt and testDeadlineAt are computed lazily (right before each
  // stageWrap call) so their minimum-budget windows open from actual stage-start
  // time, not from orchestration-start time.
  const CODE_GEN_MIN_BUDGET_MS = 15 * 60 * 1000;
  const TEST_MIN_BUDGET_MS = 8 * 60 * 1000;

  // Modification fast-path: previously-completed project receiving a change request
  if (command.modification && (memory.status === 'completed' || memory.currentState === 'done') && (memory.deployment?.frontendUrl || memory.deployment?.backendUrl)) {
    setModification(memory, {
      modification: command.modification,
      appliedAt: new Date().toISOString(),
      affectedStages: ['blueprint', 'code_generation', 'testing', 'deployment'],
    });
    invalidateDownstream(memory, 'blueprint');
    memory.status = 'active';
    appendHistory(memory, 'modification', 'modification_started', 'Re-entering pipeline at blueprint for modification', command.modification);
    await persistMemory(memory, persistence);
    await persistLastEvent(memory, persistence);
    adapter.emit?.({ type: 'stage_start', stage: 'modification', message: 'Applying modification' });
  } else {
    appendHistory(memory, memory.currentState || 'requirements', 'orchestration_start', 'Orchestration started', command);
    await persistLastEvent(memory, persistence);
    adapter.emit?.({ type: 'progress', stage: memory.currentState || 'requirements', percent: 0, message: 'orchestration started' });
  }

  // 1. Requirements
  if (!memory.requirements?.website_type) {
    const requirementsResult = await stageWrap(
      memory,
      'requirements',
      command.userMessage,
      async () => {
        const result = await requirementAnalysisAgent({ user_message: command.userMessage, projectId: command.projectId });
        const requirements = toRequirementAnalysisOutput(
          (result as { output?: RequirementAnalysisShape }).output || (result as unknown as RequirementAnalysisShape)
        );
        setRequirements(memory, {
          userMessage: command.userMessage,
          website_type: requirements.website_type,
          pages: requirements.pages,
          backend_required: requirements.backend_required,
          auth_required: requirements.auth_required,
          deployment_pref: requirements.deployment_pref,
          notes: requirements.notes,
        });
        return requirements;
      },
      { ...opts, percent: 5 }
    );
    if (requirementsResult.status !== 'success') return finalizeResult(memory, requirementsResult, null, null);
  }

  // 2. Clarification loop (pause-resume aware)
  if (!memory.clarifications?.done) {
    const clarOutcome = await runClarificationLoop(memory, command, { ...opts, percent: 12 });
    if (!clarOutcome.done) {
      return finalizePartial(memory, 'clarification', persistence);
    }
  }

  // 2b. Refine requirements with clarification answers so downstream stages
  // see an updated pages/backend/auth picture instead of the initial extraction.
  await refineRequirementsFromClarifications(memory, command, { ...opts, percent: 16 });

  // 3. Build canonical project spec + post-clarification consistency check
  const projectSpec = buildProjectSpec(memory, command);
  appendHistory(memory, 'clarification', 'project_spec_ready', 'Canonical project spec created', projectSpec);
  await persistLastEvent(memory, persistence);
  assertConsistency(memory, command, 'clarification');

  // 4. Confirmation gate (pause-resume aware)
  const confirmation = await runConfirmationGate(memory, command, projectSpec, { ...opts, percent: 18 });
  if (!confirmation.confirmed) {
    return finalizePartial(memory, 'confirmation', persistence);
  }

  // 5-7. Design → UI spec → Blueprint, with cross-stage feedback self-heal.
  //
  // When the blueprint stage detects a defect that originated upstream (e.g. a
  // requested page has no corresponding ui_spec component, or system_design
  // dropped a backend feature), the orchestrator captures the diagnostic as
  // memory.pendingFeedback and re-enters the upstream stage with the feedback
  // injected into the agent's input. Bounded by `maxDesignFeedbackLoops` so a
  // genuinely unfixable mismatch fails loudly instead of spinning. Loop budget
  // is in addition to per-stage retries (which target transient failures).
  const maxDesignFeedbackLoops = 2;
  let designLoop = 0;
  let designResolved = false;
  let lastBlueprintResult: StageResult<unknown> | null = null;

  while (!designResolved && designLoop <= maxDesignFeedbackLoops) {
    // Capture and consume any pending feedback for this iteration.
    const feedbackForUiSpec =
      memory.pendingFeedback?.targetStage === 'ui_spec' ? memory.pendingFeedback.issues.slice() : [];
    const feedbackForSystemDesign =
      memory.pendingFeedback?.targetStage === 'system_design' ? memory.pendingFeedback.issues.slice() : [];

    // 5. System design — generate → (review → fix)* → regenerate on fix failure.
    const maxSystemDesignRegenLoops = 2;
    const maxSystemDesignFixLoops = 2;
    let systemDesignRegenLoops = 0;
    let systemDesignResult: StageResult<unknown>;
    while (true) {
      // Use only the stable, user-provided fields as the hash input for system_design.
      // projectSpec also contains memory.systemDesign/uiSpec/blueprint which are undefined
      // on the first run but populated on resume — causing a permanent hash mismatch.
      const systemDesignHashInput = {
        userMessage: command.userMessage,
        requirements: memory.requirements,
        clarifications: memory.clarifications,
        feedback: feedbackForSystemDesign.slice(),
      };
      systemDesignResult = await stageWrap(memory, 'system_design', systemDesignHashInput, async () => {
        const result = await systemDesignAgent({
          projectId: command.projectId,
          requirements: memory.requirements,
          projectSpec,
          previousIssues: feedbackForSystemDesign,
        });
        if (isFrontendOnlyRequirements(memory.requirements) && result.output) {
          (result.output as any).backend = null;
          (result.output as any).database = null;
          (result.output as any).auth = null;
          if ((result.output as any).hosting) {
            (result.output as any).hosting.backend = null;
          }
        }
        setSystemDesign(memory, result.output);
        assertConsistencyWithSelfHeal(memory, command, 'system_design', repairSystemDesign);
        return result.output;
      }, {
        ...opts,
        percent: 25,
        onRetry: (_attempt, err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg) feedbackForSystemDesign.push(msg);
        },
      });

      if (systemDesignResult.status !== 'success') break;

      const reviewOutcome = await runStageReviewFixLoop({
        stage: 'system_design',
        projectId: command.projectId,
        memory,
        getArtifact: () => memory.systemDesign,
        installFix: (patched) => setSystemDesign(memory, patched as any),
        maxFixLoops: maxSystemDesignFixLoops,
      });
      if (reviewOutcome.approved) break;

      if (systemDesignRegenLoops >= maxSystemDesignRegenLoops) {
        appendHistory(
          memory,
          'system_design',
          'stage_review_unresolved',
          `proceeding with ${reviewOutcome.notes.length} unresolved reviewer note(s)`,
          reviewOutcome.notes,
        );
        break;
      }

      appendHistory(
        memory,
        'system_design',
        'stage_review_regenerate',
        `${reviewOutcome.notes.length} note(s) after fix loop; regenerating system_design`,
        reviewOutcome.notes,
      );
      for (const hint of reviewOutcome.hints) {
        if (!feedbackForSystemDesign.includes(hint)) feedbackForSystemDesign.push(hint);
      }
      invalidateDownstream(memory, 'system_design');
      memory.systemDesign = undefined;
      systemDesignRegenLoops += 1;
    }

    if (systemDesignResult.status !== 'success') return finalizeResult(memory, systemDesignResult, null, null);

    // 6. UI spec — generate → (review → fix)* → regenerate on fix failure.
    // On both caps exhausted, the existing blueprint-feedback loop is the
    // safety net.
    const maxUiSpecRegenLoops = 2;
    const maxUiSpecFixLoops = 2;
    let uiSpecRegenLoops = 0;
    let uiSpecResult: StageResult<unknown>;
    while (true) {
      // Vary the stageWrap input hash by feedback length so the checkpoint
      // cache does not short-circuit a forced re-run with new hints.
      const uiSpecHashInput = { systemDesign: memory.systemDesign, feedback: feedbackForUiSpec.slice() };
      uiSpecResult = await stageWrap(memory, 'ui_spec', uiSpecHashInput, async () => {
        const result = await uiSpecAgent({
          projectId: command.projectId,
          requirements: memory.requirements,
          systemDesign: memory.systemDesign,
          projectSpec,
          previousIssues: feedbackForUiSpec,
          globalState: {
            activeState: memory.currentState,
            projectSpec,
            consistencyScore: memory.uiSpec?.structuredSpec ? 1 : 0,
            domain: 'ui_spec',
            transitions: [],
          },
        });
        setUISpec(memory, { uiSpec: result.output, structuredSpec: result.output });
        assertConsistencyWithSelfHeal(memory, command, 'ui_spec', repairUiSpec);
        return result.output;
      }, {
        ...opts,
        percent: 35,
        onRetry: (_attempt, err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg) feedbackForUiSpec.push(msg);
        },
      });

      if (uiSpecResult.status !== 'success') break;

      const reviewOutcome = await runStageReviewFixLoop({
        stage: 'ui_spec',
        projectId: command.projectId,
        memory,
        getArtifact: () => memory.uiSpec?.structuredSpec,
        installFix: (patched) => setUISpec(memory, { uiSpec: patched, structuredSpec: patched }),
        maxFixLoops: maxUiSpecFixLoops,
      });
      if (reviewOutcome.approved) break;

      if (uiSpecRegenLoops >= maxUiSpecRegenLoops) {
        appendHistory(
          memory,
          'ui_spec',
          'stage_review_unresolved',
          `proceeding with ${reviewOutcome.notes.length} unresolved reviewer note(s)`,
          reviewOutcome.notes,
        );
        break;
      }

      // Fix loop exhausted without approval — regenerate from scratch with hints.
      appendHistory(
        memory,
        'ui_spec',
        'stage_review_regenerate',
        `${reviewOutcome.notes.length} note(s) after fix loop; regenerating ui_spec`,
        reviewOutcome.notes,
      );
      for (const hint of reviewOutcome.hints) {
        if (!feedbackForUiSpec.includes(hint)) feedbackForUiSpec.push(hint);
      }
      invalidateDownstream(memory, 'ui_spec');
      memory.uiSpec = undefined;
      uiSpecRegenLoops += 1;
    }

    if (uiSpecResult.status !== 'success') return finalizeResult(memory, uiSpecResult, null, null);

    // 7. Blueprint
    const blueprintResult = await stageWrap(memory, 'blueprint', memory.uiSpec, async () => {
      const result = await blueprintAgent({
        requirements: memory.requirements,
        systemDesign: memory.systemDesign,
        uiSpec: memory.uiSpec,
        projectSpec,
        projectId: command.projectId,
        modification: command.modification,
      });
      setBlueprint(memory, { blueprint: result.output });
      assertConsistency(memory, command, 'blueprint');
      return result.output;
    }, { ...opts, percent: 50 });

    lastBlueprintResult = blueprintResult;

    // Track whether we're routing because of review rejection (synthetic issues
    // tuned for LLM triage) vs blueprint-generation failure (real issues with
    // patterns the deterministic classifier can match). Lets us skip the rule
    // pass when we already know it won't match.
    let routingFromReview = false;
    let reviewIssues: import('../contracts/orchestration').OrchestrationIssue[] = [];

    if (blueprintResult.status === 'success') {
      // Stage-scoped review + fix pass on the blueprint before accepting it.
      const reviewOutcome = await runStageReviewFixLoop({
        stage: 'blueprint',
        projectId: command.projectId,
        memory,
        getArtifact: () => memory.blueprint?.blueprint,
        installFix: (patched) => setBlueprint(memory, { blueprint: patched }),
        maxFixLoops: 2,
      });

      if (reviewOutcome.approved) {
        memory.pendingFeedback = undefined;
        designResolved = true;
        break;
      }

      // Fix loop exhausted — route upstream via llmTriageUpstreamFeedback.
      // The deterministic extractUpstreamFeedback uses regex patterns tuned for
      // blueprint-generation error messages; reviewer notes are written in
      // different language and won't match, so skip it and save the call.
      routingFromReview = true;
      reviewIssues = reviewOutcome.hints.map((hint, idx) => ({
        id: `blueprint_review_${designLoop}_${idx}`,
        projectId: memory.projectId,
        sessionId: memory.sessionId,
        stage: 'blueprint' as OrchestrationState,
        type: 'semantic_inconsistency' as const,
        severity: 'medium' as const,
        message: hint,
        recoverable: true,
      }));
      appendHistory(
        memory,
        'blueprint',
        'stage_review_rejected',
        `${reviewOutcome.notes.length} unresolved blueprint note(s); routing upstream`,
        reviewOutcome.notes,
      );
    }

    // Decide which upstream stage to re-enter:
    //  - blueprint-generation failure: try deterministic rules first, fall back to LLM triage.
    //  - blueprint-review rejection:   skip rules (won't match reviewer prose), go straight to LLM triage.
    const issuesForTriage = routingFromReview ? reviewIssues : blueprintResult.issues;
    let upstreamHints = routingFromReview
      ? { targetStage: '' as OrchestrationState | '', issues: [] as string[] }
      : extractUpstreamFeedback(blueprintResult.issues);
    if (!upstreamHints.targetStage && issuesForTriage.length > 0) {
      upstreamHints = await llmTriageUpstreamFeedback(issuesForTriage, memory.projectId);
    }
    const canFeedback = designLoop < maxDesignFeedbackLoops && upstreamHints.targetStage && upstreamHints.issues.length > 0;
    if (!canFeedback) {
      return finalizeResult(memory, blueprintResult, null, null);
    }

    memory.pendingFeedback = {
      targetStage: upstreamHints.targetStage as OrchestrationState,
      issues: upstreamHints.issues,
      sourceStage: 'blueprint',
      createdAt: new Date().toISOString(),
    };
    appendHistory(
      memory,
      'blueprint',
      'feedback_captured',
      `Captured ${upstreamHints.issues.length} hint(s) for ${upstreamHints.targetStage}; re-entering`,
      memory.pendingFeedback
    );
    invalidateDownstream(memory, upstreamHints.targetStage as OrchestrationState);
    await persistMemory(memory, persistence);
    adapter.emit?.({
      type: 'progress',
      stage: upstreamHints.targetStage as OrchestrationState,
      percent: 22,
      message: `replaying ${upstreamHints.targetStage} with feedback`,
    });
    designLoop += 1;
  }

  if (!designResolved) {
    return finalizeResult(memory, lastBlueprintResult ?? createFailedResult('blueprint', [], 'blueprint'), null, null);
  }

  const executionPlan = buildExecutionPlan(memory);
  setExecutionPlan(memory, executionPlan);
  appendHistory(memory, 'execution_plan', 'execution_plan_ready', 'Execution plan derived', executionPlan);

  const codeGenDeadlineAt = Math.max(orchestratorDeadlineAt, Date.now() + CODE_GEN_MIN_BUDGET_MS);
  const codeResult = await stageWrap(memory, 'code_generation', executionPlan, async () => {
    const generated = await codeGenerationAgent({
      systemDesign: memory.systemDesign,
      uiSpec: memory.uiSpec?.structuredSpec,
      structuredSpec: memory.uiSpec?.structuredSpec,
      blueprint: memory.blueprint?.blueprint,
      requirements: memory.requirements,
      projectSpec,
      modification: command.modification,
      projectId: command.projectId,
      user_id: command.sessionId,
      emitEvent: (e: { type: string; filePath?: string; message?: string; payload?: { path?: string; content?: string } }) => {
        if (e.type === 'FILE_WRITTEN' && e.filePath) {
          const content = typeof e.payload?.content === 'string' ? e.payload.content : '';
          const lines = content ? content.replace(/\n$/, '').split('\n').length : 0;
          const bytes = content ? Buffer.byteLength(content) : 0;
          // Persist full content out-of-band so it can be fetched on demand by
          // the file viewer. Keep the WS payload tiny — shipping every file body
          // through the socket saturated the outbound buffer and was killing
          // heartbeats mid-codegen.
          void persistence.appendEvent?.({
            id: '',
            projectId: command.projectId,
            sessionId: command.sessionId,
            stage: 'code_generation',
            type: 'file_generated',
            message: `Wrote ${e.filePath}`,
            payload: { path: e.filePath, content, lines, bytes },
            createdAt: new Date().toISOString(),
          });
          adapter.emit?.({
            type: 'file_generated',
            stage: 'code_generation',
            filePath: e.filePath,
            lines,
            bytes,
          });
        } else if (e.type === 'AGENT_THINKING' && e.message) {
          adapter.emit?.({ type: 'info', stage: 'code_generation', message: e.message });
        }
      },
    });
    setCode(memory, { files: generated.files || [], patch: generated.patch || '' });
    assertConsistencyWithSelfHeal(memory, command, 'code_generation', repairCode);
    return generated;
  }, { ...opts, deadlineAt: codeGenDeadlineAt, percent: 65 });

  if (codeResult.status !== 'success') return finalizeResult(memory, codeResult, null, null);

  const materializedRevision = await materializeProjectWorkspace({
    projectId: command.projectId,
    codeGen: memory.code,
    backendRequired: Boolean(memory.requirements?.backend_required),
  });
  appendHistory(memory, 'code_generation', 'workspace_materialized', 'Generated workspace materialized', materializedRevision);
  await persistLastEvent(memory, persistence);
  if (persistence.saveCodeRevision && memory.code) {
    try {
      await persistence.saveCodeRevision({
        projectId: command.projectId,
        files: memory.code.files,
        patch: memory.code.patch,
        workspacePath: materializedRevision.workspaceDir,
        sourceArchivePath: materializedRevision.archivePath,
        sourceHash: materializedRevision.sourceHash,
        patchPath: materializedRevision.patchPath,
        patchApplied: materializedRevision.patchApplied,
        patchApplyLog: materializedRevision.patchApplyLog,
      });
    } catch { /* best-effort */ }
  }

  // Give testing its own minimum budget from when it actually starts, so
  // an extended code_gen run does not starve the build/test/fix loop.
  const testDeadlineAt = Math.max(orchestratorDeadlineAt, Date.now() + TEST_MIN_BUDGET_MS);
  const testResult = await stageWrap(memory, 'testing', memory.code, async () => {
    const result = await testFixAgent({
      buildFn: () =>
        runBuildWorker({
          workspaceDir: materializedRevision.workspaceDir,
          deadlineAt: testDeadlineAt,
          onLog: (chunk) => {
            const text = String(chunk || '');
            if (!text.trim()) return;
            // Emit chunked output; client will render as info lines.
            adapter.emit?.({ type: 'info', stage: 'testing', message: text.trimEnd() });
          },
        }),
      files: memory.code?.files,
      workspaceDir: materializedRevision.workspaceDir,
      projectId: command.projectId,
      deadlineAt: testDeadlineAt,
      blueprint: memory.blueprint?.blueprint,
      fixFn: async (logs: string) => {
        await selfHealWithCodeGeneration(memory, command, projectSpec, logs, command.projectId, testDeadlineAt);
        // Write healed files to disk so testFixAgent's fingerprint check detects a real change.
        const healedFiles = memory.code?.files ?? [];
        await Promise.all(healedFiles.map((f) => writeGeneratedFile(materializedRevision.workspaceDir, f).catch(() => {})));
        // Return healed files so testFixAgent can update its internal reference and
        // re-scan imports when applying pre-build fixes (package.json dep detection).
        return healedFiles;
      },
      emitInfo: (message: string) => adapter.emit?.({ type: 'info', stage: 'testing', message }),
    });
    const buildArtifacts = toBuildArtifact(result);
    setTests(memory, { success: result.success, logs: result.logs, buildDir: buildArtifacts.buildDir, backendDir: buildArtifacts.backendDir });
    return { ...result, ...buildArtifacts };
  }, { ...opts, deadlineAt: testDeadlineAt, percent: 80 });

  if (testResult.status !== 'success') return finalizeResult(memory, testResult, null, null);

  try {
    await runFinalAudit(projectSpec, memory);
  } catch (auditErr) {
    // Final audit failures are non-blocking — log the issue and continue to
    // deployment rather than leaving the project stuck in a non-failed terminal
    // state with no path to recovery.
    logError('orchestrator:finalAudit', auditErr);
    appendIssue(memory, classifyError({ projectId: memory.projectId, sessionId: memory.sessionId, stage: 'testing' as any, error: auditErr, details: {} }));
    await persistMemory(memory, persistence);
  }

  const deploymentResult = await stageWrap(memory, 'deployment', memory.tests, async () => {
    const result = await deploymentAgent({
      projectId: command.projectId,
      revisionId: materializedRevision.revisionId,
      buildDir: memory.tests?.buildDir || materializedRevision.workspaceDir,
      backendDir: memory.tests?.backendDir,
      workspaceRoot: materializedRevision.workspaceDir,
      frontendProjectName: `proj-${command.projectId.slice(0, 10)}`,
      backendService: `backend-${command.projectId.slice(0, 10)}`,
      hasBackend: Boolean(memory.requirements?.backend_required),
    });

    setDeployment(memory, {
      frontendUrl: result.frontend_url || null,
      backendUrl: result.backend_url || null,
      raw: result,
    });

    // Tighten semantics:
    // If backend was requested and Railway indicates backend deployment failed,
    // treat deployment stage as failed so the client receives a 'failed' event.
    const wantsBackend = Boolean(memory.requirements?.backend_required);
    const railwayStatus = (result as any).railway_status as string | undefined;
    if (wantsBackend && (railwayStatus === 'deploy_error' || railwayStatus === 'failed')) {
      throw new Error(`Backend deployment failed (railway_status=${railwayStatus})`);
    }

    return result;
  }, { ...opts, percent: 95 });

  if (deploymentResult.status !== 'success') {
    adapter.emit?.({ type: 'failed', projectId: command.projectId, issues: deploymentResult.issues });
    return finalizeResult(memory, deploymentResult, memory.deployment?.frontendUrl || null, memory.deployment?.backendUrl || null);
  }

  if (persistence.saveDeployment && memory.deployment) {
    const raw = (memory.deployment.raw || {}) as Record<string, unknown>;
    try {
      await persistence.saveDeployment({
        projectId: command.projectId,
        frontendUrl: memory.deployment.frontendUrl,
        backendUrl: memory.deployment.backendUrl,
        raw: memory.deployment.raw,
        vercelDeploymentId: typeof raw.vercel_deployment_id === 'string' ? raw.vercel_deployment_id : undefined,
        vercelInspectUrl: typeof raw.vercel_inspect_url === 'string' ? raw.vercel_inspect_url : undefined,
        vercelStatus: typeof raw.vercel_status === 'string' ? raw.vercel_status : undefined,
        vercelLogUrl: typeof raw.vercel_log_url === 'string' ? raw.vercel_log_url : undefined,
        railwayDeploymentId: typeof raw.railway_deployment_id === 'string' ? raw.railway_deployment_id : undefined,
        railwayStatus: typeof raw.railway_status === 'string' ? raw.railway_status : undefined,
        railwayLogUrl: typeof raw.railway_log_url === 'string' ? raw.railway_log_url : undefined,
        railwayDashboardUrl: typeof raw.railway_dashboard_url === 'string' ? raw.railway_dashboard_url : undefined,
        sourceArchivePath: materializedRevision.archivePath,
        sourceHash: materializedRevision.sourceHash,
      });
    } catch { /* best-effort */ }
  }

  adapter.emit?.({
    type: 'done',
    projectId: command.projectId,
    frontendUrl: memory.deployment?.frontendUrl || null,
    backendUrl: memory.deployment?.backendUrl || null,
  });

  finalizeMemory(memory, true);
  await persistMemory(memory, persistence);
  await cleanupWorkspace(materializedRevision.workspaceDir).catch(() => {});
  return {
    projectId: command.projectId,
    sessionId,
    frontendUrl: memory.deployment?.frontendUrl || null,
    backendUrl: memory.deployment?.backendUrl || null,
    status: 'completed',
    memory,
  };
}

function finalizeResult(
  memory: ProjectMemory,
  stageResult: StageResult<unknown>,
  frontendUrl: string | null,
  backendUrl: string | null
): OrchestrationResult {
  // stageWrap already persisted memory on all non-success paths.
  // For interactive states we MUST NOT force the pipeline into "failed".
  if (stageResult.status === 'needs_input' || stageResult.status === 'needs_fix') {
    memory.status = 'paused';
    // markStage() already moved currentState to stageResult.state for these paths,
    // but keep it explicit for safety.
    memory.currentState = stageResult.state;
    return {
      projectId: memory.projectId,
      sessionId: memory.sessionId,
      frontendUrl,
      backendUrl,
      status: 'partial',
      memory,
    };
  }

  finalizeMemory(memory, false);
  return {
    projectId: memory.projectId,
    sessionId: memory.sessionId,
    frontendUrl,
    backendUrl,
    status: 'failed',
    memory,
  };
}
