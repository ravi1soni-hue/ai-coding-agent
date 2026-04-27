"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureVectorTable = ensureVectorTable;
exports.insertVector = insertVector;
exports.searchVectors = searchVectors;
// Vector storage and similarity search using Postgres + pgvector
const postgres_1 = require("./postgres");
// Table: vectors
// id (SERIAL PRIMARY KEY)
// user_id (TEXT)
// task (TEXT)
// embedding (VECTOR)
// metadata (JSONB)
// created_at (TIMESTAMP)
async function ensureVectorTable() {
    const pool = (0, postgres_1.getPgPool)();
    await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE IF NOT EXISTS vectors (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      task TEXT,
      embedding vector(1536),
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
async function insertVector({ user_id, task, embedding, metadata }) {
    const pool = (0, postgres_1.getPgPool)();
    await pool.query('INSERT INTO vectors (user_id, task, embedding, metadata) VALUES ($1, $2, $3, $4)', [user_id, task, embedding, metadata || {}]);
}
async function searchVectors({ user_id, task, embedding, topK = 5 }) {
    const pool = (0, postgres_1.getPgPool)();
    const res = await pool.query(`SELECT *, (embedding <#> $1::vector) AS distance
     FROM vectors
     WHERE user_id = $2 AND task = $3
     ORDER BY embedding <#> $1::vector ASC
     LIMIT $4`, [embedding, user_id, task, topK]);
    return res.rows;
}
