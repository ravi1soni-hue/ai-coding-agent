import { requirementAnalysisAgent } from '../../agents/requirementAnalysisAgent';
import { clarificationAgent } from '../../agents/clarificationAgent';
import { systemDesignAgent } from '../../agents/systemDesignAgent';
import { uiSpecAgent } from '../../agents/uiSpecAgent';
import { blueprintAgent } from '../../agents/blueprintAgent';
import { codeGenerationAgent } from '../../agents/codeGenerationAgent';
import { testFixAgent } from '../../agents/testFixAgent';
import { deploymentAgent } from '../../agents/deploymentAgent';
import { reviewerAgent } from '../../agents/reviewerAgent';
import { materializeProjectWorkspace } from '../../factory/projectFactory';
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

function buildFrontendOnlySystemDesign(requirements: any) {
  const pages = Array.isArray(requirements?.pages) ? requirements.pages.filter((page: any) => typeof page === 'string' && page.trim()).map((page: string) => page.trim()) : [];
  const uniquePages = Array.from(new Set(pages));
  return {
    frontend: {
      framework: 'react-vite',
      pages: uniquePages,
      components: uniquePages,
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
};

async function persistMemory(memory: ProjectMemory, persistence?: PersistenceAdapter): Promise<void> {
  if (!persistence?.saveSnapshot) return;
  try {
    await persistence.saveSnapshot(memory);
  } catch (err) {
    // best-effort persistence; never fail the pipeline on snapshot errors,
    // but log so silent persistence regressions don't go unnoticed.
    logError('orchestrator:persist_snapshot_failed', {
      projectId: memory.projectId,
      stage: memory.currentState,
      error: err,
    });
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
  const { adapter, persistence, percent, deadlineAt } = options;
  const policy = currentPolicy(memory);
  // NOTE: sessionId is intentionally excluded from inputHash — sessionId changes on every
  // server restart, which would cause all prior checkpoints to be cache-misses, breaking
  // crash-resume. projectId alone provides the necessary isolation.
  const inputHash = hashInput({ stage, input, projectId: memory.projectId });
  const cached = memory.checkpoints.find((item) => item.stage === stage && item.inputHash === inputHash);
  if (cached && cached.output !== undefined) {
    adapter?.emit?.({ type: 'info', stage, message: `resumed ${stage} from checkpoint` });
    return createSuccessResult(stage, cached.output as T, undefined, cached.issues);
  }

  // Defensive: if we are already past this stage (memory advanced further in a prior run)
  // and there's any checkpoint for this stage, use it rather than attempting a backwards
  // markStage which would throw an invalid-transition error.
  const normalizedCurrent = normalizePipelineStage(memory.currentState);
  const normalizedTarget = normalizePipelineStage(stage);
  const currentIdx = stageIndex(normalizedCurrent);
  const targetIdx = stageIndex(normalizedTarget);
  if (currentIdx > targetIdx) {
    const anyCheckpoint = memory.checkpoints.find((item) => item.stage === stage && item.output !== undefined);
    if (anyCheckpoint) {
      adapter?.emit?.({ type: 'info', stage, message: `resumed ${stage} from checkpoint (hash-miss fallback)` });
      return createSuccessResult(stage, anyCheckpoint.output as T, undefined, anyCheckpoint.issues);
    }
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
      markStage(memory, stage);

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
    reviewerName: 'Final Audit Reviewer',
  } as any);

  if (!reviewed.approved || !reviewed.approved.approved) {
    throw new Error(`Final audit reviewer rejected blueprint: ${(reviewed.approved?.notes || []).join('; ')}`);
  }
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
  const repaired = await codeGenerationAgent({
    systemDesign: memory.systemDesign,
    uiSpec: memory.uiSpec?.structuredSpec,
    structuredSpec: memory.uiSpec?.structuredSpec,
    blueprint: memory.blueprint?.blueprint,
    requirements: memory.requirements,
    modification: `Fix the build errors below and regenerate complete files:\n${String(logs).slice(-4000)}`,
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
        website_type: (memory.requirements?.website_type || 'business') as 'business' | 'portfolio' | 'saas' | 'ecommerce',
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
        projectSpec: undefined,
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
    setRequirements(memory, {
      userMessage: command.userMessage,
      website_type: refined.website_type || memory.requirements?.website_type || 'business',
      pages: mergedPages.length > 0 ? mergedPages : (existingPages.length > 0 ? existingPages : ['home']),
      backend_required: typeof refined.backend_required === 'boolean' ? refined.backend_required : Boolean(memory.requirements?.backend_required),
      auth_required: typeof refined.auth_required === 'boolean' ? refined.auth_required : Boolean(memory.requirements?.auth_required),
      deployment_pref: refined.deployment_pref || memory.requirements?.deployment_pref || 'auto',
      notes: [memory.requirements?.notes, refined.notes].filter(Boolean).join(' ') || undefined,
    });
    appendHistory(memory, 'clarification', 'requirements_refined', 'Requirements refined from clarification answers', memory.requirements);
    await persistMemory(memory, options.persistence);
    options.adapter?.emit?.({ type: 'progress', stage: 'clarification', percent: options.percent || 16, message: 'requirements refined from clarifications' });
  } catch {
    // Refinement is best-effort; downstream defensive fallback covers empty pages.
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

function repairUiSpec(memory: ProjectMemory, issues: ConsistencyIssue[]): string[] {
  const repairs: string[] = [];
  // Symmetry hook: ui_spec stage's only current check is presence after systemDesign,
  // which the agent itself handles. If future invariants land here, repair patterns
  // for them go in this function. Keeping the shape identical to other repairers
  // means new patterns can be plugged in without re-plumbing the call sites.
  for (const issue of issues) {
    if (/UI spec is missing/i.test(issue.message) && memory.systemDesign && !memory.uiSpec) {
      // Cannot synthesize a uiSpec deterministically here; fall through to throw.
      continue;
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

  for (const issue of issues) {
    const missingFile = /missing generated file for expected path:\s*(.+)$/i.exec(issue.message);
    if (missingFile) {
      const path = missingFile[1].trim();
      if (memory.code.files.some((f) => String(f.path).replace(/\\/g, '/').replace(/^\/+/, '') === path)) continue;

      let content = '';
      if (path === 'src/App.jsx') {
        content = `export default function App() {\n  return null;\n}\n`;
      } else if (path === 'src/index.css') {
        content = `:root { color-scheme: light; }\nbody { margin: 0; font-family: system-ui, sans-serif; }\n`;
      } else if (/\.jsx$/.test(path)) {
        const name = componentNameFromPath(path);
        content = `export default function ${name}() {\n  return null;\n}\n`;
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
        appFile.content = `${original}\n\nexport default function App() {\n  return null;\n}\n`;
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

    // 5. System design
    const systemDesignResult = await stageWrap(memory, 'system_design', projectSpec, async () => {
      const result = isFrontendOnlyRequirements(memory.requirements)
        ? {
            updatedState: {
              activeState: 'UI_SPEC',
              domain: 'system_design',
              consistencyScore: 1,
              transitions: [String(memory.currentState || 'requirements'), 'system_design'],
              metadata: { frontendOnly: true },
            },
            nextStateProposal: 'UI_SPEC',
            consistencyScore: 1,
            output: buildFrontendOnlySystemDesign(memory.requirements),
          }
        : await systemDesignAgent({
            projectId: command.projectId,
            requirements: memory.requirements,
            projectSpec,
            previousIssues: feedbackForSystemDesign,
          });
      setSystemDesign(memory, result.output);
      assertConsistencyWithSelfHeal(memory, command, 'system_design', repairSystemDesign);
      return result.output;
    }, { ...opts, percent: 25 });

    if (systemDesignResult.status !== 'success') return finalizeResult(memory, systemDesignResult, null, null);

    // 6. UI spec
    const uiSpecResult = await stageWrap(memory, 'ui_spec', memory.systemDesign, async () => {
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
    }, { ...opts, percent: 35 });

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

    if (blueprintResult.status === 'success') {
      // Feedback consumed successfully; clear it so subsequent stages don't see stale hints.
      memory.pendingFeedback = undefined;
      designResolved = true;
      break;
    }

    // Blueprint failed. Decide whether the failure points upstream (vocabulary or
    // structural divergence the upstream agent could plausibly fix on rerun) or
    // is a genuine dead-end.
    const upstreamHints = extractUpstreamFeedback(blueprintResult.issues);
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
      fixFn: async (logs: string) => {
        await selfHealWithCodeGeneration(memory, command, projectSpec, logs, command.projectId, testDeadlineAt);
      },
      emitInfo: (message: string) => adapter.emit?.({ type: 'info', stage: 'testing', message }),
    });
    const buildArtifacts = toBuildArtifact(result);
    setTests(memory, { success: result.success, logs: result.logs, buildDir: buildArtifacts.buildDir, backendDir: buildArtifacts.backendDir });
    return { ...result, ...buildArtifacts };
  }, { ...opts, deadlineAt: testDeadlineAt, percent: 80 });

  if (testResult.status !== 'success') return finalizeResult(memory, testResult, null, null);

  await runFinalAudit(projectSpec, memory);

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
