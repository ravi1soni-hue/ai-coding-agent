import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';

import { registerRoutes } from './api/routes';
import { createSocketServer } from './api/socket';
import { connectRedis } from './cache/redis';
import { connectPostgres } from './db/postgres';
import { ensureVectorTable } from './db/vectorStore';

async function start() {
        try {
                // Initialize Redis
                await connectRedis();
                // Initialize Postgres
                await connectPostgres();
                // Ensure vectors table and pgvector extension
                await ensureVectorTable();
        } catch (err) {
                console.error('Fatal error initializing infra:', err);
                process.exit(1);
        }

        const fastify = Fastify({
                logger: { level: 'info' },
        });

        // Serve static frontend
        fastify.register(fastifyStatic, {
                root: path.join(__dirname, '../frontend'),
                prefix: '/',
                index: ['index.html'],
        });

        // Debug endpoint to list frontend files
        fastify.get('/debug-frontend-files', async (request, reply) => {
                const dir = path.join(__dirname, '../frontend');
                try {
                        const files = fs.readdirSync(dir);
                        return reply.send({ files });
                } catch (e: any) {
                        return reply.status(500).send({ error: e.message });
                }
        });

        await registerRoutes(fastify);

        const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

        // Listen using Fastify's built-in HTTP server, then attach WebSocket
        await fastify.listen({ port, host: '0.0.0.0' });
        fastify.log.info(`Server (HTTP+WebSocket+Static) running on port ${port}`);

        // Attach WebSocket server directly to Fastify's HTTP server
        createSocketServer(fastify.server);
}

start().catch((err) => {
        console.error('Fatal error starting server:', err);
        process.exit(1);
});
