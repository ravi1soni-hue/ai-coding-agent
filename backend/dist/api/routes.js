"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const jobQueue_1 = require("../jobs/jobQueue");
const jobQueue = new jobQueue_1.JobQueue();
async function registerRoutes(fastify) {
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
