import { FastifyInstance } from 'fastify';
import { JobQueue } from '../jobs/jobQueue';
import {
  createProjectSession,
  getOrCreateActiveProjectSession,
  touchProjectSession,
} from '../auth/authService';
import { getProjectEvents, getLatestProjectCodeRevision, listUserProjects, saveProjectDeployment } from '../db/projectStore';
import { runBuildWorker, cleanupWorkspace } from '../workers/buildWorker';
import { deploymentAgent } from '../agents/deploymentAgent';
import { getCacheJson, setCacheJson } from '../cache/redis';
import { requireUser } from './middleware';

const jobQueue = new JobQueue(async (job) => {
  console.log('[jobQueue] processed', job.id, job.payload);
});

function deploymentStatusKey(sessionId: string) {
  return `session:${sessionId}:status`;
}

export async function registerProjectRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ status: 'ok' }));

  fastify.get('/api/projects/current', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const projectId = await getOrCreateActiveProjectSession(user.id);
    return { projectId };
  });

  fastify.post('/api/projects/new', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const projectId = await createProjectSession(user.id);
    return { projectId };
  });

  fastify.get('/api/projects/history', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const projects = await listUserProjects(user.id);
    return { projects };
  });

  fastify.post('/api/projects/select', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { projectId?: string };
    const projectId = (body.projectId ?? '').trim();
    if (!projectId) return reply.status(400).send({ error: 'projectId is required.' });
    const projects = await listUserProjects(user.id);
    if (!projects.some((p) => p.id === projectId)) return reply.status(404).send({ error: 'Project not found.' });
    await touchProjectSession(user.id, projectId);
    return { projectId };
  });

  fastify.get('/api/projects/:projectId/events', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const params = req.params as { projectId: string };
    const projectId = params.projectId;
    const projects = await listUserProjects(user.id);
    if (!projects.some((p) => p.id === projectId)) return reply.status(404).send({ error: 'Project not found.' });
    const events = await getProjectEvents({ userId: user.id, projectId, limit: 1000 });
    return { events };
  });

  fastify.post('/api/projects/:projectId/redeploy', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const params = req.params as { projectId: string };
    const projectId = params.projectId;
    const projects = await listUserProjects(user.id);
    if (!projects.some((project) => project.id === projectId)) return reply.status(404).send({ error: 'Project not found.' });

    const revision = await getLatestProjectCodeRevision({ projectId, userId: user.id });
    if (!revision) return reply.status(404).send({ error: 'No saved code revision found for this project.' });

    try {
      const buildResult = await runBuildWorker({ workspaceDir: revision.workspace_path });
      if (!buildResult.success || !buildResult.buildDir) {
        return reply.status(500).send({ error: 'Build failed during redeploy.', logs: buildResult.logs });
      }
      const deployment = await deploymentAgent({
        projectId,
        revisionId: revision.id,
        buildDir: buildResult.buildDir,
        backendDir: buildResult.backendDir,
        frontendProjectName: `proj-${projectId.slice(0, 10)}`,
        backendService: `backend-${projectId.slice(0, 10)}`,
        hasBackend: Boolean(buildResult.backendDir),
      });
      await saveProjectDeployment({
        projectId, userId: user.id,
        frontendUrl: deployment.frontend_url, backendUrl: deployment.backend_url,
        vercelDeploymentId: deployment.vercel_deployment_id, vercelInspectUrl: deployment.vercel_inspect_url,
        vercelStatus: deployment.vercel_status, vercelLogUrl: deployment.vercel_log_url,
        railwayDeploymentId: deployment.railway_deployment_id, railwayStatus: deployment.railway_status,
        railwayLogUrl: deployment.railway_log_url, railwayDashboardUrl: deployment.railway_dashboard_url,
        codeRevisionId: revision.id, sourceArchivePath: revision.source_archive_path,
        sourceHash: revision.source_hash, raw: deployment,
      });
      if (revision.workspace_path) void cleanupWorkspace(revision.workspace_path);
      return { deployment };
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || 'Redeploy failed.' });
    }
  });

  // Legacy job queue endpoints
  fastify.post('/job', async (req) => {
    await jobQueue.addJob(req.body);
    return { status: 'job_queued' };
  });

  fastify.post('/confirm-project', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as { sessionId?: string; projectId?: string };
    const sessionId = (body.sessionId || body.projectId || '').trim();
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required.' });

    await setCacheJson(deploymentStatusKey(sessionId), { sessionId, status: 'queued', stage: 'queued', updatedAt: new Date().toISOString() }, 60 * 60 * 24);

    await jobQueue.addJob({
      type: 'confirm-project',
      userId: user.id,
      sessionId,
      run: async () => {
        await setCacheJson(deploymentStatusKey(sessionId), { sessionId, status: 'running', stage: 'build', updatedAt: new Date().toISOString() }, 60 * 60 * 24);
        const revision = await getLatestProjectCodeRevision({ projectId: sessionId, userId: user.id });
        if (!revision) {
          await setCacheJson(deploymentStatusKey(sessionId), { sessionId, status: 'failed', stage: 'build', error: 'No saved code revision found for this project.', updatedAt: new Date().toISOString() }, 60 * 60 * 24);
          return;
        }
        const buildResult = await runBuildWorker({ workspaceDir: revision.workspace_path });
        if (!buildResult.success || !buildResult.buildDir) {
          await setCacheJson(deploymentStatusKey(sessionId), { sessionId, status: 'failed', stage: 'build', error: 'Build failed during confirm-project.', logs: buildResult.logs, updatedAt: new Date().toISOString() }, 60 * 60 * 24);
          return;
        }
        await setCacheJson(deploymentStatusKey(sessionId), { sessionId, status: 'running', stage: 'deploy', updatedAt: new Date().toISOString() }, 60 * 60 * 24);
        const deployment = await deploymentAgent({
          projectId: sessionId, revisionId: revision.id, buildDir: buildResult.buildDir, backendDir: buildResult.backendDir,
          frontendProjectName: `proj-${sessionId.slice(0, 10)}`, backendService: `backend-${sessionId.slice(0, 10)}`, hasBackend: Boolean(buildResult.backendDir),
        });
        await saveProjectDeployment({
          projectId: sessionId, userId: user.id,
          frontendUrl: deployment.frontend_url, backendUrl: deployment.backend_url,
          vercelDeploymentId: deployment.vercel_deployment_id, vercelInspectUrl: deployment.vercel_inspect_url,
          vercelStatus: deployment.vercel_status, vercelLogUrl: deployment.vercel_log_url,
          railwayDeploymentId: deployment.railway_deployment_id, railwayStatus: deployment.railway_status,
          railwayLogUrl: deployment.railway_log_url, railwayDashboardUrl: deployment.railway_dashboard_url,
          codeRevisionId: revision.id, sourceArchivePath: revision.source_archive_path,
          sourceHash: revision.source_hash, raw: deployment,
        });
        await setCacheJson(deploymentStatusKey(sessionId), { sessionId, status: 'completed', stage: 'done', deployment, updatedAt: new Date().toISOString() }, 60 * 60 * 24);
      },
    });

    void jobQueue.processJobs().catch(async (err) => {
      await setCacheJson(deploymentStatusKey(sessionId), {
        sessionId, status: 'failed', stage: 'error',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      }, 60 * 60 * 24);
    });

    return { sessionId, status: 'queued' };
  });

  fastify.get('/deployment-status/:sessionId', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const params = req.params as { sessionId: string };
    const sessionId = (params.sessionId || '').trim();
    if (!sessionId) return reply.status(400).send({ error: 'sessionId is required.' });
    const projects = await listUserProjects(user.id);
    if (!projects.some((p) => p.id === sessionId)) return reply.status(404).send({ error: 'Project not found.' });
    const status = await getCacheJson<Record<string, unknown>>(deploymentStatusKey(sessionId));
    return { sessionId, status: status || { status: 'unknown', stage: 'unknown' } };
  });
}
