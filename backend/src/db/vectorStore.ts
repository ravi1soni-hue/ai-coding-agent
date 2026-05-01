// Vector storage and similarity search using Postgres + pgvector
import { getPgPool } from './postgres';

// Table: vectors
// id (SERIAL PRIMARY KEY)
// user_id (TEXT)
// task (TEXT)
// embedding (VECTOR)
// metadata (JSONB)
// created_at (TIMESTAMP)

let vectorsAvailable = false;

export async function ensureVectorTable() {
  const pool = getPgPool();
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  } catch (err) {
    console.warn('[VectorStore] pgvector extension not available — vector search disabled:', (err as any)?.message);
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vectors (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        task TEXT,
        embedding vector(1536),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    vectorsAvailable = true;
    console.log('[VectorStore] vectors table ready');
  } catch (err) {
    console.warn('[VectorStore] Could not create vectors table:', (err as any)?.message);
  }
}

export async function insertVector({ user_id, task, embedding, metadata }: {
  user_id: string;
  task: string;
  embedding: number[];
  metadata?: any;
}) {
  if (!vectorsAvailable) return;
  const pool = getPgPool();
  await pool.query(
    'INSERT INTO vectors (user_id, task, embedding, metadata) VALUES ($1, $2, $3, $4)',
    [user_id, task, embedding, metadata || {}]
  );
}

export async function searchVectors({ user_id, task, embedding, topK = 5 }: {
  user_id: string;
  task: string;
  embedding: number[];
  topK?: number;
}) {
  if (!vectorsAvailable) return [];
  const pool = getPgPool();
  const res = await pool.query(
    `SELECT *, (embedding <#> $1::vector) AS distance
     FROM vectors
     WHERE user_id = $2 AND task = $3
     ORDER BY embedding <#> $1::vector ASC
     LIMIT $4`,
    [embedding, user_id, task, topK]
  );
  return res.rows;
}
