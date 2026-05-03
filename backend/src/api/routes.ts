import { FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './authRoutes';
import { registerProjectRoutes } from './projectRoutes';

export async function registerRoutes(fastify: FastifyInstance) {
  await registerAuthRoutes(fastify);
  await registerProjectRoutes(fastify);
}
