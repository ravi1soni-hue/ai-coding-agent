# Low-Level Design (LLD) — AI Autonomous Website Builder (Current Codebase)

## 1. Purpose

This LLD describes the **runtime architecture**, **contracts**, **data ownership**, **control flow**, **persistence model**, **recovery/resume behavior**, **sandbox/build isolation**, and **frontend hydration/reconnection** for the current implementation in this repository.

It is intended to be implementation-level:
- concrete modules/files
- concrete API routes and WebSocket event types
- concrete DB tables/columns involved in orchestration durability
- concrete execution isolation boundaries and filesystem safety rules
- concrete Redis Pub/Sub behavior for cross-instance event fanout
- concrete snapshot/replay behavior for frontend reconnect

---

## 2. System Summary

The system is a **session-driven AI orchestration pipeline** that transforms a user request into a deployable web application.

The system has two key domains:

1. **Base App (control plane)**  
   Persistent runtime: auth, orchestration coordinator, socket + HTTP APIs, persistence adapter, audit/event logging, workspace materialization, build/test sandbox, deployment, and recovery/resume.

2. **Generated Project (ephemeral output)**  
   Per session generated files and derived artifacts live under `/tmp/...` only during execution, and are archived/packaged as revisions for deployment. Generated source is not written into the base app repository tree.

---

## 3. Runtime Stack

### Frontend
- React (Vite)
- Socket-based live updates
- Snapshot-first reconnect to avoid message loss/duplication

### Backend (Base App)
- Node.js + TypeScript
- Fastify for HTTP routing and server
- `ws` WebSocket server for interactive orchestration
- PostgreSQL for persistence (project sessions, events, checkpoints, code revisions, deployments)
- Redis optional for transient caches and **Pub/Sub fanout** (cross-instance event delivery)

### Deployment targets
- Vercel for frontend
- Railway for backend

---

## 4. Top-Level Runtime Architecture

### 4.1 Modules (by responsibility)

**Server bootstrap**
- `backend/src/index.ts`
  - connects Redis/Postgres
  - ensures DB schema (`ensureCoreTables`, `ensureVectorTable`)
  - serves static frontend build
  - starts WebSocket server (`createSocketServer`)
  - resumes in-flight pipelines on boot (`resumeInFlightPipelines`)

**HTTP API layer**
- `backend/src/api/routes.ts`
- `backend/src/api/server.ts` (server helper; repo uses `backend/src/index.ts` at runtime)
- `backend/src/api/projectRoutes.ts`
  - CRUD-like project endpoints
  - snapshot/events/file retrieval endpoints
  - redeploy endpoint

**WebSocket gateway**
- `backend/src/api/socket.ts`
  - origin allowlist enforcement
  - cookie-based auth
  - per-project pipeline stream subscription via `pipelineHub`
  - orchestrator command construction (fresh vs clarification vs confirmation vs modification)
  - rate limiting
  - sanitize input
  - app-level acquire lock + hub-based resume signaling

**Orchestration engine**
- `backend/src/ai/orchestrator/orchestrator.ts`
  - main pipeline coordinator (`runAIOrchestration`)
  - stage orchestration and self-healing loop
  - durable checkpoint snapshot creation
  - calls build/test/materialize/deploy stages

**In-memory orchestrator memory**
- `backend/src/ai/orchestrator/memory.ts`
  - memory seed/initialization
  - mutation helpers and checkpoint snapshot constructors

**FSM state coordination**
- `backend/src/ai/orchestrator/stateCoordinator.ts`
  - Outer FSM states mapping to internal stage start points

**Recovery/resume scanner**
- `backend/src/orchestration/pipelineResume.ts`
  - queries DB for in-flight sessions and re-runs orchestration from persisted checkpoints

**Event fanout hub**
- `backend/src/orchestration/pipelineHub.ts`
  - local in-process EventEmitter stream (multi-socket attach support)
  - Redis Pub/Sub publish/subscribe for cross-instance event fanout

**Persistence adapter**
- `backend/src/api/persistenceAdapter.ts`
  - translates orchestration memory into DB persistence operations:
    - `saveSnapshot` / `loadSnapshot`
    - `saveCheckpoint` / `loadCheckpoints`
    - `appendEvent`
    - `saveCodeRevision`
    - `saveDeployment`

**Build + Sandbox**
- `backend/src/factory/projectFactory.ts`
  - materializes workspaces under `/tmp/workspaces/{projectId}-{revisionId}`
  - writes generated files into safe paths (scopes bare paths to frontend/)
  - creates revision patch metadata and archives sources to a stable `.tgz`

