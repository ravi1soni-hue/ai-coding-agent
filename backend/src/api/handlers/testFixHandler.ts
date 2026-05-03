import { testFixAgent } from '../../agents/testFixAgent';
import { debug, error } from '../../utils/logger';

export interface TestFixInput {
  buildFn: () => Promise<{ success: boolean; logs: string }>;
  fixFn?: (logs: string) => Promise<void>;
  files?: Array<{ path: string; content: string }>;
  workspaceDir?: string;
  projectId: string;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

/**
 * testFix is intentionally not wrapped in a hard timeout because the build
 * worker itself can take several minutes. The agent already retries up to 3
 * times internally. Callers that need a ceiling should wrap the returned
 * promise themselves.
 */
export async function handleTestFix(input: TestFixInput): Promise<HandlerResult> {
  debug('handleTestFix', { projectId: input.projectId });
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await testFixAgent({
        buildFn: input.buildFn,
        fixFn: input.fixFn,
        files: input.files,
        workspaceDir: input.workspaceDir,
        projectId: input.projectId,
      });
      debug('handleTestFix:done', { projectId: input.projectId, success: result.success });
      return { success: true, data: result };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        debug('handleTestFix:retry', { projectId: input.projectId, attempt, error: String((err as any)?.message || err) });
        continue;
      }
      error('handleTestFix', err);
      return {
        success: false,
        error: `Test/fix failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Test/fix failed')}. Next step: inspect the build logs, correct any dependency or compilation issues, and retry.`,
      };
    }
  }
  return {
    success: false,
    error: 'Test/fix failed after repeated attempts. Please retry.',
  };
}

function toMessage(err: unknown, fallback: string): string {
  const raw = String((err as any)?.message || '').trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280) return fallback;
  return sanitized;
}
