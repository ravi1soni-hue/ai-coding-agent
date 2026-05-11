import type {
  CodeRevisionRecord,
  DeploymentRecord,
  OrchestrationEvent,
  PersistenceAdapter,
  ProjectMemory,
} from '../ai/contracts/orchestration';
import {
  appendProjectEvent,
  createProjectCodeRevision,
  getProjectSnapshot,
  saveProjectDeployment,
  saveProjectCheckpoint,
  loadProjectCheckpoints,
  updateProjectSnapshot,
  upsertProjectBlackboard,
} from '../db/projectStore';
import { getPgPool } from '../db/postgres';
import { error as logError } from '../utils/logger';

type AdapterScope = {
  projectId: string;
  userId: string;
};

function memoryStatusToDbStatus(memory: ProjectMemory): string {
  // Persist interactive/non-terminal states so resume can be accurate.
  if (memory.status === 'completed') return 'completed';
  if (memory.status === 'failed') return 'failed';
  if (memory.status === 'paused') return 'paused';
  if (memory.status === 'recovering') return 'recovering';

  // Fallbacks derived from stage for backward compatibility.
  if (memory.currentState === 'failed') return 'failed';
  if (memory.currentState === 'done') return 'completed';

  return 'active';
}

function progressFromMemory(memory: ProjectMemory): number {
  if (memory.status === 'completed') return 1;
  // Coarse mapping from currentState to a percent. Stage emits override this
  // in real time via the OrchestrationAdapter; this is just the resume-default.
  switch (memory.currentState) {
    case 'requirements': return 0.05;
    case 'clarification': return 0.12;
    case 'confirmation': return 0.18;
    case 'system_design': return 0.25;
    case 'ui_spec': return 0.35;
    case 'blueprint': return 0.5;
    case 'execution_plan': return 0.55;
    case 'code_generation': return 0.65;
    case 'testing': return 0.8;
    case 'deployment': return 0.95;
    case 'done': return 1;
    case 'modification': return 0.4;
    default: return 0;
  }
}

