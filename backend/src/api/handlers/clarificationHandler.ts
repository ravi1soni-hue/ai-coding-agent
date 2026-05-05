import { clarificationAgent } from '../../agents/clarificationAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface ClarificationInput {
  requirements: any;
  projectSpec?: any;
  clarificationAnswers: Record<string, string>;
  askedQuestions: string[];
  modification?: string;
  lastQuestion?: string;
  lastAnswer?: string;
  projectId: string;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

const TIMEOUT_MS = 30_000;

export async function handleClarification(
  input: ClarificationInput
): Promise<HandlerResult> {
  debug('handleClarification', { projectId: input.projectId });
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        clarificationAgent({
          requirements: input.requirements,
          projectSpec: input.projectSpec,
          clarificationAnswers: input.clarificationAnswers,
          askedQuestions: input.askedQuestions,
          modification: input.modification,
          lastQuestion: input.lastQuestion,
          lastAnswer: input.lastAnswer,
        }),
        TIMEOUT_MS,
        'Clarification'
      );
      debug('handleClarification:done', { projectId: input.projectId });
      return { success: true, data: result.output, fallback: result.updatedState };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        debug('handleClarification:retry', { projectId: input.projectId, attempt, error: String((err as any)?.message || err) });
        continue;
      }
      error('handleClarification', err);
      return {
        success: false,
        error: `Clarification failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Clarification failed')}. Next step: review the prompt or clarification answers and retry.`,
      };
    }
  }
  return {
    success: false,
    error: 'Clarification failed after repeated attempts. Please retry.',
  };
}

function toMessage(err: unknown, fallback: string): string {
  const raw = String((err as any)?.message || '').trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280) return fallback;
  return sanitized;
}
