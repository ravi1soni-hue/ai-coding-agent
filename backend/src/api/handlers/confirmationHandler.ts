import { confirmationGate } from '../../agents/confirmationGate';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface ConfirmationInput {
  clarifications: any;
  projectId: string;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

const TIMEOUT_MS = 2_000;

export async function handleConfirmation(
  input: ConfirmationInput
): Promise<HandlerResult> {
  debug('handleConfirmation', { projectId: input.projectId });
  try {
    if (!input.clarifications) {
      throw new Error('Clarifications required for confirmation');
    }
    const result = await withTimeout(
      confirmationGate(input.clarifications),
      TIMEOUT_MS,
      'Confirmation'
    );
    debug('handleConfirmation:done', { projectId: input.projectId });
    return { success: true, data: result };
  } catch (err) {
    error('handleConfirmation', err);
    return {
      success: false,
      error: toMessage(err, 'Confirmation failed'),
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
