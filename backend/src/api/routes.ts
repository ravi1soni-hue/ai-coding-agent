import { FastifyInstance } from 'fastify';
import { JobQueue } from '../jobs/jobQueue';
import { config } from '../config/env';
import {
  authenticateUser,
  buildClearedSessionCookie,
  buildSessionCookie,
  createProjectSession,
  createSession,
  createUser,
  getOrCreateActiveProjectSession,
  getUserFromSessionToken,
  parseCookie,
  revokeSession,
  touchProjectSession,
} from '../auth/authService';
import { getProjectEvents, getLatestProjectCodeRevision, listUserProjects, saveProjectDeployment } from '../db/projectStore';
import { runBuildWorker, cleanupWorkspace } from '../workers/buildWorker';
import { deploymentAgent } from '../agents/deploymentAgent';

const jobQueue = new JobQueue(async (job) => {
  console.log('[jobQueue] processed', job.id, job.payload);
});

export async function registerRoutes(fastify: FastifyInstance) {
  async function requireUser(req: any, reply: any) {
    const cookies = parseCookie(req.headers.cookie);
    if (!cookies.sid) {
      reply.status(401).send({ error: 'Unauthorized' });
      return null;
    }
    const user = await getUserFromSessionToken(cookies.sid);
    if (!user) {
      reply.status(401).send({ error: 'Unauthorized' });
      return null;
    }
    return user;
  }

  fastify.get('/health', async () => ({ status: 'ok' }));

  fastify.post('/api/auth/signup', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; email?: string; password?: string };
    const name = body.name?.trim() ?? '';
    const email = body.email?.trim() ?? '';
    const password = body.password ?? '';

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!name || !emailRegex.test(email) || password.length < 8) {
      return reply.status(400).send({ error: 'Name, valid email, and password (min 8 chars) are required.' });
    }

    try {
      const user = await createUser({ name, email, password });
      const token = await createSession({
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? '',
      });
      const cookie = buildSessionCookie(token, config.NODE_ENV === 'production');
      reply.header('Set-Cookie', cookie);
      return { user };
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (msg.includes('duplicate key') || msg.includes('users_email_key')) {
        return reply.status(409).send({ error: 'Email is already registered.' });
      }
      return reply.status(500).send({ error: 'Failed to create account.' });
    }
  });

  fastify.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = body.email?.trim() ?? '';
    const password = body.password ?? '';

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    const user = await authenticateUser(email, password);
    if (!user) {
      return reply.status(401).send({ error: 'Invalid email or password.' });
    }

    const token = await createSession({
      userId: user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? '',
    });
    const cookie = buildSessionCookie(token, config.NODE_ENV === 'production');
    reply.header('Set-Cookie', cookie);
    return { user };
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const cookies = parseCookie(req.headers.cookie);
    if (cookies.sid) {
      await revokeSession(cookies.sid);
    }
    reply.header('Set-Cookie', buildClearedSessionCookie(config.NODE_ENV === 'production'));
    return { ok: true };
  });

  fastify.get('/api/auth/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    return { user };
  });

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

  fastify.post('/api/projects/:projectId/redeploy', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const params = req.params as { projectId: string };
    const projectId = params.projectId;
    const projects = await listUserProjects(user.id);
    const projectExists = projects.some((project) => project.id === projectId);

    if (!projectExists) {
      return reply.status(404).send({ error: 'Project not found.' });
    }

    const revision = await getLatestProjectCodeRevision({ projectId, userId: user.id });
    if (!revision) {
      return reply.status(404).send({ error: 'No saved code revision found for this project.' });
    }

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
        projectId,
        userId: user.id,
        frontendUrl: deployment.frontend_url,
        backendUrl: deployment.backend_url,
        vercelDeploymentId: deployment.vercel_deployment_id,
        vercelInspectUrl: deployment.vercel_inspect_url,
        vercelStatus: deployment.vercel_status,
        vercelLogUrl: deployment.vercel_log_url,
        railwayDeploymentId: deployment.railway_deployment_id,
        railwayStatus: deployment.railway_status,
        railwayLogUrl: deployment.railway_log_url,
        railwayDashboardUrl: deployment.railway_dashboard_url,
        codeRevisionId: revision.id,
        sourceArchivePath: revision.source_archive_path,
        sourceHash: revision.source_hash,
        raw: deployment,
      });

      if (revision.workspace_path) {
        void cleanupWorkspace(revision.workspace_path);
      }

      return { deployment };
    } catch (err: any) {
      const message = err?.message || 'Redeploy failed.';
      return reply.status(500).send({ error: message });
    }
  });

  fastify.post('/api/projects/select', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const body = (req.body ?? {}) as { projectId?: string };
    const projectId = (body.projectId ?? '').trim();
    if (!projectId) {
      return reply.status(400).send({ error: 'projectId is required.' });
    }

    const projects = await listUserProjects(user.id);
    const exists = projects.some((p) => p.id === projectId);
    if (!exists) {
      return reply.status(404).send({ error: 'Project not found.' });
    }

    await touchProjectSession(user.id, projectId);
    return { projectId };
  });

  fastify.get('/api/projects/:projectId/events', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const params = req.params as { projectId: string };
    const projectId = params.projectId;
    const projects = await listUserProjects(user.id);
    const exists = projects.some((p) => p.id === projectId);
    if (!exists) {
      return reply.status(404).send({ error: 'Project not found.' });
    }

    const events = await getProjectEvents({ userId: user.id, projectId, limit: 1000 });
    return { events };
  });

  fastify.post('/job', async (req, reply) => {
    const job = req.body;
    await jobQueue.addJob(job);
    return { status: 'job_queued' };
  });
}
