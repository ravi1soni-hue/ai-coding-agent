import { codeGenerationAgent } from '../../agents/codeGenerationAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error, warn } from '../../utils/logger';

export interface CodeGenerationInput {
  systemDesign: any;
  projectSpec?: any;
  requirements: any;
  blueprint?: any;
  uiSpec?: any;
  modification?: string;
  context?: any;
  projectId: string;
  userId: string;
  emitEvent?: (event: { type: string; message?: string; token?: string; filePath?: string; payload?: any }) => void;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

const TIMEOUT_MS = 600_000;
// Keep to 2: targeted failures are repaired inside codeGenerationAgent itself.
// This outer retry only covers true unexpected crashes (network blip, OOM, etc.).
const MAX_ATTEMPTS = 2;

export async function handleCodeGeneration(
  input: CodeGenerationInput
): Promise<HandlerResult> {
  debug('handleCodeGeneration', { projectId: input.projectId });

  let lastError = 'Code generation failed';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Suppress UI events on retries to avoid the frontend seeing duplicate
      // PLANNING_COMPLETE / FILE_WRITTEN sequences when the first attempt fails.
      const emitEvent = attempt === 1 ? input.emitEvent : undefined;
      const result = await withTimeout(
          codeGenerationAgent({
          systemDesign: input.systemDesign,
          projectSpec: input.projectSpec,
          requirements: input.requirements,
          blueprint: input.blueprint,
          uiSpec: input.uiSpec,
          modification: input.modification,
          context: input.context,
          projectId: input.projectId,
          userId: input.userId,
          user_id: input.userId,
          emitEvent,
        }),
        TIMEOUT_MS,
        'Code generation'
      );
      debug('handleCodeGeneration:done', { projectId: input.projectId, attempt });
      return { success: true, data: result };
    } catch (err) {
      lastError = toMessage(err, 'Code generation failed');
      if (attempt < MAX_ATTEMPTS) {
        warn('handleCodeGeneration:retry', { projectId: input.projectId, attempt, error: lastError });
        await new Promise(r => setTimeout(r, 1500 * attempt));
        continue;
      }
      error('handleCodeGeneration', err);
    }
  }

  return {
    success: false,
    error: lastError,
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
