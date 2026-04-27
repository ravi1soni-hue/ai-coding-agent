// Example: Proxy frontend requests (for local dev or SSR)
import { FastifyInstance } from 'fastify';
import proxy from '@fastify/http-proxy';

export async function registerFrontendProxy(fastify: FastifyInstance) {
  fastify.register(proxy, {
    upstream: 'http://localhost:3001', // Change to your frontend dev server
    prefix: '/app',
    rewritePrefix: '/app',
  });
}
