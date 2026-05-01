"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendProjectEvent = appendProjectEvent;
exports.updateProjectSnapshot = updateProjectSnapshot;
exports.saveProjectDeployment = saveProjectDeployment;
exports.createProjectCodeRevision = createProjectCodeRevision;
exports.getLatestProjectCodeRevision = getLatestProjectCodeRevision;
exports.listUserProjects = listUserProjects;
exports.getProjectEvents = getProjectEvents;
exports.getProjectSnapshot = getProjectSnapshot;
const crypto_1 = __importDefault(require("crypto"));
const postgres_1 = require("./postgres");
async function appendProjectEvent(input) {
    await (0, postgres_1.pgQuery)(`INSERT INTO project_events (id, project_id, user_id, event_type, role, message, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, [
        crypto_1.default.randomUUID(),
        input.projectId,
        input.userId,
        input.eventType,
        input.role ?? null,
        input.message ?? null,
        JSON.stringify(input.payload ?? {}),
    ]);
}
async function updateProjectSnapshot(input) {
    await (0, postgres_1.pgQuery)(`UPDATE project_sessions
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
     WHERE id = $1 AND user_id = $2`, [
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
    ]);
}
async function saveProjectDeployment(input) {
    await (0, postgres_1.pgQuery)(`INSERT INTO project_deployments (
      id, project_id, user_id, frontend_url, backend_url,
      vercel_deployment_id, vercel_inspect_url, vercel_status, vercel_log_url,
      railway_deployment_id, railway_status, railway_log_url, railway_dashboard_url,
      code_revision_id, source_archive_path, source_hash,
      raw_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`, [
        crypto_1.default.randomUUID(),
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
    ]);
}
async function createProjectCodeRevision(input) {
    const id = crypto_1.default.randomUUID();
    await (0, postgres_1.pgQuery)(`INSERT INTO project_code_revisions (
      id, project_id, user_id, workspace_path, source_archive_path, source_hash,
      patch_path, patch_applied, patch_apply_log, generation_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`, [
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
    ]);
    return id;
}
async function getLatestProjectCodeRevision(input) {
    const rows = await (0, postgres_1.pgQuery)(`SELECT
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
     LIMIT 1`, [input.projectId, input.userId]);
    return rows[0] ?? null;
}
async function listUserProjects(userId) {
    return (0, postgres_1.pgQuery)(`SELECT
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
     ORDER BY p.last_active_at DESC`, [userId]);
}
async function getProjectEvents(input) {
    const rows = await (0, postgres_1.pgQuery)(`SELECT event_type, role, message, payload, created_at
     FROM project_events
     WHERE user_id = $1 AND project_id = $2
     ORDER BY created_at ASC
     LIMIT $3`, [input.userId, input.projectId, input.limit ?? 500]);
    return rows;
}
async function getProjectSnapshot(input) {
    const rows = await (0, postgres_1.pgQuery)(`SELECT id, status, current_step, progress, requirements, clarifications, confirmation,
            system_design, code_gen, test_result, deployment
     FROM project_sessions
     WHERE id = $1 AND user_id = $2
     LIMIT 1`, [input.projectId, input.userId]);
    return rows[0] ?? null;
}
