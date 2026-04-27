import { config } from '../config/env';
import Redis from 'ioredis';

let redis: Redis | null = null;

export async function connectRedis() {
  if (!config.REDIS_URL) throw new Error('REDIS_URL not set');
  redis = new Redis(config.REDIS_URL);
  redis.on('connect', () => console.log('Redis connected'));
  redis.on('error', err => console.error('Redis error', err));
}

export function getRedis() {
  if (!redis) throw new Error('Redis not connected');
  return redis;
}

export async function setCache(key: string, value: string, ttlSeconds?: number) {
  const client = getRedis();
  if (ttlSeconds) {
    await client.set(key, value, 'EX', ttlSeconds);
  } else {
    await client.set(key, value);
  }
}

export async function getCache(key: string) {
  const client = getRedis();
  return client.get(key);
}

export async function closeRedis() {
  if (redis) await redis.quit();
  redis = null;
}
