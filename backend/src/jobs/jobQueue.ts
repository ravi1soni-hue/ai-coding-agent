// Simple in-memory job queue
type Job = { id: string; payload: any };

export class JobQueue {
  private queue: Job[] = [];
  private processing = false;
  private processor?: (job: Job) => Promise<void>;

  constructor(processor?: (job: Job) => Promise<void>) {
    this.processor = processor;
  }

  async addJob(payload: any) {
    const job: Job = { id: Date.now().toString(), payload };
    this.queue.push(job);
    this.processJobs();
  }

  async processJobs() {
    if (this.processing) return;
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
    } finally {
      this.processing = false;
    }
  }
}
