import { pgQuery } from './postgres';

export async function ensureCoreTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgQuery(`
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

  await pgQuery(`
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
      ui_spec JSONB,
      blueprint JSONB,
      task_queue JSONB,
      terminal_logs JSONB NOT NULL DEFAULT '[]'::jsonb,
      code_gen JSONB,
      test_result JSONB,
      deployment JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS project_blackboards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      action TEXT NOT NULL,
      file_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_log TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS current_step TEXT`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS requirements JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS clarifications JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS confirmation JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS system_design JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS ui_spec JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS code_gen JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS test_result JSONB`);
  await pgQuery(`ALTER TABLE project_sessions ADD COLUMN IF NOT EXISTS deployment JSONB`);

  await pgQuery(`
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

  await pgQuery(`
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

  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS vercel_status TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS vercel_log_url TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_deployment_id TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_status TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_log_url TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS railway_dashboard_url TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS code_revision_id TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS source_archive_path TEXT`);
  await pgQuery(`ALTER TABLE project_deployments ADD COLUMN IF NOT EXISTS source_hash TEXT`);

  await pgQuery(`
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

  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id)
  `);

  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_project_sessions_user_id ON project_sessions(user_id)
  `);

  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_project_events_project_created ON project_events(project_id, created_at)
  `);

  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_project_deployments_project_created ON project_deployments(project_id, created_at)
  `);

  await pgQuery(`
    CREATE INDEX IF NOT EXISTS idx_project_code_revisions_project_created ON project_code_revisions(project_id, created_at)
  `);
}
