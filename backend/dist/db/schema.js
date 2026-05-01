"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureCoreTables = ensureCoreTables;
const postgres_1 = require("./postgres");
async function ensureCoreTables() {
    await (0, postgres_1.pgQuery)(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    )
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE TABLE IF NOT EXISTS project_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      current_step TEXT,
      progress DOUBLE PRECISION NOT NULL DEFAULT 0,
      requirements JSONB,
      clarifications JSONB,
      confirmation JSONB,
      system_design JSONB,
      code_gen JSONB,
      test_result JSONB,
      deployment JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS current_step TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS requirements JSONB`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS clarifications JSONB`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS confirmation JSONB`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS system_design JSONB`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS code_gen JSONB`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS test_result JSONB`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS deployment JSONB`);
    await (0, postgres_1.pgQuery)(`
    CREATE TABLE IF NOT EXISTS project_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      role TEXT,
      message TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE TABLE IF NOT EXISTS project_deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      frontend_url TEXT,
      backend_url TEXT,
      vercel_deployment_id TEXT,
      vercel_inspect_url TEXT,
      vercel_status TEXT,
      vercel_log_url TEXT,
      railway_deployment_id TEXT,
      railway_status TEXT,
      railway_log_url TEXT,
      railway_dashboard_url TEXT,
      raw_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS vercel_status TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS vercel_log_url TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_deployment_id TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_status TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_log_url TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_dashboard_url TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS code_revision_id TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS source_archive_path TEXT`);
    await (0, postgres_1.pgQuery)(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS source_hash TEXT`);
    await (0, postgres_1.pgQuery)(`
    CREATE TABLE IF NOT EXISTS project_code_revisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_path TEXT NOT NULL,
      source_archive_path TEXT,
      source_hash TEXT,
      patch_path TEXT,
      patch_applied BOOLEAN NOT NULL DEFAULT FALSE,
      patch_apply_log TEXT,
      generation_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE INDEX IF NOT EXISTS idx_project_sessions_user_id ON project_sessions(user_id)
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE INDEX IF NOT EXISTS idx_project_events_project_created ON project_events(project_id, created_at)
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE INDEX IF NOT EXISTS idx_project_deployments_project_created ON project_deployments(project_id, created_at)
  `);
    await (0, postgres_1.pgQuery)(`
    CREATE INDEX IF NOT EXISTS idx_project_code_revisions_project_created ON project_code_revisions(project_id, created_at)
  `);
}
