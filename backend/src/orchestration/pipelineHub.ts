import { EventEmitter } from 'events';
import { getRedis } from '../cache/redis';
import { PIPELINE_TTL_MS } from '../utils/ttlSet';
import type { OrchestrationAdapter, OrchestrationEmitEvent } from '../ai/contracts/orchestration';
import type Redis from 'ioredis';

const emitters = new Map<string, EventEmitter>();
const localActive = new Map<string, number>(); // projectId -> expiry ms
const localSubscriberRefCount = new Map<string, number>();

function getEmitter(projectId: string): EventEmitter {
  let em = emitters.get(projectId);
  if (!em) {
    em = new EventEmitter();
    em.setMaxListeners(50);
    emitters.set(projectId, em);
  }
  return em;
}

function activeKey(projectId: string) {
  return `pipeline:active:${projectId}`;
}

function streamKey(projectId: string) {
  return `pipeline:stream:${projectId}`;
}

function cursorKey(projectId: string) {
  return `pipeline:cursor:${projectId}`;
}

function isLocallyActive(projectId: string): boolean {
  const exp = localActive.get(projectId);
  if (!exp) return false;
  if (Date.now() > exp) {
    localActive.delete(projectId);
    return false;
  }
  return true;
}

type XReadMessage = [id: string, fields: string[]];
type XReadStreamEntry = [stream: string, messages: XReadMessage[]];

const streamLoops = new Map<
  string,
  {
    running: boolean;
    subscriber: Redis;
    loopPromise: Promise<void>;
  }
>();

async function startStreamFanout(projectId: string): Promise<void> {
  if (streamLoops.has(projectId)) return;

  const base = getRedis();
  if (!base) return;

  const em = getEmitter(projectId);

  const subscriber = base.duplicate();
  subscriber.on('error', () => {
    // best-effort fanout; don't crash orchestration
  });

  const loopState = { running: true };
  const loopPromise = (async () => {
    try {
      await subscriber.connect();

      // Use persisted cursor so we can resume after restart.
      let cursor = await subscriber.get(cursorKey(projectId));
      if (typeof cursor !== 'string' || !cursor.trim()) cursor = '0-0';

      while (loopState.running) {
        const resUnknown = await subscriber.xread(
          'BLOCK',
          5000,
          'STREAMS',
          streamKey(projectId),
          cursor,
        );

        const res = resUnknown as unknown as XReadStreamEntry[] | null;
        if (!Array.isArray(res) || res.length === 0) continue;

        for (const streamEntry of res) {
          const messages = streamEntry[1];
          if (!Array.isArray(messages) || messages.length === 0) continue;

          for (const msg of messages) {
            const id = msg[0];
            const fieldArr = msg[1] || [];
            if (typeof id !== 'string') continue;

            // fieldArr = [field1, value1, field2, value2, ...]
            let eventJson: string | undefined;

            for (let i = 0; i < fieldArr.length; i += 2) {
              const field = fieldArr[i];
              const value = fieldArr[i + 1];
              if (field === 'event' && typeof value === 'string') {
                eventJson = value;
                break;
              }
            }

            if (typeof eventJson !== 'string') {
              cursor = id;
              await subscriber.set(cursorKey(projectId), cursor, 'PX', PIPELINE_TTL_MS).catch(() => {});
              continue;
            }

            try {
              const parsed = JSON.parse(eventJson) as OrchestrationEmitEvent;
              em.emit('event', parsed);
            } catch {
              // ignore malformed messages
            }

            cursor = id;
            // Persist cursor so another backend instance can resume after restart.
            await subscriber.set(cursorKey(projectId), cursor, 'PX', PIPELINE_TTL_MS).catch(() => {});
          }
        }
      }
    } catch {
      // ignore fanout loop errors
    } finally {
      try {
        await subscriber.quit();
      } catch {
        // ignore
      }
    }
  })();

  streamLoops.set(projectId, { running: true, subscriber, loopPromise });
  void loopPromise;
}

async function stopStreamFanout(projectId: string): Promise<void> {
  const loop = streamLoops.get(projectId);
  if (!loop) return;

  streamLoops.delete(projectId);
  loop.running = false;

  try {
    await loop.subscriber.quit();
  } catch {
    // ignore
  }
}

export const pipelineHub = {
  /** Has someone already started a pipeline for this project? */
  async isActive(projectId: string): Promise<boolean> {
    if (isLocallyActive(projectId)) return true;
    const redis = getRedis();
    if (!redis) return false;
    try {
      const v = await redis.get(activeKey(projectId));
      return v !== null;
    } catch {
      return false;
    }
  },

  /** Mark a pipeline as running; returns false if one is already active. */
  async tryAcquire(projectId: string): Promise<boolean> {
    if (await this.isActive(projectId)) return false;

    localActive.set(projectId, Date.now() + PIPELINE_TTL_MS);

    const redis = getRedis();
    if (redis) {
      try {
        const ok = await redis.set(activeKey(projectId), '1', 'PX', PIPELINE_TTL_MS, 'NX');
        if (ok !== 'OK') {
          localActive.delete(projectId);
          return false;
        }
      } catch {
        // redis error — keep local lock
      }
    }

    return true;
  },

  /**
   * Take the active-pipeline lock unconditionally (used by crash-resume on boot).
   * Single-process deploy assumption.
   */
  async forceAcquire(projectId: string): Promise<void> {
    localActive.set(projectId, Date.now() + PIPELINE_TTL_MS);
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.set(activeKey(projectId), '1', 'PX', PIPELINE_TTL_MS);
    } catch {
      // ignore
    }
  },

  async release(projectId: string): Promise<void> {
    localActive.delete(projectId);
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.del(activeKey(projectId));
    } catch {
      // ignore
    }
  },

  /** Fan an event out to every connected subscriber for this project. */
  publish(projectId: string, event: OrchestrationEmitEvent): void {
    const em = emitters.get(projectId);
    if (em) em.emit('event', event);

    const redis = getRedis();
    if (!redis) return;

    void redis
      .xadd(
        streamKey(projectId),
        'MAXLEN',
        '~',
        5000,
        '*',
        'event',
        JSON.stringify(event),
      )
      .catch(() => {
        // ignore stream failures
      });
  },

  subscribe(projectId: string, listener: (event: OrchestrationEmitEvent) => void): () => void {
    const em = getEmitter(projectId);

    const prevCount = localSubscriberRefCount.get(projectId) || 0;
    em.on('event', listener);
    localSubscriberRefCount.set(projectId, prevCount + 1);

    if (prevCount === 0) {
      void startStreamFanout(projectId).catch(() => {});
    }

    return () => {
      em.off('event', listener);

      const nextCount = (localSubscriberRefCount.get(projectId) || 1) - 1;
      if (nextCount <= 0) {
        localSubscriberRefCount.delete(projectId);
        if (em.listenerCount('event') === 0) emitters.delete(projectId);
        void stopStreamFanout(projectId).catch(() => {});
      } else {
        localSubscriberRefCount.set(projectId, nextCount);
      }
    };
  },
};

export function createHubAdapter(projectId: string): OrchestrationAdapter {
  return {
    emit: (event: OrchestrationEmitEvent) => {
      pipelineHub.publish(projectId, event);
    },
  };
}
