import { config } from '../config/env';
import Redis from 'ioredis';

let redis: Redis | null = null;

export async function connectRedis() {
  if (!config.REDIS_URL) {
    console.warn('[Redis] REDIS_URL not set — Redis disabled. Caching will be skipped.');
    return;
  }
  redis = new Redis(config.REDIS_URL);
  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error', err => console.error('Redis error', err));
}

export function getRedis() {
  if (!redis) return null;
  return redis;
}

export async function setCache(key: string, value: string, ttlSeconds?: number) {
  const client = getRedis();
  if (!client) return;
  if (ttlSeconds) {
    await client.set(key, value, 'EX', ttlSeconds);
  } else {
    await client.set(key, value);
  }
}

export async function getCache(key: string) {
  const client = getRedis();
  if (!client) return null;
  return client.get(key);
}

export async function closeRedis() {
  if (redis) await redis.quit();
  redis = null;
}

export async function setCacheJson(key: string, value: unknown, ttlSeconds?: number) {
  await setCache(key, JSON.stringify(value), ttlSeconds);
}

export async function getCacheJson<T = unknown>(key: string): Promise<T | null> {
  const raw = await getCache(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
