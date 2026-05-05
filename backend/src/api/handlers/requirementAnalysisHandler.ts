import { requirementAnalysisAgent } from '../../agents/requirementAnalysisAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface RequirementAnalysisInput {
  userMessage: string;
  projectId: string;
  userId: string;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

const TIMEOUT_MS = 30_000;

export async function handleRequirementAnalysis(
  input: RequirementAnalysisInput
): Promise<HandlerResult> {
  debug('handleRequirementAnalysis', { projectId: input.projectId });
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        requirementAnalysisAgent({ user_message: input.userMessage }),
        TIMEOUT_MS,
        'Requirement analysis'
      );
      debug('handleRequirementAnalysis:done', { projectId: input.projectId });
      return { success: true, data: result.output, fallback: result.updatedState };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        debug('handleRequirementAnalysis:retry', {
          projectId: input.projectId,
          attempt,
          error: String((err as any)?.message || err),
        });
        continue;
      }
      error('handleRequirementAnalysis', err);
      return {
        success: false,
        error: `Requirement analysis failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Failed to analyze requirements')}. Next step: simplify the request or split it into smaller requirements and retry.`,
        fallback: null,
      };
    }
  }

  return {
    success: false,
    error: 'Requirement analysis failed after repeated attempts. Please retry.',
    fallback: null,
  };
}

function toMessage(err: unknown, fallback: string): string {
  const raw = String((err as any)?.message || '').trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280) return fallback;
  return sanitized;
}
