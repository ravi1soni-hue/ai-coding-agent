%% LLD Diagram — AI Autonomous Website Builder (current codebase)
%% Format: Mermaid
%% Coverage: runtime modules/files, APIs, WS contracts, orchestration FSM+stages,
%% persistence + DB tables/columns, hub fanout (local + Redis stream), resume logic,
%% build sandbox isolation, deployment, frontend snapshot/replay, and config/security.

flowchart TB

  %% =========================
  %% 1) External actors
  %% =========================
  U[User] -->|HTTP + WebSocket| FE[Frontend (React / Vite)]
  FE -->|HTTPS/Fetch| BEHTTP[Backend HTTP API (Fastify)]
  FE -->|WebSocket Frames| BEWS[Backend WS Gateway (ws)]

  %% =========================
  %% 2) Frontend responsibilities
  %% =========================
  subgraph FE_S[Frontend components & behavior]
    direction TB
    FE1[frontend/src/components/ChatWorkspace.jsx\n- WS connect/reconnect\n- Snapshot-first reconnect\n- Tail replay (afterEventId)\n- File upsert UI]
  end

  FEHTTP -->|/api/projects/:projectId/snapshot| SNAP[Snapshot endpoint consumer]
  FEHTTP -->|/api/projects/:projectId/events?afterEventId&limit=1000| REPLAY[Replay endpoint consumer]
  FEHTTP -->|/api/projects/:projectId/files?path=...| FILES[File viewer consumer]

  %% =========================
  %% 3) Backend surface: bootstrap, HTTP, WS
  %% =========================
  subgraph BE_S[Backend (Node.js + TypeScript)]
    direction TB

    subgraph BOOT[Server bootstrap]
      direction TB
      IDX[backend/src/index.ts\n- connectRedis()\n- connectPostgres()\n- ensureCoreTables() + ensureVectorTable()\n- serve frontend/dist\n- registerRoutes()\n- createSocketServer()\n- resumeInFlightPipelines() on boot]
      ENV[backend/src/config/env.ts\nLoads .env & config validation]
    end

    subgraph HTTP[HTTP API layer]
      direction TB
      ROUTES[backend/src/api/routes.ts\nregisterAuthRoutes + registerProjectRoutes]
      PROJ[backend/src/api/projectRoutes.ts\nRoutes for sessions/events/snapshots/files/redeploy]
      MW[backend/src/api/middleware.ts\nrequireUser auth gate]
      AUTH[backend/src/api/authRoutes.ts\n(not in snippet, but registered)]
    end

    subgraph WS[WebSocket gateway]
      direction TB
      SOCKET[backend/src/api/socket.ts\n- origin allowlist\n- cookie auth (sid)\n- per-project pipeline subscription\n- sanitization + rate limit\n- message parsing -> OrchestrationCommand\n- runAIOrchestration() -> publish events]
      HUB[backend/src/orchestration/pipelineHub.ts\nEventEmitter + Redis stream fanout + acquire/release lock]
      PERSIST_ADAPTER_FACTORY[backend/src/api/persistenceAdapter.ts\nadapter: saveSnapshot/loadSnapshot/appendEvent/checkpoints/code revisions/deployment]
    end

    %% Bootstrap ties into HTTP+WS
    IDX --> ROUTES
    IDX --> HTTP
    IDX --> SOCKET
    ENV --> IDX
  end

  %% =========================
  %% 4) Auth + session ownership model
  %% =========================
  subgraph AUTH_S[Authentication & authorization]
    direction TB
    AUTH_SVC[backend/src/auth/authService.ts\n- users table create/auth\n- auth_sessions token hashing\n- getUserFromSessionToken(sid)\n- project ownership checks\n- getOrCreateActiveProjectSession()\n- touchProjectSession()]
    USERS[(Postgres: users\nid, name, email, password_hash, created_at)]
    SESS[(Postgres: auth_sessions\nid, user_id, token_hash, ip_address, user_agent,\ncreated_at, expires_at, revoked_at)]
    PROJ_SESS[(Postgres: project_sessions\nid, user_id, status, current_step, progress,\nactive_revision_id, revision_lock_owner, revision_lock_expires_at,\nrequirements/clarifications/confirmation/system_design/ui_spec/structured_spec/blueprint/task_queue/terminal_logs/code_gen/test_result/deployment,\ncreated_at, last_active_at)]
  end

  AUTH_SVC --> USERS
  AUTH_SVC --> SESS
  AUTH_SVC --> PROJ_SESS

  %% =========================
  %% 5) Orchestration engine
  %% =========================
  subgraph ORCH_S[Orchestration engine]
    direction TB

    ORCH[backend/src/ai/orchestrator/orchestrator.ts\nrunAIOrchestration(command, adapter, persistence)\n- stageWrap() checkpoint cache short-circuit\n- retry/repair/fallback/ask_user\n- budget controller & timeouts\n- orchestrator stages pipeline\n- emits OrchestrationEmitEvent]
    MEM[backend/src/ai/orchestrator/memory.ts\ncreateInitialMemory/markStage/createCheckpointSnapshot\n- checkpoint strategy (stage/inputHash/issues/fsmState)\n- history/events pruning]
    COORD[backend/src/ai/orchestrator/stateCoordinator.ts\nouter FSM mapping for resume grouping]
    RECOVER[backend/src/orchestration/pipelineResume.ts\nresumeInFlightPipelines() on boot\n- janitor cleanup under /tmp/workspaces\n- findInFlightProjects()\n- forceAcquire()\n- runAIOrchestration() with checkpoint context & fsm_state]
    STATE_MACHINE[backend/src/orchestration/pipelineStateMachine.ts\nresolveRecoveryRoute/normalizePipelineStage/stageIndex/isValidTransition]
    ERR_CLASS[backend/src/ai/orchestrator/errorClassifier.ts\nclassifyError() -> OrchestrationIssue]
    REC_STRATS[backend/src/ai/orchestrator/recovery.ts\ndecideRecoveryAction()/retry/repair/ask_user/fallback/skip]
    AGENTS[Agents\n- requirementAnalysisAgent\n- clarificationAgent\n- systemDesignAgent\n- uiSpecAgent\n- blueprintAgent\n- codeGenerationAgent\n- testFixAgent\n- deploymentAgent\n- reviewerAgent]
    PLAN[backend/src/ai/orchestrator/executionPlan.ts\nbuildExecutionPlan() fileOrder + dependencyGraph]
    LANGGRAPH[backend/src/orchestration/langgraph.ts\n(if used by agents; present in repo)]
    BUDGET[backend/src/utils/tokenBudget.ts\ninitBudget(projectId, maxTokens)\nenforceBudgetOrThrow(projectId, max_tokens)\nBudget Exceeded -> deterministic failed]
    TIMEOUT[backend/src/utils/timeout.ts\nwithTimeout() global orchestration caps]
  end

  SOCKET -->|build OrchestrationCommand| ORCH
  RECOVER -->|boot resume -> OrchestrationCommand| ORCH
  ORCH --> MEM
  ORCH --> COORD
  ORCH --> STATE_MACHINE
  ORCH --> ERR_CLASS
  ORCH --> REC_STRATS
  ORCH --> PLAN
  ORCH --> AGENTS
  ORCH --> BUDGET
  ORCH --> TIMEOUT
  ORCH -->|checkpoint cache -> persistence Adapter| PERSIST_ADAPTER_FACTORY

  %% =========================
  %% 6) Orchestration stages (internal states)
  %% =========================
  subgraph STAGES[Internal orchestration states (OrchestrationState)]
    direction LR
    S1[requirements]
    S2[clarification]
    S3[confirmation]
    S4[system_design]
    S5[ui_spec]
    S6[blueprint]
    S7[execution_plan]
    S8[code_generation]
    S9[testing]
    S10[deployment]
    S11[modification]
    SDONE[done]
    SFAIL[failed]
  end

  %% Outer FSM grouping (resume)
  subgraph OUTER_FSM[Outer FSM (OrchestrationFsmState)]
    direction TB
    O1[IDLE]
    O2[ANALYZING]
    O3[CLARIFYING]
    O4[DESIGNING]
    O5[CODING]
    O6[TESTING]
    O7[DEPLOYING]
    OFA[FAILED]
    OCO[COMPLETED]
  end

  COORD --> OUTER_FSM

  %% Stage flow
  S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8 --> S9 --> S10 --> SDONE
  SDONE -->|modification request| S11 --> S6
  S10 --> SFAIL

  %% =========================
  %% 7) Hub: acquire/resume + fanout
  %% =========================
  subgraph HUB_S[Event fanout + locking]
    direction TB

    subgraph ACQ[Acquire / lock]
      direction LR
      ACTIVE_KEY[Local activeKey: pipeline:active:{projectId}\n(using TTL)\n- pipelineHub.isActive()\n- pipelineHub.tryAcquire()\n- pipelineHub.forceAcquire() for resume]
      REDIS_LOCK[Redis lock key\n(activeKey(projectId))]
      LOCAL_LOCK[(In-process localActive Map\nprojectId -> expiry)]
    end

    subgraph FANOUT[Fanout]
      direction TB
      EM[Local EventEmitter\nper projectId]
      SUB[WS subscribers attach via pipelineHub.subscribe(projectId, listener)]
      PUB[Publish: pipelineHub.publish(projectId, event)\n- emit locally\n- xadd to Redis stream]
      REDIS_STREAM[Redis Streams\nchannel: pipeline:stream:{projectId}\nxread with persisted cursor pipeline:cursor:{projectId}]
      INSTANCE_TAG[INSTANCE_ID tag\nrandomBytes(8)\nprevents double-delivery]
    end

    ACTIVE_KEY <--> LOCAL_LOCK
    ACTIVE_KEY <--> REDIS_LOCK
    PUB --> EM
    PUB --> REDIS_STREAM
    REDIS_STREAM -->|xread -> JSON parse -> em.emit('event')| EM
    SUB --> EM
    SOCKET -->|subscribe| SUB
    ORCH -->|emit| PUB
  end

  %% =========================
  %% 8) Persistence adapter + durability/replay model
  %% =========================
  subgraph PERSIST_S[Persistence adapter + durability]
    direction TB

    ADP[backend/src/api/persistenceAdapter.ts\n- saveSnapshot/loadSnapshot\n- appendEvent\n- saveCodeRevision\n- saveDeployment\n- saveCheckpoint/loadCheckpoints]
    STORE[backend/src/db/projectStore.ts\n(projectStore ops used by adapter)]
    EVENT_TBL[(Postgres: project_events\nid, project_id, user_id,\nevent_type, role, message, payload, created_at)]
    SNAP_TBL[(Postgres: project_sessions\n(updated snapshot fields per stage)\n+ blackboard state)]
    BLACKBOARD[(Postgres: project_blackboards\nid, project_id, user_id, state JSONB, created_at, updated_at)]
    CP_TBL[(Postgres: project_checkpoints\nid, project_id, user_id,\nstage, input_hash, output JSONB (trimmed),\nissues JSONB, retry_count,\ncreated_at, updated_at,\nUNIQUE(project_id, stage, input_hash)\n+ context_snapshot JSONB\n+ fsm_state TEXT)]
    REV_TBL[(Postgres: project_code_revisions\nid, project_id, user_id,\nworkspace_path, source_archive_path,\nsource_hash, patch_path,\npatch_applied, patch_apply_log,\ngeneration_payload JSONB)]
    DEP_TBL[(Postgres: project_deployments\nid, project_id, user_id,\nfrontend_url, backend_url,\nvercel_* fields,\nrailway_* fields,\nraw_payload JSONB,\ncode_revision_id, source_archive_path, source_hash)]
    SAVE_LOGS[terminal_logs JSONB in project_sessions\n(used for snapshot/progress UI)]
  end

  ORCH --> ADP
  ADP --> STORE
  ADP --> EVENT_TBL
  ADP --> SNAP_TBL
  ADP --> BLACKBOARD
  ADP --> CP_TBL
  ADP --> REV_TBL
  ADP --> DEP_TBL
  ADP --> SAVE_LOGS

  %% Checkpoint persistence rules
  subgraph CK_RULES[Checkpoint output size & stage rules]
    direction TB
    NOTE1[saveCheckpoint(): for stage 'code_generation'\noutput persisted as NULL (mitigation)\nEvent stream persists file bodies via file_generated payload only]
    NOTE2[stageWrap(): inputHash = hashInput({stage,input,projectId})\ncheckpoint short-circuit if cached.output exists\nthen markStage(memory, stage)]
    NOTE3[finalizePartial(): persists checkpoint snapshot so recovery can rehydrate outer context]
  end

  ADP --> CK_RULES

  %% =========================
  %% 9) Frontend reconnect protocol (snapshot-first)
  %% =========================
  subgraph FRONT_RECON[Frontend reconnect: snapshot-first + tail replay]
    direction TB
    STEP1[GET /api/projects/:projectId/snapshot\n-> status/currentStep/progress/activeAgent/files/lastEventId]
    STEP2[GET /api/projects/:projectId/events?afterEventId={lastEventId}&limit=1000\n-> tail events]
    STEP3[Upsert file_generated tail files into generatedFiles state]
    STEP4[Deduplicate chat messages by (role,text)]
  end

  FE1 --> STEP1 --> STEP2 --> STEP3 --> STEP4

  %% =========================
  %% 10) HTTP endpoints contracts (explicit paths)
  %% =========================
  subgraph HTTP_CONTRACTS[HTTP routes (projectRoutes.ts)]
    direction TB
    H1[GET /health\n-> {status:'ok'}]
    H2[GET /api/projects/current\n-> {projectId}\n(creates/returns active session)]
    H3[POST /api/projects/new\n-> {projectId}]
    H4[GET /api/projects/history\n-> {projects}]
    H5[POST /api/projects/select\n-> {projectId}\n(ownership check + touchProjectSession)]
    H6[GET /api/projects/:projectId/events\nQuery:\nafterEventId (optional), limit (optional)\n-> {events[]}\nOrdered: (created_at,id)]
    H7[GET /api/projects/:projectId/snapshot\n-> {projectId,status,currentStep,progress,activeAgent,files[],lastEventId}]\n
    H8[GET /api/projects/:projectId/files\nQuery: path\n-> {path,content,lines?,bytes?}\n- Prefer latest file_generated payload\n- Fallback: snapshot.code_gen.files]
    H9[POST /api/projects/:projectId/redeploy\n-> {deployment}\n- runBuildWorker on latest code revision\n- deploymentAgent writes project_deployments]
    LEG[Legacy job endpoints:\nPOST /job,\nPOST /confirm-project,\nGET /deployment-status/:sessionId]
  end

  HTTP_CONTRACTS --> MW
  BEHTTP --> HTTP_CONTRACTS

  %% =========================
  %% 11) Build/Test + isolation boundaries
  %% =========================
  subgraph BUILD_S[Build + Sandbox]
    direction TB

    FACTORY[backend/src/factory/projectFactory.ts\n- materializeProjectWorkspace(projectId, codeGen, backendRequired)\n- workspace root: /tmp/workspaces/{projectSegment}-{revisionId}\n- scopeGeneratedPath() -> bare paths map to frontend/\n- path safety: assertInsideWorkspace()\n- archive: {revisionId}.tgz with snapshotDir\n- writes patch diff apply log]
    DOCKER[backend/src/workers/buildWorker.ts\nrunBuildWorker({workspaceRoot|workspaceDir, onLog, deadlineAt})\n- validateGeneratedProject()\n- clean stale dist/\n- installDependencies:\n  npm ci/install on host (network needed)\n- typecheck (tsc --noEmit)\n- build/test:\n  Docker sandbox per-command with:\n    --network none\n    --security-opt no-new-privileges\n    --cap-drop ALL\n    --pids-limit 256\n    bind mount mountRoot:/workspace\n- fallback: if docker unavailable => host build/test]
    CLEANUP[cleanupWorkspace(workspaceRoot)\nrm -rf under /tmp (defense in depth)]
  end

  ORCH -->|code_generation -> materializeProjectWorkspace| FACTORY
  ORCH -->|testing -> runBuildWorker| DOCKER
  ORCH -->|deployment stage uses deploymentAgent with build outputs| DOCKER
  DOCKER --> CLEANUP

  %% =========================
  %% 12) Deployment model
  %% =========================
  subgraph DEPLOY_S[Deployment]
    direction TB
    DEPLOY_AGENT[backend/src/agents/deploymentAgent.ts\n- uses build outputs\n- Vercel + Railway deploys\n- returns URLs and IDs]
    SAVE_DEPLOY[saveProjectDeployment(...) via persistenceAdapter]
    REDEPLOY_ROUTE[POST /api/projects/:projectId/redeploy\n-> rebuild + redeploy using latest project_code_revisions]
  end

  ORCH --> DEPLOY_AGENT
  ORCH --> SAVE_DEPLOY
  BEHTTP --> REDEPLOY_ROUTE

  %% =========================
  %% 13) Configuration/env & security invariants
  %% =========================
  subgraph CFGSEC[Configuration, security & threat model]
    direction TB

    ENVV[backend/src/config/env.ts\nvalidated config]
    SEC_WS[WS origin allowlist\nWS_ALLOWED_ORIGINS (comma separated)\nif set -> fail-close on origin mismatch]
    SEC_COOKIE[Auth cookie model\ncookie name: sid\n- HttpOnly, SameSite=Lax\n- token is hashed in auth_sessions\n- revoked sessions rejected\n- expiration enforced]
    SEC_SANITIZE[Input sanitization in WS gateway\n- strip HTML tags\n- remove script tags\n- remove javascript: URLs\n- strip ../ to reduce path traversal in prompt injection context\n- cap size 10KB]
    SEC_FS[Filesystem safety\nprojectFactory.ts:\n- assertInsideWorkspace(workspaceRoot,target)\n- deny '..', absolute, templates/*\nbuildWorker.ts:\n- assertInsideProjectsRoot('/tmp' boundary)\n- container bind mount only /workspace]
    SEC_DOCKER[Docker security options\n--network none\nno-new-privileges\ncap-drop ALL\npids-limit 256]
    LIMITS[MAX LIMITS from env.ts\nLIMITS:\n- maxRetriesPerStage (default 2)\n- maxBuildAttempts (default 2)\n- maxTokensPerProject (default 1000000)\n- maxOrchestrationMs (default 1200000ms)\nBudget Exceeded => deterministic failed]
    MODEL_ROUTER[backend/src/agents/modelRouter.ts\nSelects model+apiKey per task\n(env variables: GPT4O/GPT5*/EMBEDDING slugs + legacy *_MODEL_ID fallbacks)]
  end

  ENVV --> SEC_WS
  ENVV --> SEC_COOKIE
  ENVV --> LIMITS
  SOCKET --> SEC_SANITIZE
  FACTORY --> SEC_FS
  DOCKER --> SEC_DOCKER
  SOCKET --> SEC_WS
  SOCKET --> SEC_COOKIE
  AGENTS --> MODEL_ROUTER

  %% =========================
  %% 14) Event types / WS contracts
  %% =========================
  subgraph WS_CONTRACTS[WebSocket event types (OrchestrationEmitEvent)]
    direction TB
    T1[progress {stage, percent?, message?}]
    T2[stage_start {stage, message?}]
    T3[stage_complete {stage, output? (trimmed for WS)}]
    T4[stage_error {stage, issue}]
    T5[stream {stage, token}] (internal; token streaming)
    T6[info {stage, message}]
    T7[clarification_request {stage, questions[]}]
    T8[confirmation_request {stage, summary}]
    T9[file_generated {stage, filePath, lines?, bytes?}]
    T10[done {projectId, frontendUrl?, backendUrl?}]
    T11[failed {projectId, issues[]}]
    TS_PING[pong/ping application heartbeat (client sends {type:'ping'})]
  end

  ORCH -->|emit events| WS_CONTRACTS
  SOCKET -->|ws.send(JSON.stringify(event))| WS_CONTRACTS
  FE1 -->|onmessage switch payload.type| WS_CONTRACTS

  %% =========================
  %% 15) End-to-end control flow (high-level)
  %% =========================
  subgraph E2E[End-to-end request flow]
    direction TB

    FLOW1[Client sends prompt via WS:\n{user_message or raw text}]
    FLOW2[WS server:\n- rate limit\n- sanitize\n- loadSnapshot\n- infer command shape\n- tryAcquire(projectId)\n- appendProjectEvent(user_message)]
    FLOW3[runAIOrchestration():\n- stageWrap per stage\n- emit WS stage_* + file_generated\n- persist snapshot/events/checkpoints]
    FLOW4[projectRoutes:\nREST snapshot/events used by reconnect]
    FLOW5[Frontend renders:\n- snapshot UI state\n- replay tail events\n- dedupe messages\n- show files]
  end

  FE --> FLOW1 --> BEWS
  BEWS --> FLOW2 --> ORCH --> FLOW3 --> EVENT_TBL
  FEHTTP --> FLOW4 --> BEHTTP
  FE --> FLOW5

  %% =========================
  %% 16) Notes (observed important invariants)
  %% =========================
  subgraph INVARIANTS[Key invariants & known behavior]
    direction TB
    I1[Checkpoint identity uses (projectId + stage + input)\n(sessionId intentionally excluded to survive restart)]
    I2[Frontend snapshot-first prevents message duplication/loss\n(sends only tail after lastEventId)]
    I3[WS hub acquire prevents duplicate pipelines\nbut reconnect clients attach to hub stream]
    I4[code_generation WS payload kept small:\ncontent is streamed via file_generated events;\nstage_complete output is trimmed]
    I5[Recovery ignores interactive gates:\nresumeInFlightPipelines skips clarification/confirmation\n(requires user input) and resumes non-interactive stages.]
  end
  ORCH --> INVARIANTS
  SOCKET --> INVARIANTS
  FE1 --> INVARIANTS
