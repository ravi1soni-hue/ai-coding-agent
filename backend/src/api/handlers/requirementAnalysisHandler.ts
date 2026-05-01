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

const TIMEOUT_MS = 5_000;

export async function handleRequirementAnalysis(
  input: RequirementAnalysisInput
): Promise<HandlerResult> {
  debug('handleRequirementAnalysis', { projectId: input.projectId });
  try {
    const result = await withTimeout(
      requirementAnalysisAgent({ user_message: input.userMessage }),
      TIMEOUT_MS,
      'Requirement analysis'
    );
    debug('handleRequirementAnalysis:done', { projectId: input.projectId });
    return { success: true, data: result };
  } catch (err) {
    error('handleRequirementAnalysis', err);
    return {
      success: false,
      error: toMessage(err, 'Failed to analyze requirements'),
      fallback: null,
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
