import { blueprintAgent } from '../../agents/blueprintAgent';
import { withTimeout } from '../../utils/timeout';
import { debug, error } from '../../utils/logger';

export interface BlueprintInput {
  requirements: any;
  systemDesign?: any;
  uiSpec?: any;
  projectSpec?: any;
  modification?: string;
  projectId?: string;
}

export interface BlueprintHandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

const TIMEOUT_MS = 120_000;

export async function handleBlueprint(input: BlueprintInput): Promise<BlueprintHandlerResult> {
  debug('handleBlueprint', { projectId: input.projectId });
  try {
    const result = await withTimeout(
      blueprintAgent({
        requirements: input.requirements,
        systemDesign: input.systemDesign,
        uiSpec: input.uiSpec,
        projectSpec: input.projectSpec,
        modification: input.modification,
        projectId: input.projectId,
      }),
      TIMEOUT_MS,
      'Blueprint generation'
    );
    debug('handleBlueprint:done', { projectId: input.projectId, title: result.title, fileCount: result.files.length });
    return { success: true, data: result };
  } catch (err) {
    error('handleBlueprint', err);
    const raw = String((err as any)?.message || '').trim();
    return {
      success: false,
      error: raw || 'Blueprint generation failed',
    };
  }
}
