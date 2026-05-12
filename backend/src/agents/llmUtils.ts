/**
 * Shared LLM utilities used by every agent.
 *
 * Centralises three concerns that previously had divergent, fragile copies in
 * each agent file:
 *   1. Token budget types + normalisation (ported from codeGenerationAgent).
 *   2. Truncated-JSON repair (bracket/brace balancer).
 *   3. Robust JSON parsing with a 4-attempt recovery chain.
 */

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/** Hard cap so a runaway estimator can never blow past provider limits. */
export const ABSOLUTE_TOKEN_CEILING = 32_000;

export type TokenBudget = { initial: number; ceiling: number };

/**
 * Clamps both `initial` and `ceiling` to [512, ABSOLUTE_TOKEN_CEILING].
 * Passing a plain number sets initial === ceiling (no adaptive headroom).
 */
export function normalizeBudget(budget: number | TokenBudget): TokenBudget {
  if (typeof budget === 'number') {
    const clamped = Math.max(512, Math.min(ABSOLUTE_TOKEN_CEILING, Math.round(budget)));
    return { initial: clamped, ceiling: clamped };
  }
  const initial = Math.max(512, Math.min(ABSOLUTE_TOKEN_CEILING, Math.round(budget.initial)));
  const ceiling = Math.max(initial, Math.min(ABSOLUTE_TOKEN_CEILING, Math.round(budget.ceiling)));
  return { initial, ceiling };
}

/**
 * Compute a token budget that scales linearly with `pageCount` (or any
 * analogous complexity unit).
 *
 * @param pageCount   Number of pages / components / sections.
 * @param perPage     Tokens to add per unit of complexity.
 * @param minTokens   Lower bound (initial and ceiling).
 * @param maxTokens   Upper bound (ceiling; initial = min(pageCount*perPage, maxTokens)).
 *
 * Returns a `TokenBudget` with adaptive headroom so callers can retry with
 * more tokens on truncation without a separate formula.
 */
export function scaledTokenBudget(
  pageCount: number,
  perPage: number,
  minTokens: number,
  maxTokens: number,
): TokenBudget {
  const estimated = Math.max(minTokens, pageCount * perPage);
  return normalizeBudget({
    initial: Math.min(maxTokens, estimated),
    ceiling: Math.min(ABSOLUTE_TOKEN_CEILING, maxTokens),
  });
}

// ---------------------------------------------------------------------------
// JSON repair
// ---------------------------------------------------------------------------

/**
 * Attempt to close a truncated JSON string by counting unclosed brackets /
 * braces.  Handles the common case where an LLM output is cut at the token
 * limit in the middle of an array or object.
 *
 * Returns the original string unchanged if it is already balanced.
 */
export function repairTruncatedJson(raw: string): string {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' && stack[stack.length - 1] === '{') { stack.pop(); continue; }
    if (ch === ']' && stack[stack.length - 1] === '[') { stack.pop(); continue; }
  }

  if (stack.length === 0) return raw;

  // Strip any trailing incomplete token (dangling comma, colon, or partial string).
  let trimmed = raw.trimEnd().replace(/[,:\s]+$/, '');
  if (inString) trimmed += '"';

  const closers = stack.reverse().map(ch => (ch === '{' ? '}' : ']'));
  return trimmed + closers.join('');
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Strip markdown code fences that LLMs often wrap JSON in.
 */
export function stripMarkdownFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

/**
 * Parse JSON from an LLM response using a 4-attempt recovery chain:
 *   1. Parse the cleaned string as-is.
 *   2. Extract the outermost `[…]` or `{…}` block and parse that.
 *   3. Repair truncation on the extracted block and parse.
 *   4. Repair truncation on the full cleaned string and parse.
 *
 * Throws `Error` with a descriptive message + snippet only after all four
 * attempts fail.
 */
export function parseJsonResponse(content: string): any {
  const cleaned = stripMarkdownFences(content);
  let lastError: unknown;

  // Attempt 1: parse as-is
  try { return JSON.parse(cleaned); } catch (e) { lastError = e; }

  // Attempt 2 + 3: extract outermost structure, then repair it
  const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch (e) { lastError = e; }
    try { return JSON.parse(repairTruncatedJson(jsonMatch[1])); } catch (e) { lastError = e; }
  }

  // Attempt 4: repair the full cleaned string
  try { return JSON.parse(repairTruncatedJson(cleaned)); } catch (e) { lastError = e; }

  const parseMsg = lastError instanceof SyntaxError ? ` Parse error: ${(lastError as SyntaxError).message}.` : '';
  throw new Error(
    `No valid JSON found.${parseMsg} Snippet: ${content.replace(/\s+/g, ' ').slice(0, 200)}`,
  );
}
