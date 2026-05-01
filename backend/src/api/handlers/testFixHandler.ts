import { testFixAgent } from '../../agents/testFixAgent';
import { debug, error, warn } from '../../utils/logger';

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
  try {
    const result = await testFixAgent({
      buildFn: input.buildFn,
      fixFn: input.fixFn,
      files: input.files,
      workspaceDir: input.workspaceDir,
    });
    debug('handleTestFix:done', { projectId: input.projectId, success: result.success });
    return { success: true, data: result };
  } catch (err) {
    error('handleTestFix', err);
    // Return a partial result so the pipeline can decide whether to continue
    // to deployment with whatever build output exists, rather than hard-failing.
    return {
      success: false,
      error: toMessage(err, 'Test/fix failed'),
      fallback: { success: false, logs: '', fixed: false },
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
