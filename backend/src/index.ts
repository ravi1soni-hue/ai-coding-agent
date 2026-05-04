import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';

import { config } from './config/env';
import { registerRoutes } from './api/routes';
import { createSocketServer } from './api/socket';
import { connectRedis } from './cache/redis';
import { connectPostgres } from './db/postgres';
import { ensureCoreTables } from './db/schema';
import { ensureVectorTable } from './db/vectorStore';

if (!config.OPENAI_API_KEY || config.OPENAI_API_KEY.length < 10) {
  console.warn('[WARNING] OPENAI_API_KEY is missing or too short. Check your .env or Railway environment variables.');
}

async function start() {
  try {
    await connectRedis();
    await connectPostgres();
    await ensureCoreTables();
    await ensureVectorTable();
  } catch (err) {
    console.error('Fatal error initializing infra:', err);
    process.exit(1);
  }

  const fastify = Fastify({
    logger: { level: 'info' },
  });

  fastify.register(fastifyStatic, {
    root: path.join(__dirname, '../../frontend/dist'),
    prefix: '/',
    index: ['index.html'],
  });

  await registerRoutes(fastify);

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info(`Server (HTTP+WebSocket+Static) running on port ${port}`);

  createSocketServer(fastify.server);
}

start().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
