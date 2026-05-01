import { systemDesignAgent } from '../../agents/systemDesignAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface SystemDesignInput {
  requirements: any;
  projectId: string;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

const TIMEOUT_MS = 10_000;

export async function handleSystemDesign(
  input: SystemDesignInput
): Promise<HandlerResult> {
  debug('handleSystemDesign', { projectId: input.projectId });
  try {
    const result = await withTimeout(
      systemDesignAgent(input.requirements),
      TIMEOUT_MS,
      'System design'
    );
    debug('handleSystemDesign:done', { projectId: input.projectId });
    return { success: true, data: result };
  } catch (err) {
    error('handleSystemDesign', err);
    return {
      success: false,
      error: toMessage(err, 'System design failed'),
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
