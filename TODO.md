# Backend AI Orchestration Hardening — TODO

## Phase 0: Current Blocking Failure Modes (Root-cause fixes)
> Discovered from code review across WS + Orchestrator + Persistence + DB cursor queries.

- [x] **Fix persistence so `project_sessions.current_step` is never left `NULL` after stage entry.**
  - Root cause: snapshot persistence is best-effort and currently updates cursor + artifacts in one heavy transaction (`persistenceAdapter.writeSnapshot()` + `orchestrator.persistMemory()` swallows errors).
  - Impact: resume scanner (`findInFlightProjects`) filters `current_step IS NOT NULL`, so pipelines become non-resumable / appear stuck.
  - Target files: `backend/src/api/persistenceAdapter.ts`, `backend/src/ai/orchestrator/orchestrator.ts`, `backend/src/db/projectStore.ts`.

- [ ] **Stop swallowing persistence errors for cursor fields.**
  - Maintain: failures for heavy artifact fields (code/test/deployment blobs) are best-effort.
  - Guarantee: cursor writes (`status`, `current_step`, `progress`) must be committed even if artifact JSON writes fail.

- [x] **Split cursor persistence from artifact persistence**
  - Implement two-step persistence:
    1) small/light update: status/current_step/progress (+ minimal requirements metadata if needed)
    2) best-effort heavy update: requirements/clarifications/spec/blueprint/code_gen/test_result/deployment and blackboard

## Phase 1: The State Machine & Durability
- [x] Inspect current orchestration flow and persistence (orchestrator.ts, persistenceAdapter.ts, project_store/schema).
- [x] Define FSM states (IDLE, ANALYZING, CLARIFYING, DESIGNING, CODING, TESTING, DEPLOYING, FAILED, COMPLETED) and their transitions.
- [ ] Replace single `runAIOrchestration` flow with a state-driven coordinator (planned; current flow is still orchestrator-driven).
- [ ] Revisit checkpoint persistence design to ensure **resume can rely on checkpoints** even if snapshots partially fail.
- [x] Ensure all state transitions/events are written to `project_events` for auditability (partial coverage; verify stage coverage parity).

## Phase 2: Execution Isolation (The Sandbox)
- [ ] Refactor `projectFactory.ts` to create unique workspace dirs: `/tmp/workspaces/{{projectId}}-{{revisionId}}`. (in TODO list earlier; re-check implementation)
- [x] Inspect current `buildWorker.ts` and how it writes/executes code.
- [ ] Implement Docker-based build/test execution for both:
  - [ ] `npm install`
  - [ ] `npm run build` and `npm test`
- [ ] Ensure container isolation:
  - [ ] No host filesystem writes
  - [ ] No host env leakage
- [ ] Add platform capability checks (DinD availability); fail fast with actionable message.
- [x] Add a Decoupled workspace janitor (ghost workspace cleanup on startup).

## Phase 3: Cost & Loop Protection
- [x] Add max-iterations circuit breaker to `testFixAgent` (and any other looping agents if applicable).
- [x] Implement budget controller middleware for the Orchestrator:
  - [x] Track token usage per `projectId`
  - [x] Transition FSM to `FAILED` when usage exceeds threshold
- [x] Ensure budget transitions are checkpointed and persisted.
- [x] Add audit logging into `project_events`.

## Phase 4: Frontend Hydration Optimization
- [x] Snapshot endpoint: `GET /api/projects/:projectId/snapshot` (materialized state + file tree).
- [x] Update frontend reconnection logic:
  - [x] Snapshot first
  - [x] Replay only events after `snapshot.lastEventId`
- [ ] **Atomic snapshot boundary correctness**
  - [ ] Ensure `lastEventId` boundary is correct in all timing windows (no race between snapshot read and stream subscription).

## Phase 5: Horizontal Scalability (Required)
- [ ] **Make distributed locks owner-safe**
  - Current: `pipelineHub.release()` unconditional DEL, `forceAcquire()` overwrites without fencing.
  - Implement: lock owner token + compare-and-delete (Lua script or equivalent).
  - Target: `backend/src/orchestration/pipelineHub.ts`.

- [ ] **Reduce/Bound Redis fanout loops**
  - Current: per-project Redis `xread` loop per subscribed project.
  - Implement bounded consumer architecture / shared dispatcher.
  - Target: `backend/src/orchestration/pipelineHub.ts`.

- [ ] **Replace in-memory `JobQueue` with durable queue**
  - Current: `backend/src/jobs/jobQueue.ts` is non-durable (lost on restart).
  - Target: `backend/src/jobs/jobQueue.ts` and all job usage.

- [ ] **Global concurrency limit**
  - Limit concurrent orchestration stage runs per process to prevent CPU/memory thrash.

## Phase 6: Correctness Gaps & Deployment Risks (Required)
- [ ] Path mapping correctness:
  - Validate starter template copy + target workspace write rules.
- [ ] Runtime sandbox validation:
  - Confirm platform support for Docker-in-Docker.
  - If unsupported: implement alternate sandbox (worker thread with restricted fs) OR enforce deployment constraints.

---

## Implementation Order (Revised Priority)
1. [ ] **Atomic Cursor Persistence (Phase 0 first)**
2. [ ] Persistence/Resume reliability (Phase 0 second)
3. [ ] Distributed lock owner-safe fix
4. [ ] Bound fanout / scalable event consumption
5. [ ] Durable queue + global concurrency limits
6. [ ] Sandbox docker-in-docker correctness (npm install too)
7. [ ] Atomic snapshot boundary verification
8. [ ] Remaining gaps + smoke tests

## Verification / Quality Gates
- [ ] Run `tsc --noEmit` (backend + frontend if applicable)
- [ ] Run backend build
- [ ] Add/Run a deterministic smoke test:
  - create user
  - create project
  - start orchestration
  - confirm DB: `current_step != NULL` after stage entry
  - confirm resume after forced restart
- [ ] Manual smoke test: start server, run full pipeline with frontend hydration
