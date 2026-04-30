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
      code_gen = COALESCE($10::jsonb, code_gen),
      test_result = COALESCE($11::jsonb, test_result),
      deployment = COALESCE($12::jsonb, deployment),
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
      input.codeGen ? JSON.stringify(input.codeGen) : null,
      input.testResult ? JSON.stringify(input.testResult) : null,
      input.deployment ? JSON.stringify(input.deployment) : null,
    ],
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
  raw?: unknown;
}) {
  await pgQuery(
    `INSERT INTO project_deployments (
      id, project_id, user_id, frontend_url, backend_url,
      vercel_deployment_id, vercel_inspect_url, vercel_status, vercel_log_url,
      railway_deployment_id, railway_status, railway_log_url, railway_dashboard_url,
      raw_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
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
      JSON.stringify(input.raw ?? {}),
    ],
  );
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
            d.railway_log_url
     FROM project_sessions p
     LEFT JOIN LATERAL (
            SELECT frontend_url, backend_url, vercel_deployment_id, railway_deployment_id,
              vercel_status, railway_status, vercel_log_url, railway_log_url
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
    code_gen: any;
    test_result: any;
    deployment: any;
  }>(
    `SELECT id, status, current_step, progress, requirements, clarifications, confirmation,
            system_design, code_gen, test_result, deployment
     FROM project_sessions
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [input.projectId, input.userId],
  );

  return rows[0] ?? null;
}
