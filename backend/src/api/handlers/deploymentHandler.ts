import { deploymentAgent } from '../../agents/deploymentAgent';
import { debug, error } from '../../utils/logger';

export interface DeploymentInput {
  projectId: string;
  revisionId: string;
  buildDir: string;
  backendDir?: string;
  workspaceRoot?: string;
  frontendProjectName?: string;
  backendService?: string;
  hasBackend?: boolean;
}

export interface HandlerResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fallback?: any;
}

/**
 * Deployment is intentionally not wrapped in a hard timeout — Vercel/Railway
 * uploads can take several minutes for large projects. The underlying agent
 * already has its own HTTP timeouts per request.
 */
export async function handleDeployment(input: DeploymentInput): Promise<HandlerResult> {
  debug('handleDeployment', { projectId: input.projectId });
  const MAX_ATTEMPTS = 2;
  if (!input.buildDir) {
    return { success: false, error: 'Deployment blocked: buildDir is required for deployment.' };
  }
  if (!input.revisionId) {
    return { success: false, error: 'Deployment blocked: revisionId is required for deployment.' };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await deploymentAgent({
        projectId: input.projectId,
        revisionId: input.revisionId,
        buildDir: input.buildDir,
        backendDir: input.backendDir,
        workspaceRoot: input.workspaceRoot,
        frontendProjectName: input.frontendProjectName,
        backendService: input.backendService,
        hasBackend: input.hasBackend,
      });
      debug('handleDeployment:done', { projectId: input.projectId, url: result.frontend_url });
      return { success: true, data: result, fallback: null };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        debug('handleDeployment:retry', { projectId: input.projectId, attempt, error: String((err as any)?.message || err) });
        continue;
      }
      error('handleDeployment', err);
      return {
        success: false,
        error: `Deployment failed after ${MAX_ATTEMPTS} attempts. ${toMessage(err, 'Deployment failed')}. Next step: verify deployment credentials, provider availability, and retry.`,
      };
    }
  }
  return {
    success: false,
    error: 'Deployment failed after repeated attempts. Please retry.',
  };
}

function toMessage(err: unknown, fallback: string): string {
  const raw = String((err as any)?.message || '').trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/<!doctype|<html|<head|<body/i.test(raw) || sanitized.length > 280) return fallback;
  return sanitized;
}
