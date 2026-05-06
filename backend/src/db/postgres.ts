import { config } from '../config/env';
import { Pool } from 'pg';

let pool: Pool | null = null;

export async function connectPostgres() {
  if (!config.POSTGRES_URL) {
    console.warn('[WARNING] POSTGRES_URL not set — Postgres disabled. DB features will be unavailable.');
    pool = null;
    return;
  }

  // Railway Postgres requires SSL — rejectUnauthorized: false for their self-signed cert
  const sslConfig = config.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {};
  pool = new Pool({ connectionString: config.POSTGRES_URL, ...sslConfig });
  pool.on('connect', () => console.log('Postgres connected'));
  pool.on('error', err => console.error('Postgres error', err));
}

export function getPgPool() {
  if (!pool) throw new Error('Postgres not connected');
  return pool;
}

export async function pgQuery<T = any>(query: string, params?: any[]): Promise<T[]> {
  const client = getPgPool();
  const res = await client.query(query, params);
  return res.rows;
}

export async function closePostgres() {
  if (pool) await pool.end();
  pool = null;
}
