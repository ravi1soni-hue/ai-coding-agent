import { config } from '../config/env';
import Redis from 'ioredis';

let redis: Redis | null = null;
let redisDisabled = false;

function disableRedis(reason: string) {
  redisDisabled = true;
  console.warn(reason);
  if (redis) {
    redis.disconnect();
    redis = null;
  }
}

export async function connectRedis() {
  if (redisDisabled) return;
  if (!config.REDIS_URL) {
    disableRedis('[Redis] REDIS_URL not set — Redis disabled. Caching will be skipped.');
    return;
  }

  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  client.on('connect', () => console.log('Redis connected'));
  client.on('error', err => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Redis error', err);
    if (message.includes('WRONGPASS') || message.includes('NOAUTH') || message.includes('invalid username-password pair')) {
      disableRedis('[Redis] Authentication failed — Redis disabled. Check REDIS_URL credentials.');
    }
  });

  try {
    await client.connect();
    redis = client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('WRONGPASS') ||
      message.includes('NOAUTH') ||
      message.includes('invalid username-password pair') ||
      message.includes('Connection is closed')
    ) {
      disableRedis('[Redis] Authentication failed — Redis disabled. Check REDIS_URL credentials.');
      return;
    }
    throw err;
  }
}

export function getRedis() {
  if (!redis || redisDisabled) return null;
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
  redisDisabled = false;
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
