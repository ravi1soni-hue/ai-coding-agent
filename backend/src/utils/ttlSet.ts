const FALLBACK_PIPELINE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const rawPipelineTtlMs = process.env.PIPELINE_TTL_MS;

export const PIPELINE_TTL_MS =
  rawPipelineTtlMs && rawPipelineTtlMs.trim().length > 0
    ? (() => {
        const parsed = Number.parseInt(rawPipelineTtlMs, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_PIPELINE_TTL_MS;
      })()
    : FALLBACK_PIPELINE_TTL_MS;

export class TTLSet {
  private entries = new Map<string, number>();

  has(key: string): boolean {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) { this.entries.delete(key); return false; }
    return true;
  }

  add(key: string): void { this.entries.set(key, Date.now() + PIPELINE_TTL_MS); }

  delete(key: string): void { this.entries.delete(key); }
}