- `backend/src/workers/buildWorker.ts`
  - validates generated project structure
  - runs build/test inside Docker with workspace bind mount to `/workspace`
  - docker args enforce isolation:
    - `--network none`
    - `--security-opt no-new-privileges`
    - `--cap-drop ALL`
    - `--pids-limit 256`
  - executes:
    - frontend: install/build/test if available
    - backend: install/build/test if available
  - returns logs and build directory hints

**Deployment**
- `backend/src/agents/deploymentAgent.ts` and related deploy utilities
  - used by orchestrator deployment stage and redeploy route

**Auth**
- `backend/src/auth/authService.ts`
  - user/session/token management in PostgreSQL:
    - `users`
    - `auth_sessions`
  - project session ownership:
    - `getOrCreateActiveProjectSession`
    - `createProjectSession`
    - `isProjectOwnedByUser`
    - `touchProjectSession`

---

## 5. Data Ownership & Isolation Model

### 5.1 Project scoping
- `projectId` scopes orchestration session data, events, checkpoints, files, code revisions, deployments
- `userId` scopes ownership and authorization

### 5.2 Generated code isolation
- workspace roots:
  - materialization workspace: `/tmp/workspaces/{projectId}-{revisionId}`
  - historical note: previous code may mention `/tmp/project-{projectId}`, but current implementation uses workspace root in `projectFactory.ts`
- filesystem safety rules are enforced in:
  - `projectFactory.ts` via `assertInsideWorkspace` + path scoping
  - `buildWorker.ts` via `assertInsideProjectsRoot` and docker bind mount root checks

### 5.3 Redis usage
Redis is **optional**:
- If `REDIS_URL` unset:
  - Redis is disabled (`backend/src/cache/redis.ts`)
  - hub falls back to local in-process streaming only

Redis is intended for:
- transient “active pipeline” lock (cross-process gating)
- transient pipeline/event fanout across instances (Pub/Sub)

---

## 6. DB Schema (as implemented)

Core tables are created in:
- `backend/src/db/schema.ts`

### 6.1 auth
- `users`
- `auth_sessions`

### 6.2 project control plane persistence
- `project_sessions`
  - orchestration state snapshot fields (`requirements`, `clarifications`, `confirmation`, `system_design`, `ui_spec`, `structured_spec`, `blueprint`, `code_gen`, `test_result`, `deployment`)
  - `status`, `current_step`, `progress`, `active_revision_id`, `task_queue`, `terminal_logs`, etc.

- `project_blackboards`
  - stores a JSON `state` used as a current-stage board

- `project_tasks`
  - present but orchestration currently primarily uses stage orchestration + checkpoints

- `project_events`
  - append-only event log for WebSocket replay + auditing

- `project_checkpoints`
  - durable per-stage checkpoints including:
    - `context_snapshot` (serialized full memory slice)
    - `fsm_state`
    - `input_hash`, `output`, `issues`, `retry_count`

- `project_code_revisions`
  - metadata to support redeploy:
    - `workspace_path`
    - `source_hash`
    - `patch_path`, patch application metadata
    - generation payload

- `project_deployments`
  - provider URLs and identifiers plus raw payload

---

## 7. Orchestration Design (Control Flow)

### 7.1 Stages (internal orchestration states)
Defined in:
- `backend/src/ai/contracts/orchestration.ts` as `OrchestrationState`

Stages used by `backend/src/ai/orchestrator/orchestrator.ts`:
- `requirements`
- `clarification`
- `confirmation`
- `system_design`
- `ui_spec`
- `blueprint`
- `execution_plan`
- `code_generation`
- `testing`
- `deployment`
- `modification`
- `done`
- `failed`

### 7.2 Outer FSM states (for resume grouping)
Defined in:
- `backend/src/ai/contracts/orchestration.ts` as `OrchestrationFsmState`
and mapped in:
- `backend/src/ai/orchestrator/stateCoordinator.ts`

### 7.3 Durable checkpoint strategy (Phase 1)
`backend/src/ai/orchestrator/orchestrator.ts` uses:
- `createCheckpointSnapshot` in `backend/src/ai/orchestrator/memory.ts`
  - attempts to store `contextSnapshot` = serialized full memory slice
- `persistence.saveCheckpoint(...)` from `backend/src/api/persistenceAdapter.ts`
- checkpoint calls occur:
  - after stage completion
  - on error paths
  - on pause/finalizePartial (clarification/confirmation)

### 7.4 Event audit strategy
Events are persisted into `project_events`:
- `backend/src/api/persistenceAdapter.ts` → `appendEvent` → `backend/src/db/projectStore.ts` (`appendProjectEvent`)
- WS hub also streams live events to all subscribers:
  - `backend/src/orchestration/pipelineHub.ts`

---

## 8. WebSocket Contracts (Live Stream)

### 8.1 Event types
`backend/src/ai/contracts/orchestration.ts` defines `OrchestrationEmitEvent`.

