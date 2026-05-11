import { EventEmitter } from 'events';
import { getRedis } from '../cache/redis';
import { PIPELINE_TTL_MS } from '../utils/ttlSet';
import type {
  OrchestrationAdapter,
  OrchestrationEmitEvent,
} from '../ai/contracts/orchestration';

// Per-project pub/sub channel + active-pipeline registry.
//
// The original socket handler streamed events directly to the originating WS
// and tracked active pipelines in a local TTLSet. That meant a dropped client
// could not re-attach: a reconnecting WS would either (a) start a duplicate
// pipeline, or (b) be told "pipeline already running" and see no live updates
// because the in-process events flew past while no listener was attached.
//
// The hub fixes both problems:
//   - Orchestration publishes events to a per-projectId EventEmitter channel.
//   - Any number of WS connections can subscribe to the same channel and will
//     receive the live event stream (combined with the existing /events
//     replay endpoint on the client, this means reconnects see no gap).
//   - The "is a pipeline running?" flag is held in-process AND mirrored to
//     Redis (when configured) with the same TTL the legacy TTLSet used, so
//     even cross-process socket workers won't double-start a pipeline.

const emitters = new Map<string, EventEmitter>();
const localActive = new Map<string, number>(); // projectId -> expiry ms

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

function isLocallyActive(projectId: string): boolean {
  const exp = localActive.get(projectId);
  if (!exp) return false;
  if (Date.now() > exp) {
    localActive.delete(projectId);
    return false;
  }
  return true;
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
        // NX: only set if not exists; PX: ttl in ms
        const ok = await redis.set(activeKey(projectId), '1', 'PX', PIPELINE_TTL_MS, 'NX');
        if (ok !== 'OK') {
          localActive.delete(projectId);
          return false;
        }
      } catch {
        // redis error — keep local lock, we still serialize within process
      }
    }
    return true;
  },

  /**
   * Take the active-pipeline lock unconditionally (used by crash-resume on
   * boot, when a previous process may have left the Redis flag set with a
   * long TTL but is no longer alive). Single-process deploys only — if you
   * scale this horizontally, fence with a host/instance id before adopting.
   */
  async forceAcquire(projectId: string): Promise<void> {
    localActive.set(projectId, Date.now() + PIPELINE_TTL_MS);
    const redis = getRedis();
    if (redis) {
      try { await redis.set(activeKey(projectId), '1', 'PX', PIPELINE_TTL_MS); } catch { /* ignore */ }
    }
  },

  async release(projectId: string): Promise<void> {
    localActive.delete(projectId);
    const redis = getRedis();
    if (redis) {
      try { await redis.del(activeKey(projectId)); } catch { /* ignore */ }
    }
  },

  /** Fan an event out to every connected subscriber for this project. */
  publish(projectId: string, event: OrchestrationEmitEvent): void {
    const em = emitters.get(projectId);
    if (!em) return;
    em.emit('event', event);
  },

  subscribe(projectId: string, listener: (event: OrchestrationEmitEvent) => void): () => void {
    const em = getEmitter(projectId);
    em.on('event', listener);
    return () => {
      em.off('event', listener);
      if (em.listenerCount('event') === 0) {
        emitters.delete(projectId);
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
