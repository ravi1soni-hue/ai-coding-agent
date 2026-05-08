import type { OrchestrationErrorType, OrchestrationIssue, OrchestrationState } from '../contracts/orchestration';

function createIssueId(projectId: string, stage: OrchestrationState, type: OrchestrationErrorType): string {
  return `${projectId}:${stage}:${type}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function toMessage(value: unknown): string {
  if (value instanceof Error) return value.message || 'Unknown error';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'message' in value) return String((value as { message?: unknown }).message ?? 'Unknown error');
  return String(value ?? 'Unknown error');
}

export function classifyError(input: {
  projectId: string;
  sessionId: string;
  stage: OrchestrationState;
  error: unknown;
  details?: unknown;
}): OrchestrationIssue {
  const message = toMessage(input.error);
  const lowered = message.toLowerCase();

  let type: OrchestrationErrorType = 'unknown_error';
  let severity: 'low' | 'medium' | 'high' | 'critical' = 'medium';
  let recoverable = true;
  let fixStrategy: OrchestrationIssue['fixStrategy'] = 'retry';

  if (/state transition|illegal stage|cannot transition/i.test(lowered)) {
    type = 'state_transition_error';
    severity = 'high';
    recoverable = false;
    fixStrategy = 'fallback';
  } else if (/unauthorized|forbidden|access denied/i.test(lowered)) {
    type = 'authorization_error';
    severity = 'high';
    recoverable = false;
    fixStrategy = 'ask_user';
  } else if (/deploy|vercel|railway|upload|publish/i.test(lowered)) {
    type = 'deployment_error';
    fixStrategy = 'retry';
  } else if (/build|compile|tsc|vite|npm run build|runtime/i.test(lowered)) {
    type = 'build_error';
    fixStrategy = 'repair';
  } else if (/sql|query|project_id|api.*project/i.test(lowered)) {
    type = 'api_contract_error';
    fixStrategy = 'repair';
  } else if (/inconsistent|conflict|mismatch|contradict/i.test(lowered)) {
    type = 'semantic_inconsistency';
    fixStrategy = 'repair';
  } else if (/schema|shape|contract|missing .*field|invalid .*output/i.test(lowered)) {
    type = 'schema_mismatch';
    fixStrategy = 'repair';
  } else if (/json|parse|unexpected token|malformed/i.test(lowered)) {
    type = 'parsing_error';
    fixStrategy = 'retry';
  } else if (/missing|required|not provided|undefined|null/i.test(lowered)) {
    type = 'missing_data';
    fixStrategy = 'ask_user';
  }

  if (/crash|fatal|panic|exception/i.test(lowered)) {
    severity = 'high';
  }

  if (/unauthorized|forbidden|access denied/i.test(lowered)) {
    severity = 'high';
    recoverable = false;
  }

  return {
    id: createIssueId(input.projectId, input.stage, type),
    projectId: input.projectId,
    sessionId: input.sessionId,
    stage: input.stage,
    type,
    severity,
    message,
    details: input.details,
    recoverable,
    fixStrategy,
  };
}

export function classifyIssues(input: {
  projectId: string;
  sessionId: string;
  stage: OrchestrationState;
  errors: unknown[];
  details?: unknown;
}): OrchestrationIssue[] {
  return input.errors.map((error) =>
    classifyError({
      projectId: input.projectId,
      sessionId: input.sessionId,
      stage: input.stage,
      error,
      details: input.details,
    })
  );
}
