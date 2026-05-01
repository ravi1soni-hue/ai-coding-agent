"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobQueue = void 0;
class JobQueue {
    constructor(processor) {
        this.queue = [];
        this.processing = false;
        this.processor = processor;
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
        try {
            while (this.queue.length > 0) {
                const job = this.queue.shift();
                if (job) {
                    if (!this.processor) {
                        throw new Error('JobQueue processor is not configured. Cannot process queued jobs.');
                    }
                    await this.processor(job);
                }
            }
        }
        finally {
            this.processing = false;
        }
    }
}
exports.JobQueue = JobQueue;
