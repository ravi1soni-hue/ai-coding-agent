"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const static_1 = __importDefault(require("@fastify/static"));
const path_1 = __importDefault(require("path"));
const routes_1 = require("./api/routes");
const socket_1 = require("./api/socket");
const http_1 = __importDefault(require("http"));
async function start() {
    const fastify = (0, fastify_1.default)({ logger: true });
    // Serve static frontend
    fastify.register(static_1.default, {
        root: path_1.default.join(__dirname, '../../frontend'),
        prefix: '/',
        index: ['index.html'],
    });
    await (0, routes_1.registerRoutes)(fastify);
    // Create HTTP server from Fastify
    const server = http_1.default.createServer(fastify.server);
    // Attach WebSocket server
    (0, socket_1.createSocketServer)(server);
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    server.listen(port, '0.0.0.0', () => {
        console.log(`Server (HTTP+WebSocket+Static) running on port ${port}`);
    });
}
start().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
});
