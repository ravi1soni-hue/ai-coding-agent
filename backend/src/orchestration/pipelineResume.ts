import { runAIOrchestration } from '../ai/orchestrator/orchestrator';
import { createPersistenceAdapter } from '../api/persistenceAdapter';
import { findInFlightProjects, getLatestProjectCheckpoint } from '../db/projectStore';
import { pgQuery } from '../db/postgres';
import { debug as logInfo, error as logError } from '../utils/logger';
import { pipelineHub, createHubAdapter } from './pipelineHub';

import fs from 'fs/promises';
import path from 'path';

// Resume any pipelines that were mid-flight when the process died.
//
// Mechanism:
//   - findInFlightProjects() returns sessions whose persisted status is
//     'active'/'recovering' on a non-interactive stage. (Sessions paused on
//     'clarification' / 'confirmation' are skipped — they're waiting on the
//     user, not on us.)
//   - For each, we forceAcquire the hub lock (the previous process may have
//     left a stale Redis flag), then re-invoke runAIOrchestration with the
//     original userMessage from memory.requirements. The orchestrator's
//     stageWrap() short-circuits any stage whose checkpoint output is already
//     present, so the run effectively picks up at the first stage that didn't
//     complete pre-crash.
//   - Events are published to the per-project hub channel. Any client that
//     reconnects to the project sees the live continuation; if no client is
//     connected, persistence still records progress so a later reconnect
//     replays via /events.
//
// Single-process assumption: if you scale to N replicas, only one should run
// resume on boot, or fence by host id so two replicas don't both adopt the
// same orphaned pipeline. For the current deploy this is fine.

const RESUME_STAGGER_MS = 2_000;

const WORKSPACES_ROOT = '/tmp/workspaces';

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'project';
}

function parseWorkspaceDirName(dirName: string): { projectSegment: string; revisionId: string } | null {
  // Matches: <projectSegment>-<uuid>
  // Note: uuid contains dashes, so we can’t reliably split on '-'.
  const match = dirName.match(
    /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (!match) return null;
  return { projectSegment: match[1], revisionId: match[2] };
}

async function cleanupGhostWorkspaces(): Promise<void> {
  let dirEntries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    const entries = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true });
    dirEntries = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, isDirectory: true }));
  } catch (err: unknown) {
    // If /tmp/workspaces doesn't exist yet, nothing to clean.
    logInfo('pipelineResume:janitor_no_workspaces_root', {
      root: WORKSPACES_ROOT,
      err: String(err),
    });
    return;
  }

  const activeSessions = await pgQuery<{ id: string }>(
    `SELECT id
     FROM project_sessions
     WHERE status IN ('active', 'recovering')`,
    [],
  );

  const activeProjectSegments = new Set(activeSessions.map((r) => sanitizeSegment(r.id)));

  for (const entry of dirEntries) {
    const parsed = parseWorkspaceDirName(entry.name);
    if (!parsed) continue;

    if (activeProjectSegments.has(parsed.projectSegment)) continue;

    const fullPath = path.join(WORKSPACES_ROOT, entry.name);
    try {
      await fs.rm(fullPath, { recursive: true, force: true });
      logInfo('pipelineResume:janitor_deleted_orphan_workspace', { workspaceDir: entry.name });
    } catch (err: unknown) {
      logError('pipelineResume:janitor_failed_delete_orphan_workspace', {
        workspaceDir: entry.name,
        error: String(err),
      });
    }
  }
}

export async function resumeInFlightPipelines(): Promise<void> {
  // Phase 1: Janitor cleanup (best-effort).
  try {
    await cleanupGhostWorkspaces();
  } catch (err: unknown) {
    logError('pipelineResume:janitor_failed', err);
    // Don’t block resume flow on cleanup failures.
  }

  // Phase 2: Resume in-flight orchestrations.
  let rows: Awaited<ReturnType<typeof findInFlightProjects>> = [];
  try {
    rows = await findInFlightProjects();
  } catch (err) {
    logError('pipelineResume:query_failed', err);
    return;
  }
  if (rows.length === 0) return;

  logInfo('pipelineResume:found', { count: rows.length });

  // Stagger so we don't slam OpenAI / DB on every cold boot.
  rows.forEach((row, idx) => {
    const userMessage =
      typeof row.requirements?.userMessage === 'string' ? row.requirements.userMessage.trim() : '';
    if (!userMessage) {
      logInfo('pipelineResume:skip_no_user_message', { projectId: row.id });
      return;
    }
    setTimeout(() => {
      void resumeOne(row.id, row.user_id, userMessage, row.current_step);
    }, idx * RESUME_STAGGER_MS);
  });
}

async function resumeOne(
  projectId: string,
  userId: string,
  userMessage: string,
  stage: string | null,
): Promise<void> {
  // Adopt the lock. We deliberately use forceAcquire because the previous
  // owner is dead by definition (we just rebooted).
  await pipelineHub.forceAcquire(projectId);
  try {
    logInfo('pipelineResume:starting', { projectId, stage });
    const persistence = createPersistenceAdapter({ projectId, userId });
    const adapter = createHubAdapter(projectId);

    // Announce on the hub channel so any client already attached sees the
    // resume notice before stage events start arriving.
    pipelineHub.publish(
      projectId,
      {
        type: 'info',
        stage: (stage || 'requirements') as any,
        message: 'Resuming pipeline after server restart…',
      } as any,
    );

    const checkpoint = await getLatestProjectCheckpoint({ projectId, userId });
    const startStep = checkpoint?.stage;
    const result = await runAIOrchestration(
      {
        projectId,
        sessionId: projectId,
        userMessage,
        step: (startStep ?? stage ?? undefined) as any,
        recoveryContextSnapshot: checkpoint?.contextSnapshot as any,
        recoveryFsmState: checkpoint?.fsmState as any,
      },
      adapter,
      persistence,
    );
    logInfo('pipelineResume:finished', { projectId, status: result.status });
  } catch (err) {
    logError('pipelineResume:failed', { projectId, error: err });
    pipelineHub.publish(
      projectId,
      {
        type: 'failed',
        projectId,
        issues: [{ message: 'Pipeline resume after restart failed.' }],
      } as any,
    );
  } finally {
    await pipelineHub.release(projectId);
  }
}
