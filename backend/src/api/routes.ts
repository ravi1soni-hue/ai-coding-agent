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
import { getProjectEvents, listUserProjects } from '../db/projectStore';

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

    if (!name || !email || password.length < 8) {
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

  fastify.post('/echo', async (req, reply) => {
    const body = req.body;
    return { echo: body };
  });

  fastify.post('/job', async (req, reply) => {
    const job = req.body;
    await jobQueue.addJob(job);
    return { status: 'job_queued' };
  });
}