Live WS stream may include:
- `progress`
- `stage_start`
- `stage_complete`
- `stage_error`
- `info`
- `clarification_request` (questions array)
- `confirmation_request` (summary payload)
- `file_generated` (path/lines/bytes)
- `done`
- `failed`
- (also: `pong`/`ping` are application heartbeat frames)

### 8.2 WS connection lifecycle
In `backend/src/api/socket.ts`:
1. origin validation
2. cookie parse → session token verification
3. determine correct `projectId`:
   - if client supplies query projectId, ownership checked
   - otherwise use active session
4. subscribe to `pipelineHub.subscribe(projectId, listener)`
5. send an initial `info` message
6. if pipeline is already active:
   - send `info` with `stage: resume`

### 8.3 Acquire/resume behavior
- socket checks whether a pipeline is already active via hub lock
- if active:
  - do not start a duplicate pipeline; stream live events instead
- if not active:
  - `pipelineHub.tryAcquire(projectId)`
  - run orchestrator
  - `pipelineHub.release(projectId)` in finally

---

## 9. Redis Pub/Sub (Cross-instance Hub Fanout)

### 9.1 Implementation
`backend/src/orchestration/pipelineHub.ts`:
- local stream:
  - each `projectId` maps to an in-process `EventEmitter`
- Redis Pub/Sub:
  - channel name: `pipeline:events:{projectId}`
- publishing:
  - `pipelineHub.publish(projectId, event)` emits locally and publishes to Redis
- subscribing:
  - the first local subscriber triggers:
    - creation of a Redis subscriber
    - `SUBSCRIBE pipeline:events:{projectId}`
    - for each message:
      - parse JSON payload into `OrchestrationEmitEvent`
      - emit into local emitter

### 9.2 Failure mode
If Redis is disabled/unavailable:
- hub still works for a single instance (local emitter only)
- cross-instance fanout will not work

---

## 10. Recovery & Resume (Crash Resilience)

### 10.1 Startup resume scan
`backend/src/orchestration/pipelineResume.ts`:
- reads sessions where status is `active`/`recovering` and current step is non-interactive
- uses `pipelineHub.forceAcquire(projectId)`
- calls `runAIOrchestration` with:
  - `step` from latest checkpoint / DB
  - `recoveryContextSnapshot` from checkpoint context snapshot
  - `recoveryFsmState` from checkpoint `fsm_state`

### 10.2 Checkpoint short-circuit
In `backend/src/ai/orchestrator/orchestrator.ts` → `stageWrap()`:
- computes `inputHash` from stage + input + memory identifiers
- if a checkpoint exists with same stage and inputHash and output exists:
  - returns success immediately (resume)
- otherwise continues execution.

---

## 11. Token Budget & Loop Protection

### 11.1 Budget controller
- `backend/src/utils/tokenBudget.ts` implements in-memory budget map per `projectId`
- `backend/src/agents/llmProxyClient.ts`
  - enforces budget per call via `enforceBudgetOrThrow(projectId, max_tokens)`
- orchestrator error handling:
  - if error message is `"Budget Exceeded"`, orchestrator:
    - persists a checkpoint (best-effort)
    - returns a `failed` StageResult (deterministic terminal failure)

### 11.2 Circuit breaker
- `backend/src/agents/testFixAgent.ts`
  - loops bounded by max attempts and staging checks

---

## 12. Execution Isolation: Sandbox / Build Worker

### 12.1 Workspace materialization
`backend/src/factory/projectFactory.ts`:
- creates unique workspace root:
  - `/tmp/workspaces/{sanitizedProjectId}-{revisionId}`
- copies a valid starter template into workspace root
- writes generated files:
  - `scopeGeneratedPath()` ensures bare paths land under `frontend/`
  - prevents writing `..` or forbidden segments
- legacy normalization:
  - ensures TypeScript-only backend expected by build worker pre-validation

### 12.2 Docker build/test execution
`backend/src/workers/buildWorker.ts`:
- validates generated project required file presence
- runs commands through `docker run`:
  - bind mounts workspaceRoot into `/workspace`
  - runs `npm install`/`npm run build`/`npm test` where scripts exist
  - enforces timeout (hard kill)
  - streams stdout/stderr chunks via callback

### 12.3 Filesystem boundary rules
- buildWorker refuses to operate outside `/tmp` parent
- buildWorker refuses writing outside workspaceRoot
- docker container cannot access other host paths except bind-mounted `/workspace`

---

## 13. Deployment Model

Deployment is stage-driven in orchestrator:
- `backend/src/ai/orchestrator/orchestrator.ts` → `deployment` stage
- `backend/src/api/projectRoutes.ts` also provides `/redeploy`

