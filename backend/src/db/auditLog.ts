// Audit log for orchestration steps
import { getPgPool } from './postgres';

export async function logOrchestrationStep({ user_id, step, input, output }: {
  user_id: string;
  step: string;
  input: any;
  output: any;
}) {
  const pool = getPgPool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS orchestration_audit (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      step TEXT,
      input JSONB,
      output JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );`
  );
  await pool.query(
    'INSERT INTO orchestration_audit (user_id, step, input, output) VALUES ($1, $2, $3, $4)',
    [user_id, step, input, output]
  );
}
