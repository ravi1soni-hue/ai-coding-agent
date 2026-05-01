import { deploymentAgent } from '../../agents/deploymentAgent';
import { debug, error } from '../../utils/logger';

export interface DeploymentInput {
  projectId: string;
  revisionId: string;
  buildDir: string;
  backendDir?: string;
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
  try {
    if (!input.buildDir) throw new Error('buildDir required for deployment');
    if (!input.revisionId) throw new Error('revisionId required for deployment');

    const result = await deploymentAgent({
      projectId: input.projectId,
      revisionId: input.revisionId,
      buildDir: input.buildDir,
      backendDir: input.backendDir,
      frontendProjectName: input.frontendProjectName,
      backendService: input.backendService,
      hasBackend: input.hasBackend,
    });
    debug('handleDeployment:done', { projectId: input.projectId, url: result.frontend_url });
    return { success: true, data: result };
  } catch (err) {
    error('handleDeployment', err);
    return {
      success: false,
      error: toMessage(err, 'Deployment failed'),
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
