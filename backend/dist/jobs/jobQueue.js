"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobQueue = void 0;
class JobQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }
    async addJob(payload) {
        const job = { id: Date.now().toString(), payload };
        this.queue.push(job);
        this.processJobs();
    }
    async processJobs() {
        if (this.processing)
            return;
        this.processing = true;
        while (this.queue.length > 0) {
            const job = this.queue.shift();
            if (job) {
                // Simulate job processing
                await new Promise((res) => setTimeout(res, 100));
                console.log('Processed job:', job.id, job.payload);
            }
        }
        this.processing = false;
    }
}
exports.JobQueue = JobQueue;
