"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectRedis = connectRedis;
exports.getRedis = getRedis;
exports.setCache = setCache;
exports.getCache = getCache;
exports.closeRedis = closeRedis;
exports.setCacheJson = setCacheJson;
exports.getCacheJson = getCacheJson;
const env_1 = require("../config/env");
const ioredis_1 = __importDefault(require("ioredis"));
let redis = null;
async function connectRedis() {
    if (!env_1.config.REDIS_URL) {
        console.warn('[Redis] REDIS_URL not set — Redis disabled. Caching will be skipped.');
        return;
    }
    redis = new ioredis_1.default(env_1.config.REDIS_URL);
    redis.on('connect', () => console.log('Redis connected'));
    redis.on('error', err => console.error('Redis error', err));
}
function getRedis() {
    if (!redis)
        return null;
    return redis;
}
async function setCache(key, value, ttlSeconds) {
    const client = getRedis();
    if (!client)
        return;
    if (ttlSeconds) {
        await client.set(key, value, 'EX', ttlSeconds);
    }
    else {
        await client.set(key, value);
    }
}
async function getCache(key) {
    const client = getRedis();
    if (!client)
        return null;
    return client.get(key);
}
async function closeRedis() {
    if (redis)
        await redis.quit();
    redis = null;
}
async function setCacheJson(key, value, ttlSeconds) {
    await setCache(key, JSON.stringify(value), ttlSeconds);
}
async function getCacheJson(key) {
    const raw = await getCache(key);
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
