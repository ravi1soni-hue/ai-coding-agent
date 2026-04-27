import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { config } from '../config/env';
import { connectRedis } from '../cache/redis';
import { connectPostgres } from '../db/postgres';

const fastify = Fastify({ logger: true });

// Serve static frontend
fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../../frontend'),
  prefix: '/',
  index: ['index.html'],
});

fastify.get('/health', async () => {
  return { status: 'ok', env: config.NODE_ENV };
});

export async function startServer() {
  await connectRedis();
  await connectPostgres();
  const port = config.PORT || 3000;
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info(`Server running on port ${port}`);
}
