import crypto from 'crypto';
import { pgQuery } from './postgres';

export type ProjectHistoryRow = {
  id: string;
  status: string;
  current_step: string | null;
  progress: number;
  created_at: string;
  last_active_at: string;
  frontend_url: string | null;
  backend_url: string | null;
  vercel_deployment_id: string | null;
  railway_deployment_id: string | null;
  vercel_status: string | null;
  railway_status: string | null;
  vercel_log_url: string | null;
  railway_log_url: string | null;
  code_revision_id: string | null;
  source_hash: string | null;
  active_revision_id: string | null;
  revision_lock_owner: string | null;
  revision_lock_expires_at: string | null;
};

export type ProjectBlackboardState = {
  sessionId: string;
  deployment: {
    frontendUrl: string | null;
    backendUrl: string | null;
    dbStatus: string;
  };
  blueprint: unknown | null;
  taskQueue: unknown[];
  terminalLogs: unknown[];
  currentStage: string | null;
  status: string;
  progress: number;
  updatedAt: string;
};

export type ProjectTaskRow = {
  id: string;
  project_id: string;
  user_id: string;
  phase: string;
  action: string;
  file_path: string | null;
  status: string;
  priority: number;
  attempt_count: number;
  payload: unknown;
  error_log: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectCodeRevision = {
  id: string;
  workspace_path: string;
  source_archive_path: string | null;
  source_hash: string | null;
  patch_path: string | null;
  patch_applied: boolean;
  patch_apply_log: string | null;
  created_at: string;
};

export async function appendProjectEvent(input: {
  projectId: string;
  userId: string;
  eventType: string;
  role?: string | null;
  message?: string | null;
  payload?: unknown;
}) {
  await pgQuery(
    `INSERT INTO project_events (id, project_id, user_id, event_type, role, message, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      crypto.randomUUID(),
      input.projectId,
      input.userId,
      input.eventType,
      input.role ?? null,
      input.message ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

export async function updateProjectSnapshot(input: {
  projectId: string;
  userId: string;
  status?: string;
  currentStep?: string;
  progress?: number;
  requirements?: unknown;
  clarifications?: unknown;
  confirmation?: unknown;
  systemDesign?: unknown;
  uiSpec?: unknown;
  structuredSpec?: unknown;
  blueprint?: unknown;
  taskQueue?: unknown;
  terminalLogs?: unknown;
  codeGen?: unknown;
  testResult?: unknown;
  deployment?: unknown;
}) {
  await pgQuery(
    `UPDATE project_sessions
     SET
      status = COALESCE($3, status),
      current_step = COALESCE($4, current_step),
      progress = COALESCE($5, progress),
      requirements = COALESCE($6::jsonb, requirements),
      clarifications = COALESCE($7::jsonb, clarifications),
      confirmation = COALESCE($8::jsonb, confirmation),
      system_design = COALESCE($9::jsonb, system_design),
      ui_spec = COALESCE($10::jsonb, ui_spec),
      structured_spec = COALESCE($11::jsonb, structured_spec),
      blueprint = COALESCE($12::jsonb, blueprint),
      task_queue = COALESCE($13::jsonb, task_queue),
      terminal_logs = COALESCE($14::jsonb, terminal_logs),
      code_gen = COALESCE($15::jsonb, code_gen),
      test_result = COALESCE($16::jsonb, test_result),
      deployment = COALESCE($17::jsonb, deployment),
      last_active_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [
      input.projectId,
      input.userId,
      input.status ?? null,
      input.currentStep ?? null,
      input.progress ?? null,
      input.requirements ? JSON.stringify(input.requirements) : null,
      input.clarifications ? JSON.stringify(input.clarifications) : null,
      input.confirmation ? JSON.stringify(input.confirmation) : null,
      input.systemDesign ? JSON.stringify(input.systemDesign) : null,
      input.uiSpec ? JSON.stringify(input.uiSpec) : null,
      input.structuredSpec ? JSON.stringify(input.structuredSpec) : null,
      input.blueprint ? JSON.stringify(input.blueprint) : null,
      input.taskQueue ? JSON.stringify(input.taskQueue) : null,
      input.terminalLogs ? JSON.stringify(input.terminalLogs) : null,
      input.codeGen ? JSON.stringify(input.codeGen) : null,
      input.testResult ? JSON.stringify(input.testResult) : null,
      input.deployment ? JSON.stringify(input.deployment) : null,
    ],
  );
}

export async function upsertProjectBlackboard(input: {
  projectId: string;
  userId: string;
  state: ProjectBlackboardState;
}) {
  await pgQuery(
    `INSERT INTO project_blackboards (id, project_id, user_id, state)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE
     SET state = EXCLUDED.state,
         updated_at = NOW()`,
    [
      input.projectId,
      input.projectId,
      input.userId,
      JSON.stringify(input.state),
    ],
  );
}

export async function getProjectBlackboard(input: { projectId: string; userId: string }): Promise<ProjectBlackboardState | null> {
  const rows = await pgQuery<{ state: ProjectBlackboardState }>(
    `SELECT state
     FROM project_blackboards
     WHERE project_id = $1 AND user_id = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [input.projectId, input.userId],
  );
  return rows[0]?.state ?? null;
}

export async function appendProjectTask(input: {
  projectId: string;
  userId: string;
  phase: string;
  action: string;
  filePath?: string | null;
  status?: string;
  priority?: number;
  payload?: unknown;
  errorLog?: string | null;
}) {
  const id = crypto.randomUUID();
  await pgQuery(
    `INSERT INTO project_tasks (
      id, project_id, user_id, phase, action, file_path, status, priority, attempt_count, payload, error_log
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9::jsonb, $10)`,
    [
      id,
      input.projectId,
      input.userId,
      input.phase,
      input.action,
      input.filePath ?? null,
      input.status ?? 'pending',
      input.priority ?? 0,
      JSON.stringify(input.payload ?? {}),
      input.errorLog ?? null,
    ],
  );
  return id;
}

export async function listProjectTasks(input: { projectId: string; userId: string }): Promise<ProjectTaskRow[]> {
  return pgQuery<ProjectTaskRow>(
    `SELECT id, project_id, user_id, phase, action, file_path, status, priority, attempt_count, payload, error_log, created_at, updated_at
     FROM project_tasks
     WHERE project_id = $1 AND user_id = $2
     ORDER BY priority DESC, created_at ASC`,
    [input.projectId, input.userId],
  );
}

export async function saveProjectDeployment(input: {
  projectId: string;
  userId: string;
  frontendUrl?: string | null;
  backendUrl?: string | null;
  vercelDeploymentId?: string | null;
  vercelInspectUrl?: string | null;
  vercelStatus?: string | null;
  vercelLogUrl?: string | null;
  railwayDeploymentId?: string | null;
  railwayStatus?: string | null;
  railwayLogUrl?: string | null;
  railwayDashboardUrl?: string | null;
  codeRevisionId?: string | null;
  sourceArchivePath?: string | null;
  sourceHash?: string | null;
  raw?: unknown;
}) {
  await pgQuery(
    `INSERT INTO project_deployments (
      id, project_id, user_id, frontend_url, backend_url,
      vercel_deployment_id, vercel_inspect_url, vercel_status, vercel_log_url,
      railway_deployment_id, railway_status, railway_log_url, railway_dashboard_url,
      code_revision_id, source_archive_path, source_hash,
      raw_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
    [
      crypto.randomUUID(),
      input.projectId,
      input.userId,
      input.frontendUrl ?? null,
      input.backendUrl ?? null,
      input.vercelDeploymentId ?? null,
      input.vercelInspectUrl ?? null,
      input.vercelStatus ?? null,
      input.vercelLogUrl ?? null,
      input.railwayDeploymentId ?? null,
      input.railwayStatus ?? null,
      input.railwayLogUrl ?? null,
      input.railwayDashboardUrl ?? null,
      input.codeRevisionId ?? null,
      input.sourceArchivePath ?? null,
      input.sourceHash ?? null,
      JSON.stringify(input.raw ?? {}),
    ],
  );
}

export async function createProjectCodeRevision(input: {
  projectId: string;
  userId: string;
  workspacePath: string;
  sourceArchivePath?: string | null;
  sourceHash?: string | null;
  patchPath?: string | null;
  patchApplied?: boolean;
  patchApplyLog?: string | null;
  generationPayload?: unknown;
}): Promise<string> {
  const id = crypto.randomUUID();
  await pgQuery(
    `INSERT INTO project_code_revisions (
      id, project_id, user_id, workspace_path, source_archive_path, source_hash,
      patch_path, patch_applied, patch_apply_log, generation_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [
      id,
      input.projectId,
      input.userId,
      input.workspacePath,
      input.sourceArchivePath ?? null,
      input.sourceHash ?? null,
      input.patchPath ?? null,
      input.patchApplied ?? false,
      input.patchApplyLog ?? null,
      JSON.stringify(input.generationPayload ?? {}),
    ],
  );
  return id;
}

export async function getLatestProjectCodeRevision(input: { projectId: string; userId: string }): Promise<ProjectCodeRevision | null> {
  const rows = await pgQuery<ProjectCodeRevision>(
    `SELECT
      id,
      workspace_path,
      source_archive_path,
      source_hash,
      patch_path,
      patch_applied,
      patch_apply_log,
      created_at
     FROM project_code_revisions
     WHERE project_id = $1 AND user_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.projectId, input.userId],
  );
  return rows[0] ?? null;
}

export async function listUserProjects(userId: string): Promise<ProjectHistoryRow[]> {
  return pgQuery<ProjectHistoryRow>(
    `SELECT
      p.id,
      p.status,
      p.current_step,
      p.progress,
      p.created_at,
      p.last_active_at,
      d.frontend_url,
            d.backend_url,
            d.vercel_deployment_id,
            d.railway_deployment_id,
            d.vercel_status,
            d.railway_status,
            d.vercel_log_url,
            d.railway_log_url,
            d.code_revision_id,
            d.source_hash
     FROM project_sessions p
     LEFT JOIN LATERAL (
            SELECT frontend_url, backend_url, vercel_deployment_id, railway_deployment_id,
              vercel_status, railway_status, vercel_log_url, railway_log_url,
              code_revision_id, source_hash
      FROM project_deployments
      WHERE project_id = p.id
      ORDER BY created_at DESC
      LIMIT 1
     ) d ON TRUE
     WHERE p.user_id = $1
     ORDER BY p.last_active_at DESC`,
    [userId],
  );
}

export async function getProjectEvents(input: {
  userId: string;
  projectId: string;
  limit?: number;
}) {
  const rows = await pgQuery<{
    event_type: string;
    role: string | null;
    message: string | null;
    payload: any;
    created_at: string;
  }>(
    `SELECT event_type, role, message, payload, created_at
     FROM project_events
     WHERE user_id = $1 AND project_id = $2
     ORDER BY created_at ASC
     LIMIT $3`,
    [input.userId, input.projectId, input.limit ?? 500],
  );

  return rows;
}

export async function getProjectSnapshot(input: { userId: string; projectId: string }) {
  const rows = await pgQuery<{
    id: string;
    status: string;
    current_step: string | null;
    progress: number;
    requirements: any;
    clarifications: any;
    confirmation: any;
    system_design: any;
    ui_spec: any;
    structured_spec: any;
    code_gen: any;
    test_result: any;
    deployment: any;
  }>(
    `SELECT id, status, current_step, progress, requirements, clarifications, confirmation,
            system_design, ui_spec, structured_spec, code_gen, test_result, deployment
     FROM project_sessions
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [input.projectId, input.userId],
  );

  return rows[0] ?? null;
}
