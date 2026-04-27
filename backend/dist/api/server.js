"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const fastify_1 = __importDefault(require("fastify"));
const static_1 = __importDefault(require("@fastify/static"));
const path_1 = __importDefault(require("path"));
const env_1 = require("../config/env");
const redis_1 = require("../cache/redis");
const postgres_1 = require("../db/postgres");
const fastify = (0, fastify_1.default)({ logger: true });
// Serve static frontend
fastify.register(static_1.default, {
    root: path_1.default.join(__dirname, '../../frontend'),
    prefix: '/',
    index: ['index.html'],
});
fastify.get('/health', async () => {
    return { status: 'ok', env: env_1.config.NODE_ENV };
});
async function startServer() {
    await (0, redis_1.connectRedis)();
    await (0, postgres_1.connectPostgres)();
    const port = env_1.config.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server running on port ${port}`);
}
