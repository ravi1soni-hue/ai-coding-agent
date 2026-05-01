"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectPostgres = connectPostgres;
exports.getPgPool = getPgPool;
exports.pgQuery = pgQuery;
exports.closePostgres = closePostgres;
const env_1 = require("../config/env");
const pg_1 = require("pg");
let pool = null;
async function connectPostgres() {
    if (!env_1.config.POSTGRES_URL)
        throw new Error('POSTGRES_URL not set');
    // Railway Postgres requires SSL — rejectUnauthorized: false for their self-signed cert
    const sslConfig = env_1.config.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {};
    pool = new pg_1.Pool({ connectionString: env_1.config.POSTGRES_URL, ...sslConfig });
    pool.on('connect', () => console.log('Postgres connected'));
    pool.on('error', err => console.error('Postgres error', err));
}
function getPgPool() {
    if (!pool)
        throw new Error('Postgres not connected');
    return pool;
}
async function pgQuery(query, params) {
    const client = getPgPool();
    const res = await client.query(query, params);
    return res.rows;
}
async function closePostgres() {
    if (pool)
        await pool.end();
    pool = null;
}
