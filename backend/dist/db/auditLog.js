"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logOrchestrationStep = logOrchestrationStep;
// Audit log for orchestration steps
const postgres_1 = require("./postgres");
async function logOrchestrationStep({ user_id, step, input, output }) {
    const pool = (0, postgres_1.getPgPool)();
    await pool.query(`CREATE TABLE IF NOT EXISTS orchestration_audit (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      step TEXT,
      input JSONB,
      output JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query('INSERT INTO orchestration_audit (user_id, step, input, output) VALUES ($1, $2, $3, $4)', [user_id, step, input, output]);
}
