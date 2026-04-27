import { FastifyInstance } from 'fastify';
import { JobQueue } from '../jobs/jobQueue';

const jobQueue = new JobQueue();

export async function registerRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => ({ status: 'ok' }));

  fastify.post('/echo', async (req, reply) => {
    const body = req.body;
    return { echo: body };
  });

  fastify.post('/job', async (req, reply) => {
    const job = req.body;
    await jobQueue.addJob(job);
    return { status: 'job_queued' };
  });
}
