/**
 * Races a promise against a timeout. Rejects with a descriptive error if the
 * timeout fires first, so callers can distinguish a timeout from other errors.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ),
  ]);
}
