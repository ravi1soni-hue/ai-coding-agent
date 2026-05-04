import { codeGenerationAgent } from '../../agents/codeGenerationAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface CodeGenerationInput {
  systemDesign: any;
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

const TIMEOUT_MS = 300_000;

export async function handleCodeGeneration(
  input: CodeGenerationInput
): Promise<HandlerResult> {
  debug('handleCodeGeneration', { projectId: input.projectId });
  try {
    const result = await withTimeout(
      codeGenerationAgent({
        systemDesign: input.systemDesign,
        requirements: input.requirements,
        blueprint: input.blueprint,
        modification: input.modification,
        context: input.context,
        projectId: input.projectId,
        userId: input.userId,
        user_id: input.userId,
        emitEvent: input.emitEvent,
      }),
      TIMEOUT_MS,
      'Code generation'
    );
    debug('handleCodeGeneration:done', { projectId: input.projectId });
    return { success: true, data: result };
  } catch (err) {
    error('handleCodeGeneration', err);
    return {
      success: false,
      error: toMessage(err, 'Code generation failed'),
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
