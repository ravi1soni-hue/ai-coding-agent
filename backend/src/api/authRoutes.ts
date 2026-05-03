import { FastifyInstance } from 'fastify';
import {
  authenticateUser,
  buildClearedSessionCookie,
  buildSessionCookie,
  createSession,
  createUser,
  parseCookie,
  revokeSession,
} from '../auth/authService';
import { config } from '../config/env';
import { requireUser } from './middleware';

export async function registerAuthRoutes(fastify: FastifyInstance) {
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
      const token = await createSession({ userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });
      reply.header('Set-Cookie', buildSessionCookie(token, config.NODE_ENV === 'production'));
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

    const token = await createSession({ userId: user.id, ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });
    reply.header('Set-Cookie', buildSessionCookie(token, config.NODE_ENV === 'production'));
    return { user };
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const cookies = parseCookie(req.headers.cookie);
    if (cookies.sid) await revokeSession(cookies.sid);
    reply.header('Set-Cookie', buildClearedSessionCookie(config.NODE_ENV === 'production'));
    return { ok: true };
  });

  fastify.get('/api/auth/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { user };
  });
}
