import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';

import { registerRoutes } from './api/routes';
import { createSocketServer } from './api/socket';
import { connectRedis } from './cache/redis';
import { connectPostgres } from './db/postgres';
import { ensureVectorTable } from './db/vectorStore';
import http from 'http';

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

	const fastify = Fastify({ logger: true });

	// Serve static frontend
	fastify.register(fastifyStatic, {
		root: path.join(__dirname, '../../frontend'),
		prefix: '/',
		index: ['index.html'],
	});

	await registerRoutes(fastify);

	// Create HTTP server from Fastify
	const server = http.createServer(fastify.server);
	// Attach WebSocket server
	createSocketServer(server);

	const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
	server.listen(port, '0.0.0.0', () => {
		console.log(`Server (HTTP+WebSocket+Static) running on port ${port}`);
	});
}

start().catch((err) => {
	console.error('Fatal error starting server:', err);
	process.exit(1);
});