async function writeSnapshot(scope: AdapterScope, memory: ProjectMemory): Promise<void> {
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    // Update project snapshot
    await client.query(
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
        code_gen = COALESCE($13::jsonb, code_gen),
        test_result = COALESCE($14::jsonb, test_result),
        deployment = COALESCE($15::jsonb, deployment),
        last_active_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [
        scope.projectId,
        scope.userId,
        memoryStatusToDbStatus(memory),
        memory.currentState,
        progressFromMemory(memory),
        JSON.stringify(memory.requirements),
        JSON.stringify(memory.clarifications),
        JSON.stringify(memory.confirmation),
        JSON.stringify(memory.systemDesign),
        JSON.stringify(memory.uiSpec?.uiSpec),
        JSON.stringify(memory.uiSpec?.structuredSpec),
        JSON.stringify(memory.blueprint?.blueprint),
        JSON.stringify(memory.code),
        JSON.stringify(memory.tests),
        JSON.stringify(memory.deployment),
      ],
    );
    await client.query(
      `INSERT INTO project_blackboards (id, project_id, user_id, state)
       VALUES ($1, $1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = NOW()`,
      [
        scope.projectId,
        scope.userId,
        JSON.stringify({
          sessionId: scope.projectId,
          deployment: {
            frontendUrl: memory.deployment?.frontendUrl || null,
            backendUrl: memory.deployment?.backendUrl || null,
            dbStatus: 'ready',
          },
          blueprint: memory.blueprint?.blueprint || null,
          taskQueue: [],
          terminalLogs: [],
          currentStage: memory.currentState,
          status: memoryStatusToDbStatus(memory) as 'active' | 'completed' | 'failed',
          progress: progressFromMemory(memory),
          updatedAt: new Date().toISOString(),
        }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadSnapshotInto(scope: AdapterScope): Promise<ProjectMemory | null> {
  const row = await getProjectSnapshot({ userId: scope.userId, projectId: scope.projectId });
  if (!row) return null;

  try {
    const memory: ProjectMemory = {
      projectId: scope.projectId,
      sessionId: scope.projectId,
      currentState: (row.current_step as ProjectMemory['currentState']) || 'requirements',
      deploymentMode: row.requirements?.backend_required ? 'full-stack' : 'frontend-only',
      requirements: row.requirements
        ? {
            userMessage: row.requirements.userMessage || '',
            website_type: row.requirements.website_type,
            pages: Array.isArray(row.requirements.pages) ? row.requirements.pages : [],
            backend_required: Boolean(row.requirements.backend_required),
            auth_required: Boolean(row.requirements.auth_required),
            deployment_pref: row.requirements.deployment_pref,
            notes: row.requirements.notes,
          }
        : undefined,
      clarifications: row.clarifications || undefined,
      confirmation: row.confirmation || undefined,
      systemDesign: row.system_design || undefined,
      uiSpec: row.structured_spec || row.ui_spec
        ? { uiSpec: row.ui_spec, structuredSpec: row.structured_spec || row.ui_spec }
        : undefined,
      code: row.code_gen || undefined,
      tests: row.test_result || undefined,
      deployment: row.deployment || undefined,
      history: [],
      errors: [],
      fixes: [],
      checkpoints: [],
      status:
        row.status === 'completed'
          ? 'completed'
          : row.status === 'failed'
            ? 'failed'
            : row.status === 'paused'
              ? 'paused'
              : row.status === 'recovering'
                ? 'recovering'
                : 'active',
    };

    // Basic corruption check
    if (!memory.projectId || typeof memory.currentState !== 'string') {
      throw new Error('Corrupted memory: missing projectId or invalid currentState');
    }

    return memory;
  } catch (err) {
    logError('persistenceAdapter:loadSnapshot_corrupted', { projectId: scope.projectId, error: err });
    // Return null to start fresh
    return null;
  }
}

async function writeEvent(scope: AdapterScope, event: OrchestrationEvent): Promise<void> {
  // Persist `stage` in payload so REST /events replay can render the same stage
  // semantics as live WS events.
  const basePayload =
    event.payload && typeof event.payload === 'object' ? { ...(event.payload as Record<string, unknown>) } : {};

  if (event.type === 'stage_complete') {
    // Avoid persisting huge outputs over the event log (code is streamed per-file).
    if ('output' in basePayload) basePayload.output = undefined;
  }

  if (typeof (basePayload as Record<string, unknown>).stage !== 'string') {
    (basePayload as Record<string, unknown>).stage = event.stage;
  }

  await appendProjectEvent({
    projectId: scope.projectId,
    userId: scope.userId,
    eventType: event.type,
    role: 'system',
    message: event.message,
    payload: basePayload,
  });
}

async function writeCodeRevision(scope: AdapterScope, rec: CodeRevisionRecord): Promise<void> {
  if (!rec.workspacePath) return;
  await createProjectCodeRevision({
    projectId: scope.projectId,
    userId: scope.userId,
    workspacePath: rec.workspacePath,
    sourceArchivePath: rec.sourceArchivePath,
    sourceHash: rec.sourceHash,
    patchPath: rec.patchPath,
    patchApplied: rec.patchApplied,
    patchApplyLog: rec.patchApplyLog,
    generationPayload: { files: rec.files, patch: rec.patch },
  });
}

async function writeDeployment(scope: AdapterScope, rec: DeploymentRecord): Promise<void> {
  await saveProjectDeployment({
    projectId: scope.projectId,
    userId: scope.userId,
    frontendUrl: rec.frontendUrl,
    backendUrl: rec.backendUrl,
    vercelDeploymentId: rec.vercelDeploymentId,
    vercelInspectUrl: rec.vercelInspectUrl,
    vercelStatus: rec.vercelStatus,
    vercelLogUrl: rec.vercelLogUrl,
    railwayDeploymentId: rec.railwayDeploymentId,
    railwayStatus: rec.railwayStatus,
    railwayLogUrl: rec.railwayLogUrl,
    railwayDashboardUrl: rec.railwayDashboardUrl,
    codeRevisionId: rec.codeRevisionId,
    sourceArchivePath: rec.sourceArchivePath,
    sourceHash: rec.sourceHash,
    raw: rec.raw,
  });
}

export function createPersistenceAdapter(scope: AdapterScope): PersistenceAdapter {
  return {
    saveSnapshot: (memory) => writeSnapshot(scope, memory),
    loadSnapshot: () => loadSnapshotInto(scope),
    appendEvent: (event) => writeEvent(scope, event),
    saveCodeRevision: (rec) => writeCodeRevision(scope, rec),
    saveDeployment: (rec) => writeDeployment(scope, rec),

    // Enable real resume-by-checkpoint across WS disconnects / process restarts.
    saveCheckpoint: (checkpoint) =>
      saveProjectCheckpoint({
        projectId: checkpoint.projectId,
        userId: scope.userId,
        stage: checkpoint.stage,
        inputHash: checkpoint.inputHash,
        output: checkpoint.output ?? null,
        issues: checkpoint.issues,
        retryCount: checkpoint.retryCount,
        contextSnapshot: checkpoint.contextSnapshot,
        fsmState: checkpoint.fsmState,
      }),
    loadCheckpoints: (projectId) =>
      loadProjectCheckpoints({
        projectId: projectId,
        userId: scope.userId,
      }),
  };
}
