// Simple in-memory job queue
type Job = { id: string; payload: any };

export class JobQueue {
  private queue: Job[] = [];
  private processing = false;

  async addJob(payload: any) {
    const job: Job = { id: Date.now().toString(), payload };
    this.queue.push(job);
    this.processJobs();
  }

  async processJobs() {
    if (this.processing) return;
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
