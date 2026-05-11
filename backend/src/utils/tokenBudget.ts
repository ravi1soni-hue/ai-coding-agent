export type TokenBudgetState = {
  used: number;
  ceiling: number;
};

const budgets = new Map<string, TokenBudgetState>();

export function getBudget(projectId: string): TokenBudgetState | undefined {
  return budgets.get(projectId);
}

export function initBudget(projectId: string, ceiling: number): TokenBudgetState {
  const safeCeiling = Number.isFinite(ceiling) && ceiling > 0 ? Math.floor(ceiling) : 0;
  const next: TokenBudgetState = { used: 0, ceiling: safeCeiling };
  budgets.set(projectId, next);
  return next;
}

/**
 * Records token usage estimate for a project.
 * Returns `true` if the budget is exceeded.
 */
export function recordBudgetUsage(projectId: string, tokens: number): boolean {
  const state = budgets.get(projectId);
  if (!state) {
    // If not initialized, treat as no budget control.
    return false;
  }
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  state.used += safeTokens;
  return state.used > state.ceiling;
}

/**
 * Throws an Error with exact message `"Budget Exceeded"` so orchestration
 * can transition to FAILED deterministically.
 */
export function enforceBudgetOrThrow(projectId: string, tokens: number): void {
  if (recordBudgetUsage(projectId, tokens)) {
    throw new Error('Budget Exceeded');
  }
}
