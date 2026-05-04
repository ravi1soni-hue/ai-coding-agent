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

function estimateBlueprintTimeoutMs(input: BlueprintInput): number {
  const payloadSize = JSON.stringify({
    requirements: input.requirements,
    systemDesign: input.systemDesign,
    uiSpec: input.uiSpec,
    projectSpec: input.projectSpec,
    modification: input.modification,
  }).length;

  const estimateFromSize = Math.ceil(payloadSize / 8) * 18;
  const estimateFromScope = Array.isArray(input.uiSpec?.components) ? input.uiSpec.components.length * 12_000 : 0;
  return Math.min(420_000, Math.max(45_000, estimateFromSize + estimateFromScope));
}

export async function handleBlueprint(input: BlueprintInput): Promise<BlueprintHandlerResult> {
  debug('handleBlueprint', { projectId: input.projectId });
  try {
    const timeoutMs = estimateBlueprintTimeoutMs(input);
    const result = await withTimeout(
      blueprintAgent({
        requirements: input.requirements,
        systemDesign: input.systemDesign,
        uiSpec: input.uiSpec,
        projectSpec: input.projectSpec,
        modification: input.modification,
        projectId: input.projectId,
      }),
      timeoutMs,
      'Blueprint generation'
    );
    debug('handleBlueprint:done', { projectId: input.projectId, title: result.title, fileCount: (result.files || []).length });
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
