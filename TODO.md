# Backend AI Orchestration Hardening — TODO

## Phase 1: The State Machine & Durability
- [x] Inspect current orchestration flow and persistence (orchestrator.ts, persistenceAdapter.ts, project_store/schema).
- [x] Define FSM states (IDLE, ANALYZING, CLARIFYING, DESIGNING, CODING, TESTING, DEPLOYING, FAILED, COMPLETED) and their transitions.
- [x] Replace single `runAIOrchestration` flow with a state-driven coordinator.
- [x] Implement checkpoint persistence: on every state transition, save `context_snapshot` (serialized full memory slice) to `project_checkpoints` (requires DB schema extension + persistence adapter changes).
- [x] Ensure all state transitions/events are written to `project_events` for auditability.

## Phase 2: Execution Isolation (The Sandbox)
- [x] Refactor `projectFactory.ts` to create unique workspace dirs: `/tmp/workspaces/{{projectId}}-{{revisionId}}`.
- [x] Inspect current `buildWorker.ts` and how it writes/executes code.
- [x] Implement Docker-based build/test execution: spawn a container, mount workspace, run `npm install` + `npm test`, stream logs back to server.
- [x] Ensure the container has no access to host filesystem and no host env leakage.
- [x] Add type-safe interfaces for “ExecutionRun” request/response + log streaming.
- [x] Run backend tests / typecheck to validate integration.
- [x] **Ghost Workspace Cleanup (Janitor)**: Add a Janitor service on boot (in `pipelineResume.ts`) that deletes `/tmp/workspaces/*` dirs that do NOT have a corresponding “Active” session in `project_sessions`.

## Phase 3: Cost & Loop Protection
- [x] Add max-iterations circuit breaker to `testFixAgent` (and any other looping agents if applicable).
- [x] Implement budget controller middleware for the Orchestrator:
  - [x] Track token usage per `projectId`
  - [x] If usage exceeds threshold, transition FSM to `FAILED` with message `"Budget Exceeded"`.
- [x] Ensure budget transitions are checkpointed and persisted.
- [x] Add audit logging into `project_events`.

## Phase 4: Frontend Hydration Optimization
- [x] Create snapshot endpoint: `GET /api/projects/:projectId/snapshot`.
  - [x] Return materialized state: current file tree, latest status, active agent.
- [x] Update frontend reconnection logic:
  - [x] Fetch snapshot first
  - [x] Replay only events after `snapshot.lastEventId`
- [x] Validate reconnection flow in UI (no missing/duplicated messages).
- [x] **Atomic Snapshotting**: Ensure `snapshot.lastEventId` is captured atomically at the exact moment the snapshot is generated (no race between snapshot read and websocket subscription).
  - [x] Update snapshot SQL/transaction so the snapshot includes the correct `lastEventId` boundary for replay.

## Phase 5: Horizontal Scalability (Optional → Correctness under failover)
- [x] Replace Redis Pub/Sub fanout with **Redis Streams** in the Hub so events are not lost across backend restarts.
  - [x] Update `pipelineHub.ts` to publish to streams
  - [x] Update consumers to read/ack from a stream ID cursor
  - [x] Verify live UI resumes reliably after instance restart

## Phase 6: Correctness Gaps & Logical/Deployment Risks (Required)
- [x] **Path Mapping (Starter Templates vs Target Workspace)**:
  - [x] Ensure Starter Templates live in a read-only directory (e.g. `/app/templates`)
  - [x] Ensure buildWorker only writes to the target workspace in `/tmp/workspaces/*`
  - [x] Confirm template copy/mount logic matches Sections 12.1 vs 12.3 in the LLD
- [x] **Global Orchestration Timeout**: Add a wall-clock global timeout for the entire orchestration (e.g. 10 minutes), not just per-agent loop counts.
- [x] **Sandbox Validation / DinD Risk**: Verify whether the deployment target (Railway/Vercel) supports `docker run`.
  - [x] Implement a runtime capability check / fail fast with actionable logs
  - [x] If DinD is unsupported, add an alternate sandbox strategy (Node VM/Worker Thread with restricted fs) OR document required platform constraints

## Implementation Order (Revised Priority)
1. [ ] Atomic Snapshotting (lastEventId correctness)
2. [ ] Janitor Logic (Ghost Workspace cleanup on startup)
3. [ ] Path Mapping (Starter Templates read-only vs /tmp workspace write)
4. [ ] Sandbox Validation (Railway supports docker run?); then adjust sandbox strategy if needed
5. [ ] Redis Streams Hub correctness (at-least-once + ack/resume)
6. [ ] Global Orchestration Timeout
7. [ ] Any remaining LLD inconsistencies + verification smoke tests

## Verification / Quality Gates
- [x] Run `tsc --noEmit` (backend + frontend if applicable) — covered by `npm run build` (tsc) for backend.
- [x] Run backend unit/integration tests — no backend `test` script is defined in `backend/package.json` (build is the available automated gate).
- [x] Run backend build.
- [ ] Manual smoke test: start server, create a project, confirm state transitions, recovery, and frontend hydration. *(Blocked in this environment: backend started with POSTGRES_URL unset, so auth/session + project persistence aren’t available; snapshot endpoint returns 401 without a session.)*
