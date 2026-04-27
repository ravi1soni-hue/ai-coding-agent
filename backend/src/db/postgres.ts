import { config } from '../config/env';
import { Pool } from 'pg';

let pool: Pool | null = null;

export async function connectPostgres() {
  if (!config.POSTGRES_URL) throw new Error('POSTGRES_URL not set');
  pool = new Pool({ connectionString: config.POSTGRES_URL });
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