### 13.1 Revision archive strategy
`projectFactory.ts` archives the workspace snapshot as:
- `workspaceRoot/{revisionId}.tgz`

`project_code_revisions` stores metadata enabling redeploy.

---

## 14. HTTP API Contracts (Snapshot + Replay + Files)

### 14.1 Project snapshot endpoint
`GET /api/projects/:projectId/snapshot`
Implemented in:
- `backend/src/api/projectRoutes.ts`

Response shape:
- `projectId`
- `status` (from `project_sessions.status`)
- `currentStep` (`project_sessions.current_step`)
- `progress`
- `activeAgent` (derived)
- `files` (materialized file content derived from `file_generated` events)
- `lastEventId` (latest event id in `project_events`)

Auth:
- requires valid session cookie (`requireUser`)

### 14.2 Event replay endpoint
`GET /api/projects/:projectId/events`
Implemented in:
- `backend/src/api/projectRoutes.ts`

Uses:
- `getProjectEvents` or cursor-based `getProjectEventsAfterEventId`

Contract:
- deterministic ordering by `(created_at, id)`

Auth:
- requires valid session cookie

### 14.3 File content endpoint
`GET /api/projects/:projectId/files?path=...`
- prefers latest `file_generated` event payload
- fallback to `code_gen` stored in snapshot

---

## 15. Frontend Hydration / Reconnection Contracts

Implemented in:
- `frontend/src/components/ChatWorkspace.jsx`

### 15.1 Reconnect algorithm
1. reset local state
2. call snapshot endpoint:
   - `/api/projects/:projectId/snapshot`
3. render coarse UI state:
   - status, progress, currentStep
4. replay only the tail:
   - `/api/projects/:projectId/events?afterEventId={snapshot.lastEventId}&limit=1000`
5. upsert generated files from `file_generated` events in tail
6. dedupe messages by `(role, text)`

This ensures:
- no missing messages
- no duplicated messages after reconnect

---

## 16. Error Handling, Self-Heal & Recovery

### 16.1 Error classification
`backend/src/ai/orchestrator/errorClassifier.ts`
maps errors into:
- parsing/schema/semantic/build/deployment/state transition/auth/etc.

### 16.2 Recovery strategies
`backend/src/ai/orchestrator/recovery.ts`:
- defines `retry`, `repair`, `ask_user`, `fallback`, `skip`

`backend/src/ai/orchestrator/orchestrator.ts` applies:
- ask user:
  - produces `needs_input` / `needs_fix` and pauses (confirmation/clarification gates)
- repair:
  - re-enters relevant stage
- Budget Exceeded:
  - deterministic terminal failure

### 16.3 Blueprint/codegen self-heal
Orchestrator replays:
- system_design / ui_spec with injected hints when blueprint fails due to structural mismatches
bounded by `maxDesignFeedbackLoops`

---

## 17. Configuration, Security & Threat Model

### 17.1 WebSocket origin allowlist
- `WS_ALLOWED_ORIGINS` in `backend/src/config/env.ts`

### 17.2 Auth cookie model
- HttpOnly cookie `sid`
- token hashed in DB (`authService.ts`)
- revoked sessions are rejected

### 17.3 Input sanitization
- sanitize strips HTML tags, script tags, JS URL schemes
- message size capped at 10KB

### 17.4 Fail-closed rules for safety
- workspace writes restricted to `/tmp/...` and validated path scoping
- never ship raw huge `output` frames over WS for code generation; code is streamed as `file_generated` events

---

## 18. Known Critical Integration Points (LLD Review Checklist)

A reviewer should inspect these boundaries carefully:

1. **WebSocket**: `socket.ts` → `pipelineHub` subscription and event sending
2. **Hub fanout**: `pipelineHub.ts` local emitter + Redis channel wiring
3. **Durability**: `orchestrator.ts` checkpoint snapshot creation + `persistenceAdapter.ts` save/load
4. **Replay**: `projectRoutes.ts` snapshot/events order + frontend replay cursor semantics
5. **Build isolation**: `projectFactory.ts` path scoping + `buildWorker.ts` docker sandbox args
6. **Consistency**: `projectConsistency.ts` report + self-heal repair patterns
7. **Auth gating**: `requireUser` for snapshot/events/files endpoints

---

## 19. Final Summary / Invariants

The system enforces:

- base app (control plane) remains immutable during generation
- generated projects are ephemeral and project-scoped
- persistence is audit-friendly:
  - checkpoint snapshots for resume
  - append-only event log for replay
- frontend reconnect is snapshot-first and tail replay by `lastEventId`
- build/test runs in a Docker-sandboxed environment
- cross-instance streaming works via Redis Pub/Sub fanout (when Redis configured)
- budget/loop protections prevent runaway orchestration
