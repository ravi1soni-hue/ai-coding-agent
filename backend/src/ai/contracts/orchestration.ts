export type DeploymentMode = 'frontend-only' | 'full-stack';

export type OrchestrationState =
  | 'requirements'
  | 'clarification'
  | 'system_design'
  | 'ui_spec'
  | 'blueprint'
  | 'execution_plan'
  | 'code_generation'
  | 'testing'
  | 'deployment'
  | 'done'
  | 'failed';

export type OrchestrationErrorType =
  | 'parsing_error'
  | 'schema_mismatch'
  | 'missing_data'
  | 'semantic_inconsistency'
  | 'code_runtime_error'
  | 'build_error'
  | 'deployment_error'
  | 'api_contract_error'
  | 'state_transition_error'
  | 'unknown_error';

export type OrchestrationIssue = {
  id: string;
  projectId: string;
  sessionId: string;
  stage: OrchestrationState;
  type: OrchestrationErrorType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details?: unknown;
  recoverable: boolean;
  fixStrategy?: 'retry' | 'repair' | 'ask_user' | 'fallback' | 'skip_noncritical';
};

export type RetryPolicy = {
  maxAttempts: number;
  maxFixAttempts: number;
  relaxOnRetry: boolean;
  allowFallback: boolean;
  allowUserQuestion: boolean;
};

export type StageResult<T> = {
  state: OrchestrationState;
  status: 'success' | 'partial' | 'needs_input' | 'needs_fix' | 'failed';
  output?: T;
  issues: OrchestrationIssue[];
  nextState?: OrchestrationState;
  retryable: boolean;
  resumeToken?: string;
};

export type OrchestrationCheckpoint<T = unknown> = {
  projectId: string;
  sessionId: string;
  stage: OrchestrationState;
  inputHash: string;
  output?: T;
  issues: OrchestrationIssue[];
  retryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type OrchestrationEvent = {
  id: string;
  projectId: string;
  sessionId: string;
  stage: OrchestrationState;
  type: string;
  message?: string;
  payload?: unknown;
  createdAt: string;
};

export type RequirementsMemory = {
  userMessage: string;
  website_type?: string;
  pages: string[];
  backend_required: boolean;
  auth_required: boolean;
  deployment_pref?: string;
  notes?: string;
};

export type ClarificationMemory = {
  questions: string[];
  confirmed: boolean;
  done: boolean;
  answers: Record<string, string>;
  askedQuestions: string[];
};

export type SystemDesignMemory = {
  frontend: unknown;
  backend: unknown;
  database: unknown;
  auth: unknown;
  hosting: unknown;
};

export type UISpecMemory = {
  uiSpec: unknown;
  structuredSpec: unknown;
};

export type BlueprintMemory = {
  blueprint: unknown;
};

export type ExecutionPlanFile = {
  path: string;
  dependsOn: string[];
  purpose: string;
  kind: 'entry' | 'component' | 'route' | 'style' | 'config' | 'schema' | 'utility';
};

export type ExecutionPlan = {
  projectId: string;
  sessionId: string;
  deploymentMode: DeploymentMode;
  fileOrder: string[];
  dependencyGraph: Record<string, string[]>;
  phases: Array<{
    name: string;
    files: string[];
    dependencies: string[];
    retryPolicy: RetryPolicy;
  }>;
  apiUsageClarity: Array<{
    file: string;
    endpoint: string;
    method: string;
    projectIdRequired: boolean;
    dataScope: 'project-scoped';
  }>;
  repairOrder: string[];
};

export type CodeMemory = {
  files: Array<{ path: string; content: string }>;
  patch?: string;
  buildDir?: string | null;
  backendDir?: string | null;
};

export type TestMemory = {
  success: boolean;
  logs: string;
  buildDir?: string;
  backendDir?: string;
};

export type DeploymentMemory = {
  frontendUrl: string | null;
  backendUrl: string | null;
  raw?: unknown;
};

export type ProjectMemory = {
  projectId: string;
  sessionId: string;
  currentState: OrchestrationState;
  deploymentMode: DeploymentMode;
  requirements?: RequirementsMemory;
  clarifications?: ClarificationMemory;
  systemDesign?: SystemDesignMemory;
  uiSpec?: UISpecMemory;
  blueprint?: BlueprintMemory;
  executionPlan?: ExecutionPlan;
  code?: CodeMemory;
  tests?: TestMemory;
  deployment?: DeploymentMemory;
  history: OrchestrationEvent[];
  errors: OrchestrationIssue[];
  fixes: Array<{ id: string; stage: OrchestrationState; message: string; createdAt: string }>;
  checkpoints: OrchestrationCheckpoint[];
  status: 'active' | 'paused' | 'recovering' | 'completed' | 'failed';
};

export type OrchestrationCommand = {
  projectId: string;
  sessionId: string;
  userMessage: string;
  modification?: string;
  clarificationAnswers?: Record<string, string>;
  step?: OrchestrationState;
};

export type OrchestrationResult = {
  projectId: string;
  sessionId: string;
  frontendUrl: string | null;
  backendUrl: string | null;
  status: 'completed' | 'partial' | 'failed';
  memory: ProjectMemory;
};
