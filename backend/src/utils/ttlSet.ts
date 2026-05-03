export const PIPELINE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
