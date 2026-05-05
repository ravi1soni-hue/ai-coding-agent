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
  setBlueprint,
  setClarifications,
  setCode,
  setDeployment,
  setExecutionPlan,
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

async function stageWrap<T>(
  memory: ProjectMemory,
  stage: OrchestrationState,
  input: unknown,
  handler: () => Promise<T>
): Promise<StageResult<T>> {
  const policy = currentPolicy(memory);
  const inputHash = hashInput({ stage, input, memory: { projectId: memory.projectId, sessionId: memory.sessionId } });
  const checkpoint = memory.checkpoints.find((item) => item.stage === stage && item.inputHash === inputHash);
  if (checkpoint && checkpoint.output !== undefined) {
    return createSuccessResult(stage, checkpoint.output as T, undefined, checkpoint.issues);
  }

  let attempt = 0;
  let fixAttempt = 0;
  let lastError: unknown = null;

  while (shouldRetryStage(attempt, policy)) {
    try {
      markStage(memory, stage);
      const output = await handler();
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
    requirements: memory.requirements,
    modification: `Fix the build errors below and regenerate complete files:\n${String(logs).slice(-4000)}`,
    projectSpec,
    projectId,
    user_id: command.sessionId,
  });
  setCode(memory, { files: repaired.files || [], patch: repaired.patch || '' });
  recordFix(memory, 'code_generation', 'Applied automated repair after test failure');
}

export async function runAIOrchestration(
  command: OrchestrationCommand,
  adapter: OrchestrationAdapter = {},
  persistence: PersistenceAdapter = {}
): Promise<OrchestrationResult> {
  void persistence;
  const sessionId = command.sessionId || command.projectId;
  const deploymentMode = command.step === 'deployment' ? 'full-stack' : 'frontend-only';
  const memory = createInitialMemory({
    projectId: command.projectId,
    sessionId,
    userMessage: command.userMessage,
    deploymentMode,
  });

  appendHistory(memory, 'requirements', 'orchestration_start', 'Orchestration started', command);

  const requirementsResult = await stageWrap(memory, 'requirements', command.userMessage, async () => {
    const result = await requirementAnalysisAgent({ user_message: command.userMessage });
    const requirements = toRequirementAnalysisOutput((result as { output?: RequirementAnalysisShape }).output || (result as unknown as RequirementAnalysisShape));
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
  });

  if (requirementsResult.status !== 'success') return finalizeResult(memory, requirementsResult, null, null);

  const clarificationResult = await stageWrap(memory, 'clarification', memory.requirements, async () => {
    const result = await clarificationAgent({
      requirements: {
        website_type: memory.requirements?.website_type || 'business',
        pages: memory.requirements?.pages || [],
        backend_required: Boolean(memory.requirements?.backend_required),
        auth_required: Boolean(memory.requirements?.auth_required),
        deployment_pref: memory.requirements?.deployment_pref,
        notes: memory.requirements?.notes,
      },
      clarificationAnswers: command.clarificationAnswers || {},
      askedQuestions: [],
      projectSpec: undefined,
      modification: command.modification,
    });
    const clarification = toClarificationOutput(result.output, command.clarificationAnswers || {});
    setClarifications(memory, {
      questions: clarification.questions,
      confirmed: clarification.confirmed,
      done: clarification.done,
      answers: clarification.context.clarificationAnswers,
      askedQuestions: clarification.context.askedQuestions,
    });
    return clarification;
  });

  if (clarificationResult.status === 'needs_input') return finalizeResult(memory, clarificationResult, null, null);

  const projectSpec = validateProjectSpec(
    consolidateProjectSpec({
      projectId: command.projectId,
      userMessage: command.userMessage,
      requirements: {
        website_type: (memory.requirements?.website_type || 'business') as 'business' | 'portfolio' | 'saas' | 'ecommerce',
        pages: memory.requirements?.pages || [],
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
      systemDesign: undefined,
      uiSpec: undefined,
      blueprint: undefined,
      modification: command.modification,
    }),
    { partial: true }
  );

  appendHistory(memory, 'clarification', 'project_spec_ready', 'Canonical project spec created', projectSpec);

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
    return result.output;
  });

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
    return result.output;
  });

  if (uiSpecResult.status !== 'success') return finalizeResult(memory, uiSpecResult, null, null);

  const blueprintResult = await stageWrap(memory, 'blueprint', memory.uiSpec, async () => {
    const output = await blueprintAgent({
      requirements: memory.requirements,
      systemDesign: memory.systemDesign,
      uiSpec: memory.uiSpec,
      projectSpec,
      projectId: command.projectId,
      modification: command.modification,
    });
    setBlueprint(memory, { blueprint: output });
    return output;
  });

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
    return generated;
  });

  if (codeResult.status !== 'success') return finalizeResult(memory, codeResult, null, null);

  const materializedRevision = await materializeProjectWorkspace({
    projectId: command.projectId,
    codeGen: memory.code,
  });
  appendHistory(memory, 'code_generation', 'workspace_materialized', 'Generated workspace materialized', materializedRevision);

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
  });

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
  });

  if (deploymentResult.status !== 'success') return finalizeResult(memory, deploymentResult, null, null);

  adapter.emit?.({
    type: 'done',
    projectId: command.projectId,
    frontendUrl: memory.deployment?.frontendUrl || null,
    backendUrl: memory.deployment?.backendUrl || null,
  });

  finalizeMemory(memory, true);
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
