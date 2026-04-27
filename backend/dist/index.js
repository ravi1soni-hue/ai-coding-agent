"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const static_1 = __importDefault(require("@fastify/static"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const routes_1 = require("./api/routes");
const socket_1 = require("./api/socket");
const redis_1 = require("./cache/redis");
const postgres_1 = require("./db/postgres");
const vectorStore_1 = require("./db/vectorStore");
async function start() {
    try {
        // Initialize Redis
        await (0, redis_1.connectRedis)();
        // Initialize Postgres
        await (0, postgres_1.connectPostgres)();
        // Ensure vectors table and pgvector extension
        await (0, vectorStore_1.ensureVectorTable)();
    }
    catch (err) {
        console.error('Fatal error initializing infra:', err);
        process.exit(1);
    }
    const fastify = (0, fastify_1.default)({
        logger: { level: 'info' },
    });
    // Serve static frontend
    fastify.register(static_1.default, {
        root: path_1.default.join(__dirname, '../frontend'),
        prefix: '/',
        index: ['index.html'],
    });
    // Debug endpoint to list frontend files
    fastify.get('/debug-frontend-files', async (request, reply) => {
        const dir = path_1.default.join(__dirname, '../frontend');
        try {
            const files = fs_1.default.readdirSync(dir);
            return reply.send({ files });
        }
        catch (e) {
            return reply.status(500).send({ error: e.message });
        }
    });
    await (0, routes_1.registerRoutes)(fastify);
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    // Listen using Fastify's built-in HTTP server, then attach WebSocket
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server (HTTP+WebSocket+Static) running on port ${port}`);
    // Attach WebSocket server directly to Fastify's HTTP server
    (0, socket_1.createSocketServer)(fastify.server);
}
start().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
});
