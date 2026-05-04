import { uiSpecAgent } from '../../agents/uiSpecAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface UISpecInput {
  systemDesign: any;
  requirements: any;
  projectSpec?: any;
  modification?: string;
  projectId: string;
  userId: string;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

const TIMEOUT_MS = 180_000; // 3 minutes

export async function handleUISpec(input: UISpecInput): Promise<HandlerResult> {
  debug('handleUISpec', { projectId: input.projectId });
  try {
    const result = await withTimeout(
      uiSpecAgent({
        systemDesign: input.systemDesign,
        requirements: input.requirements,
        projectSpec: input.projectSpec,
        modification: input.modification,
        projectId: input.projectId,
        userId: input.userId,
      }),
      TIMEOUT_MS,
      'UI spec generation'
    );
    debug('handleUISpec:done', { projectId: input.projectId });
    return { success: true, data: result };
  } catch (err) {
    error('handleUISpec', err);
    const message = err instanceof Error ? err.message : 'UI spec generation failed';
    return {
      success: false,
      error: message.length > 280 ? 'UI spec generation failed' : message,
    };
  }
}
