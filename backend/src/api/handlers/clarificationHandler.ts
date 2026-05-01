import { clarificationAgent } from '../../agents/clarificationAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface ClarificationInput {
  requirements: any;
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

const TIMEOUT_MS = 3_000;

export async function handleClarification(
  input: ClarificationInput
): Promise<HandlerResult> {
  debug('handleClarification', { projectId: input.projectId });
  try {
    const result = await withTimeout(
      clarificationAgent({
        requirements: input.requirements,
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
    return { success: true, data: result };
  } catch (err) {
    error('handleClarification', err);
    // Graceful fallback: treat as confirmed so the pipeline can continue
    return {
      success: false,
      error: toMessage(err, 'Clarification failed'),
      fallback: { question: null, confirmed: true, done: true, context: {} },
    };
  }
}

function toMessage(err: unknown, fallback: string): string {
  const raw = String((err as any)?.message || '').trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280) return fallback;
  return sanitized;
}
