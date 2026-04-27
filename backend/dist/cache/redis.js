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
const env_1 = require("../config/env");
const ioredis_1 = __importDefault(require("ioredis"));
let redis = null;
async function connectRedis() {
    if (!env_1.config.REDIS_URL)
        throw new Error('REDIS_URL not set');
    redis = new ioredis_1.default(env_1.config.REDIS_URL);
    redis.on('connect', () => console.log('Redis connected'));
    redis.on('error', err => console.error('Redis error', err));
}
function getRedis() {
    if (!redis)
        throw new Error('Redis not connected');
    return redis;
}
async function setCache(key, value, ttlSeconds) {
    const client = getRedis();
    if (ttlSeconds) {
        await client.set(key, value, 'EX', ttlSeconds);
    }
    else {
        await client.set(key, value);
    }
}
async function getCache(key) {
    const client = getRedis();
    return client.get(key);
}
async function closeRedis() {
    if (redis)
        await redis.quit();
    redis = null;
}
