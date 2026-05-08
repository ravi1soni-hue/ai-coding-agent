import crypto from 'crypto';
import { isValidTransition, normalizePipelineStage } from '../../orchestration/pipelineStateMachine';
import type {
  BlueprintMemory,
  ClarificationMemory,
  CodeMemory,
  ConfirmationMemory,
  DeploymentMemory,
  ExecutionPlan,
  ModificationMemory,
  OrchestrationCheckpoint,
  OrchestrationEvent,
  OrchestrationIssue,
  OrchestrationState,
  ProjectMemory,
  RequirementsMemory,
  SystemDesignMemory,
  TestMemory,
  UISpecMemory,
  DeploymentMode,
} from '../contracts/orchestration';

export type MemorySeed = {
  projectId: string;
  sessionId: string;
  userMessage: string;
  deploymentMode: DeploymentMode;
};

export function createInitialMemory(seed: MemorySeed): ProjectMemory {
  return {
    projectId: seed.projectId,
    sessionId: seed.sessionId,
    currentState: 'requirements',
    deploymentMode: seed.deploymentMode,
    requirements: {
      userMessage: seed.userMessage,
      pages: [],
      backend_required: false,
      auth_required: false,
    },
    history: [],
    errors: [],
    fixes: [],
    checkpoints: [],
    status: 'active',
  };
}

export function appendHistory(
  memory: ProjectMemory,
  stage: OrchestrationState,
  type: string,
  message?: string,
  payload?: unknown
): void {
  memory.history.push({
    id: crypto.randomUUID(),
    projectId: memory.projectId,
    sessionId: memory.sessionId,
    stage,
    type,
    message,
    payload,
    createdAt: new Date().toISOString(),
  });
  // Prune old history to prevent bloat, keep last 100
  if (memory.history.length > 100) {
    memory.history = memory.history.slice(-100);
  }
}

export function appendIssue(memory: ProjectMemory, issue: OrchestrationIssue): void {
  memory.errors.push(issue);
  memory.status = issue.recoverable ? 'recovering' : 'failed';
}

export function recordFix(memory: ProjectMemory, stage: OrchestrationState, message: string): void {
  memory.fixes.push({
    id: crypto.randomUUID(),
    stage,
    message,
    createdAt: new Date().toISOString(),
  });
}

export function saveCheckpoint<T>(
  memory: ProjectMemory,
  stage: OrchestrationState,
  inputHash: string,
  output: T | undefined,
  issues: OrchestrationIssue[],
  retryCount: number
): OrchestrationCheckpoint<T> {
  const checkpoint: OrchestrationCheckpoint<T> = {
    projectId: memory.projectId,
    sessionId: memory.sessionId,
    stage,
    inputHash,
    output,
    issues,
    retryCount,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memory.checkpoints = memory.checkpoints.filter((item) => item.stage !== stage);
  memory.checkpoints.push(checkpoint);
  return checkpoint;
}

export function getCheckpoint(memory: ProjectMemory, stage: OrchestrationState): OrchestrationCheckpoint | undefined {
  return memory.checkpoints.find((item) => item.stage === stage);
}

export function setRequirements(memory: ProjectMemory, requirements: RequirementsMemory): void {
  memory.requirements = requirements;
}

export function setClarifications(memory: ProjectMemory, clarifications: ClarificationMemory): void {
  memory.clarifications = clarifications;
}

export function setConfirmation(memory: ProjectMemory, confirmation: ConfirmationMemory): void {
  memory.confirmation = confirmation;
}

export function setModification(memory: ProjectMemory, modification: ModificationMemory): void {
  memory.modification = modification;
}

export function setSystemDesign(memory: ProjectMemory, systemDesign: SystemDesignMemory): void {
  memory.systemDesign = systemDesign;
}

export function setUISpec(memory: ProjectMemory, uiSpec: UISpecMemory): void {
  memory.uiSpec = uiSpec;
}

export function setBlueprint(memory: ProjectMemory, blueprint: BlueprintMemory): void {
  memory.blueprint = blueprint;
}

export function setExecutionPlan(memory: ProjectMemory, executionPlan: ExecutionPlan): void {
  memory.executionPlan = executionPlan;
}

export function setCode(memory: ProjectMemory, code: CodeMemory): void {
  memory.code = code;
}

export function setTests(memory: ProjectMemory, tests: TestMemory): void {
  memory.tests = tests;
}

export function setDeployment(memory: ProjectMemory, deployment: DeploymentMemory): void {
  memory.deployment = deployment;
}

export function hashInput(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export function markStage(memory: ProjectMemory, stage: OrchestrationState): void {
  const fromStage = normalizePipelineStage(memory.currentState);
  const toStage = normalizePipelineStage(stage);
  if (!isValidTransition(fromStage, toStage)) {
    throw new Error(`Invalid state transition from ${fromStage} to ${toStage}`);
  }
  memory.currentState = stage;
}

export function finalizeMemory(memory: ProjectMemory, success: boolean): ProjectMemory {
  memory.status = success ? 'completed' : 'failed';
  memory.currentState = success ? 'done' : 'failed';
  return memory;
}
