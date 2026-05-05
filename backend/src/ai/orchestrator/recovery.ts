import type {
  OrchestrationIssue,
  OrchestrationState,
  RetryPolicy,
  StageResult,
} from '../contracts/orchestration';

export type RecoveryAction = 'retry' | 'repair' | 'ask_user' | 'fallback' | 'skip';

export function decideRecoveryAction(issue: OrchestrationIssue, policy: RetryPolicy): RecoveryAction {
  if (!issue.recoverable) return 'fallback';
  if (issue.fixStrategy === 'ask_user' && policy.allowUserQuestion) return 'ask_user';
  if (issue.fixStrategy === 'repair' && policy.maxFixAttempts > 0) return 'repair';
  if (issue.fixStrategy === 'fallback' && policy.allowFallback) return 'fallback';
  if (issue.fixStrategy === 'skip_noncritical') return 'skip';
  return policy.relaxOnRetry ? 'retry' : 'repair';
}

export function shouldRetryStage(attempt: number, policy: RetryPolicy): boolean {
  return attempt < policy.maxAttempts;
}

export function shouldAttemptRepair(fixAttempt: number, policy: RetryPolicy): boolean {
  return fixAttempt < policy.maxFixAttempts;
}

export function createNeedsInputResult<T>(
  state: OrchestrationState,
  issues: OrchestrationIssue[],
  nextState?: OrchestrationState
): StageResult<T> {
  return {
    state,
    status: 'needs_input',
    issues,
    nextState,
    retryable: true,
  };
}

export function createNeedsFixResult<T>(
  state: OrchestrationState,
  issues: OrchestrationIssue[],
  nextState?: OrchestrationState
): StageResult<T> {
  return {
    state,
    status: 'needs_fix',
    issues,
    nextState,
    retryable: true,
  };
}

export function createFailedResult<T>(
  state: OrchestrationState,
  issues: OrchestrationIssue[],
  nextState?: OrchestrationState
): StageResult<T> {
  return {
    state,
    status: 'failed',
    issues,
    nextState,
    retryable: false,
  };
}

export function createSuccessResult<T>(
  state: OrchestrationState,
  output: T,
  nextState?: OrchestrationState,
  issues: OrchestrationIssue[] = []
): StageResult<T> {
  return {
    state,
    status: 'success',
    output,
    issues,
    nextState,
    retryable: true,
  };
}
