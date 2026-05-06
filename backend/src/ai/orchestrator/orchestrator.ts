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
import { validateProjectConsistency, formatConsistencyIssues } from '../../agents/projectConsistency';
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
import { resolveRecoveryRoute, type PipelineStage } from '../../orchestration/pipelineStateMachine';
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
    default:
      return 'code_generation';
  }
}

type StageOptions = {
  adapter?: OrchestrationAdapter;
  persistence?: PersistenceAdapter;
  percent?: number;
};

async function persistMemory(memory: ProjectMemory, persistence?: PersistenceAdapter): Promise<void> {
  if (!persistence?.saveSnapshot) return;
  try {
    await persistence.saveSnapshot(memory);
  } catch {
    // best-effort persistence; never fail the pipeline on snapshot errors
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
  const { adapter, persistence, percent } = options;
  const policy = currentPolicy(memory);
  const inputHash = hashInput({ stage, input, memory: { projectId: memory.projectId, sessionId: memory.sessionId } });
  const cached = memory.checkpoints.find((item) => item.stage === stage && item.inputHash === inputHash);
  if (cached && cached.output !== undefined) {
    adapter?.emit?.({ type: 'info', stage, message: `resumed ${stage} from checkpoint` });
    return createSuccessResult(stage, cached.output as T, undefined, cached.issues);
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
      const output = await handler();
      const checkpoint = saveCheckpoint(memory, stage, inputHash, output, [], attempt);
      appendHistory(memory, stage, 'stage_complete', `Completed ${stage}`, undefined);
      await persistMemory(memory, persistence);
      await persistLastEvent(memory, persistence);
      if (persistence?.saveCheckpoint) {
        try { await persistence.saveCheckpoint(checkpoint); } catch { /* best-effort */ }
      }
      adapter?.emit?.({ type: 'stage_complete', stage, output });
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
  projectId: string
): Promise<void> {
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
  if (persistence.loadSnapshot) {
    try {
      const snapshot = await persistence.loadSnapshot(command.projectId);
      if (snapshot) return snapshot;
    } catch {
      // fall through to fresh memory
    }
  }
  const deploymentMode = command.step === 'deployment' ? 'full-stack' : 'frontend-only';
  return createInitialMemory({
    projectId: command.projectId,
    sessionId,
    userMessage: command.userMessage,
    deploymentMode,
  });
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
    options.adapter?.emit?.({ type: 'stage_complete', stage: 'confirmation', output: projectSpec });
    return { confirmed: true };
  }

  markStage(memory, 'confirmation');
  appendHistory(memory, 'confirmation', 'confirmation_request', 'Awaiting user confirmation', projectSpec);
  await persistMemory(memory, options.persistence);
  await persistLastEvent(memory, options.persistence);
  options.adapter?.emit?.({ type: 'confirmation_request', stage: 'confirmation', summary: projectSpec });
  return { confirmed: false };
}

function assertConsistency(memory: ProjectMemory, command: OrchestrationCommand, activeStage: OrchestrationState): void {
  const projectSpec = buildProjectSpec(memory, command);
  const report = validateProjectConsistency({
    projectSpec,
    requirementAnalysis: memory.requirements,
    clarifications: memory.clarifications,
    systemDesign: memory.systemDesign,
    uiSpec: memory.uiSpec,
    blueprint: memory.blueprint?.blueprint,
    codeGen: memory.code,
    activeStage,
  });
  if (!report.ok) {
    throw new Error(`Cross-stage consistency validation failed at ${activeStage}:\n${formatConsistencyIssues(report)}`);
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
  const opts: StageOptions = { adapter, persistence };

  // Modification fast-path: previously-completed project receiving a change request
  if (command.modification && (memory.status === 'completed' || memory.currentState === 'done')) {
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
        const result = await requirementAnalysisAgent({ user_message: command.userMessage });
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
      : await systemDesignAgent({ requirements: memory.requirements, projectSpec });
    setSystemDesign(memory, result.output);
    assertConsistency(memory, command, 'system_design');
    return result.output;
  }, { ...opts, percent: 25 });

  if (systemDesignResult.status !== 'success') return finalizeResult(memory, systemDesignResult, null, null);

  const uiSpecResult = await stageWrap(memory, 'ui_spec', memory.systemDesign, async () => {
    const result = await uiSpecAgent({
      requirements: memory.requirements,
      systemDesign: memory.systemDesign,
      projectSpec,
      globalState: {
        activeState: memory.currentState,
        projectSpec,
        consistencyScore: memory.uiSpec?.structuredSpec ? 1 : 0,
        domain: 'ui_spec',
        transitions: [],
      },
    });
    setUISpec(memory, { uiSpec: result.output, structuredSpec: result.output });
    assertConsistency(memory, command, 'ui_spec');
    return result.output;
  }, { ...opts, percent: 35 });

  if (uiSpecResult.status !== 'success') return finalizeResult(memory, uiSpecResult, null, null);

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

  if (blueprintResult.status !== 'success') return finalizeResult(memory, blueprintResult, null, null);

  const executionPlan = buildExecutionPlan(memory);
  setExecutionPlan(memory, executionPlan);
  appendHistory(memory, 'execution_plan', 'execution_plan_ready', 'Execution plan derived', executionPlan);

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
    });
    setCode(memory, { files: generated.files || [], patch: generated.patch || '' });
    assertConsistency(memory, command, 'code_generation');
    return generated;
  }, { ...opts, percent: 65 });

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

  const testResult = await stageWrap(memory, 'testing', memory.code, async () => {
    const result = await testFixAgent({
      buildFn: () => runBuildWorker({ workspaceDir: materializedRevision.workspaceDir }),
      files: memory.code?.files,
      workspaceDir: materializedRevision.workspaceDir,
      projectId: command.projectId,
      fixFn: async (logs: string) => {
        await selfHealWithCodeGeneration(memory, command, projectSpec, logs, command.projectId);
      },
    });
    const buildArtifacts = toBuildArtifact(result);
    setTests(memory, { success: result.success, logs: result.logs, buildDir: buildArtifacts.buildDir, backendDir: buildArtifacts.backendDir });
    return { ...result, ...buildArtifacts };
  }, { ...opts, percent: 80 });

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
    return result;
  }, { ...opts, percent: 95 });

  if (deploymentResult.status !== 'success') return finalizeResult(memory, deploymentResult, null, null);

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
  finalizeMemory(memory, false);
  return {
    projectId: memory.projectId,
    sessionId: memory.sessionId,
    frontendUrl,
    backendUrl,
    status: stageResult.status === 'needs_input' ? 'partial' : 'failed',
    memory,
  };
}
