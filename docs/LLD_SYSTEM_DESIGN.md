# Low-Level Design (LLD) — AI Autonomous Website Builder

## 1. Purpose

This document describes the runtime architecture, data flow, orchestration model, storage model, deployment model, and safety boundaries of the AI autonomous website builder.

It is intended to provide a complete implementation-level view of the system, including:
- total runtime components
- how components communicate
- what data each component owns or consumes
- how generated projects remain isolated from the base app
- how the system self-heals and resumes after failures

---

## 2. System Summary

The platform is a session-driven AI orchestration system that converts a user request into a deployable web application.

The system has two isolated domains:

1. **Base App**
   - permanent control plane
   - runs socket server, orchestration, agents, persistence, deployment, validation
   - must remain immutable during generated project creation

2. **Generated Project**
   - per-session ephemeral output
   - exists in memory first
   - may be materialized under `/tmp/project-{projectId}`
   - destroyed after deployment

The base app never stores generated source code inside its own repository tree.

---

## 3. Fixed Stack

### Frontend stack
- React 18
- Vite
- JavaScript / JSX

### Backend stack
- Node.js
- TypeScript
- Express for generated backend services
- PostgreSQL for persistent multi-tenant data
- Redis for transient state only

### Deployment targets
- Frontend: Vercel
- Backend: Railway

---

## 4. Top-Level Runtime Architecture

The system is organized into the following major subsystems:

1. **Client UI**
2. **WebSocket Gateway**
3. **HTTP API Layer**
4. **Authentication Layer**
5. **Orchestration Engine**
6. **Agent Layer**
7. **Workspace Materializer**
8. **Build Worker**
9. **Deployment Layer**
10. **Persistence Layer**
11. **Redis Transient State**
12. **Template / Scaffold Layer**
13. **Logging / Error Handling / Recovery**
14. **State Machine / Session Controller**

---

## 5. Component Inventory

This section lists the total major components and their responsibilities.

### 5.1 Frontend components
- `frontend/src/App.jsx`
- `frontend/src/components/AuthPage.jsx`
- `frontend/src/components/ChatWorkspace.jsx`
- `frontend/src/components/ProjectHistory.jsx`
- `frontend/src/main.jsx`
- `frontend/src/styles.css`
- `frontend/src/utils/helpers.js`

### 5.2 Backend control-plane components
- `backend/src/index.ts`
- `backend/src/api/server.ts`
- `backend/src/api/routes.ts`
- `backend/src/api/socket.ts`
- `backend/src/api/projectRoutes.ts`
- `backend/src/api/authRoutes.ts`
- `backend/src/api/frontendProxy.ts`
- `backend/src/api/middleware.ts`

### 5.3 Handlers
- `backend/src/api/handlers/requirementAnalysisHandler.ts`
- `backend/src/api/handlers/clarificationHandler.ts`
- `backend/src/api/handlers/confirmationHandler.ts`
- `backend/src/api/handlers/systemDesignHandler.ts`
- `backend/src/api/handlers/uiSpecHandler.ts`
- `backend/src/api/handlers/blueprintHandler.ts`
- `backend/src/api/handlers/codeGenerationHandler.ts`
- `backend/src/api/handlers/testFixHandler.ts`
- `backend/src/api/handlers/deploymentHandler.ts`

### 5.4 AI orchestration layer
- `backend/src/ai/index.ts`
- `backend/src/ai/contracts/orchestration.ts`
- `backend/src/ai/orchestrator/orchestrator.ts`
- `backend/src/ai/orchestrator/memory.ts`
- `backend/src/ai/orchestrator/errorClassifier.ts`
- `backend/src/ai/orchestrator/executionPlan.ts`
- `backend/src/ai/orchestrator/recovery.ts`

### 5.5 Pipeline / flow control
- `backend/src/orchestration/pipelineStateMachine.ts`
- `backend/src/orchestration/langgraph.ts`

### 5.6 Agents
- `backend/src/agents/requirementAnalysisAgent.ts`
- `backend/src/agents/clarificationAgent.ts`
- `backend/src/agents/confirmationGate.ts`
- `backend/src/agents/systemDesignAgent.ts`
- `backend/src/agents/uiSpecAgent.ts`
- `backend/src/agents/blueprintAgent.ts`
- `backend/src/agents/codeGenerationAgent.ts`
- `backend/src/agents/testFixAgent.ts`
- `backend/src/agents/deploymentAgent.ts`
- `backend/src/agents/reviewerAgent.ts`
- `backend/src/agents/projectSpec.ts`
- `backend/src/agents/projectConsistency.ts`
- `backend/src/agents/structuredSpec.ts`
- `backend/src/agents/blueprintContract.ts`
- `backend/src/agents/modelRouter.ts`
- `backend/src/agents/llmProxyClient.ts`
- `backend/src/agents/vercelDeploy.ts`

### 5.7 Workspace / build / deploy
- `backend/src/factory/projectFactory.ts`
- `backend/src/workers/buildWorker.ts`
- `backend/src/deploy/railwayDeploy.ts`
- `backend/src/tools/fsTools.ts`

### 5.8 Persistence and infra
- `backend/src/db/database.ts`
- `backend/src/db/postgres.ts`
- `backend/src/db/schema.ts`
- `backend/src/db/projectStore.ts`
- `backend/src/db/auditLog.ts`
- `backend/src/db/vectorStore.ts`
- `backend/src/auth/authService.ts`
- `backend/src/cache/redis.ts`
- `backend/src/jobs/jobQueue.ts`
- `backend/src/config/env.ts`
- `backend/src/utils/logger.ts`
- `backend/src/utils/errors.ts`
- `backend/src/utils/timeout.ts`
- `backend/src/utils/ttlSet.ts`

### 5.9 Templates
- `backend/src/templates/frontend/*`
- `backend/src/templates/backend/*`

---

## 6. Architectural Boundaries

## 6.1 Base app boundary
The base app is the immutable control plane.

It owns:
- orchestration
- socket transport
- pipeline state machine
- AI agents
- persistence
- deployment integration
- workspace materialization
- build and test execution

The base app must not persist generated source code inside the repository tree.

## 6.2 Generated project boundary
The generated project is isolated and ephemeral.

Rules:
- exists only in memory or `/tmp/project-{projectId}`
- no cross-session sharing
- disposable after deployment
- code generation and fix loops operate only on generated files

## 6.3 Data isolation boundary
- `projectId` scopes session-level generated outputs
- `userId` scopes ownership and authorization
- `project_id` scopes all persisted project data in PostgreSQL
- Redis stores only transient state

---

## 7. Data Sets and Ownership

This system operates on several distinct data sets.

### 7.1 User auth data set
Owned by:
- `users`
- `auth_sessions`

Purpose:
- authentication
- session validation
- ownership checks

### 7.2 Project session data set
Owned by:
- `project_sessions`

Purpose:
- session status
- pipeline step
- progress
- current artifacts
- lock state
- deployment status

### 7.3 Blackboard state data set
Owned by:
- `project_blackboards`

Purpose:
- project session blackboard snapshot
- current stage snapshot
- task queue snapshot
- deployment snapshot

### 7.4 Task data set
Owned by:
- `project_tasks`

Purpose:
- generated task queue
- phase/action tracking
- retries
- per-task payloads

### 7.5 Event stream data set
Owned by:
- `project_events`

Purpose:
- all user/system/assistant events
- WebSocket message history
- orchestration narrative log

### 7.6 Revision data set
Owned by:
- `project_code_revisions`

Purpose:
- archive metadata
- workspace path
- patch path
- source hash
- generation payload

### 7.7 Deployment data set
Owned by:
- `project_deployments`

Purpose:
- Vercel / Railway deployment metadata
- deploy logs
- URLs
- source archive hashes
- backend/frontend service IDs

### 7.8 Redis transient state set
Owned by:
- session state keys
- pipeline status keys
- temporary coordination keys

Purpose:
- short-lived orchestration cache
- never source of truth

---

## 8. End-to-End Flow Diagram

### 8.1 System flow
```text
User
  |
  v
Frontend SPA (React/Vite)
  |
  +--> HTTP API ------------------------------+
  |                                           |
  +--> WebSocket connection                   |
                                              v
                                      WebSocket Gateway
                                              |
                                              v
                                     Session Resolver
                                              |
                                              v
                                 Orchestration Controller
                                              |
              +-------------------------------+-------------------------------+
              |                               |                               |
              v                               v                               v
     Requirement Analysis               Clarification                    Confirmation Gate
              |                               |                               |
              +-------------------------------+-------------------------------+
                                              |
                                              v
                                       System Design
                                              |
                                              v
                                            UI Spec
                                              |
                                              v
                                          Blueprint
                                              |
                                              v
                                       Code Generation
                                              |
                                              v
                                   In-Memory File Map
                                              |
                                              v
                              Materialize /tmp/project-{projectId}
                                              |
                                              v
                                  Build Worker / Test Loop
                                              |
                                              v
                                    Deployment Layer
                                   /                    \
                                  v                      v
                               Vercel                 Railway
                                  \                    /
                                   v                  v
                                   Deployment Metadata
                                              |
                                              v
                                        Final Result
```

---

## 9. Communication Diagram

### 9.1 Major communication paths
```text
Frontend SPA
  -> WebSocket Gateway
  -> API Routes
  -> Auth Service
  -> Project Session Store
  -> Orchestrator

Orchestrator
  -> Requirement Analysis Agent
  -> Clarification Agent
  -> Confirmation Gate
  -> System Design Agent
  -> UI Spec Agent
  -> Blueprint Agent
  -> Code Generation Agent
  -> Test/Fix Agent
  -> Workspace Materializer
  -> Build Worker
  -> Deployment Agent
  -> Event Store / Snapshot Store

Code Generation Agent
  -> LLM Proxy Client
  -> Model Router
  -> Reviewer Agent
  -> Blueprint Contract

Build Worker
  -> filesystem in /tmp/project-{projectId}
  -> frontend package manager
  -> backend package manager
  -> compiler/test tools

Deployment Agent
  -> Vercel deploy adapter
  -> Railway deploy adapter
  -> PostgreSQL init SQL
```

---

## 10. Pipeline State Machine

The pipeline is state-machine driven.

### 10.1 States
- `init`
- `requirementAnalysis`
- `clarification`
- `clarification_wait`
- `clarification_wait_modification`
- `confirmation`
- `confirmation_wait`
- `systemDesign`
- `uiSpec`
- `uiSpec_modification`
- `blueprint`
- `codeGen`
- `codeGen_modification`
- `testFix`
- `testFix_modification`
- `deploy`
- `deploy_modification`
- `done`
- `done_modification`
- `failed`

### 10.2 State groups
- analysis
- design
- generation
- delivery
- terminal

### 10.3 Transition rules
- transitions are explicit
- retryable stages can re-enter safely
- failed validation blocks deployment
- deployed projects transition to terminal states
- completed projects can restart with a fresh request

---

## 11. Session Lifecycle

### 11.1 Session initialization
1. client connects
2. origin is validated
3. cookie is parsed
4. user is resolved
5. current or new project session is selected
6. blackboard snapshot is loaded
7. current pipeline state is restored

### 11.2 Session execution
The orchestrator processes the current request through the pipeline stages.

### 11.3 Session pause
If clarification or confirmation is needed:
- session state is persisted
- the WebSocket waits for user response
- the pipeline resumes from the paused state

### 11.4 Session completion
Once deployed:
- deployment metadata is saved
- final result is emitted
- temporary workspace is cleaned up

### 11.5 Session reset
If the user starts a new request after completion:
- pipeline resets to `init`
- transient state is cleared
- new generation flow begins

---

## 12. Memory Model

The orchestrator uses a memory-first model.

### 12.1 In-memory stores
- requirements memory
- clarification memory
- system design memory
- UI spec memory
- blueprint memory
- execution plan memory
- code memory
- test memory
- deployment memory
- issue history
- fix history
- checkpoints

### 12.2 Memory constraints
- session scoped
- project scoped
- discarded on completion or cancel
- not shared across sessions

### 12.3 What memory contains
- generated file list
- patch text
- build logs
- deployment metadata
- validation state
- error classifications
- repair attempts

---

## 13. Detailed Component Responsibilities

### 13.1 Frontend SPA
Responsibility:
- render chat and project history UI
- connect to WebSocket
- send user messages
- display progress, clarification prompts, errors, URLs

Consumes:
- project history API
- project event stream
- session state
- deployment status

### 13.2 WebSocket Gateway
Responsibility:
- transport for interactive orchestration
- origin and auth validation
- session resolution
- event persistence wrapper
- progress/error/done payload emission

Consumes:
- auth cookie
- projectId query parameter
- user messages

Produces:
- persistent project events
- pipeline control messages
- snapshot updates

### 13.3 HTTP API
Responsibility:
- project CRUD-like operations
- history retrieval
- project selection
- redeploy
- event listing
- auth flows

Consumes:
- authenticated session
- project ownership

Produces:
- project metadata
- event history
- deployment status
- redeploy responses

### 13.4 Requirement Analysis Agent
Responsibility:
- infer website type
- infer pages
- infer backend/auth need
- infer deployment preference
- detect frontend-only signals

Consumes:
- raw user request

Produces:
- structured requirements

### 13.5 Clarification Agent
Responsibility:
- ask blocking questions only when needed
- avoid duplicate questions
- carry prior answers
- preserve asked history

Consumes:
- requirements
- prior clarification answers
- asked questions
- modification context

Produces:
- questions
- confirmed flag
- completion flag
- clarification context

### 13.6 Confirmation Gate
Responsibility:
- convert clarification result into a safe execution gate

Consumes:
- clarification memory

Produces:
- approval state

### 13.7 System Design Agent
Responsibility:
- produce architecture JSON
- enforce React/Vite frontend
- enforce Railway backend when backend exists
- enforce Vercel frontend

Consumes:
- requirements
- project spec

Produces:
- frontend design
- backend design
- database design
- auth design
- hosting design

### 13.8 UI Spec Agent
Responsibility:
- define components
- define component dependencies
- define navigation
- define state management
- define API wiring expectations

Consumes:
- system design
- requirements
- project spec

Produces:
- UI spec
- structured spec

### 13.9 Blueprint Agent
Responsibility:
- validate cross-stage consistency
- generate machine-readable blueprint
- enforce file registry
- enforce route scoping
- enforce project_id isolation

Consumes:
- requirements
- system design
- UI spec
- project spec

Produces:
- blueprint contract
- file plan
- route plan

### 13.10 Code Generation Agent
Responsibility:
- generate frontend and backend files
- honor blueprint
- operate file-by-file
- preserve project_id scoping
- avoid base app coupling

Consumes:
- blueprint
- UI spec
- system design
- requirements
- project spec
- modification context

Produces:
- in-memory file map
- patch
- project task queue

### 13.11 Test/Fix Agent
Responsibility:
- run build/test loop
- repair generated files only
- fix dependencies or missing scaffolds
- never touch base app code

Consumes:
- generated file map
- workspace directory
- build results

Produces:
- build result
- repaired file set
- logs

### 13.12 Workspace Materializer
Responsibility:
- sanitize projectId
- create temporary workspace
- copy templates
- write generated files
- archive workspace
- compute source hash
- apply patch if present

Consumes:
- projectId
- code generation output

Produces:
- workspace path
- archive path
- hash
- patch metadata

### 13.13 Build Worker
Responsibility:
- validate generated project structure
- install dependencies
- run build/test
- verify outputs
- clean dist directories
- protect workspace boundary

Consumes:
- workspace path

Produces:
- build logs
- build directory
- backend directory

### 13.14 Deployment Agent
Responsibility:
- deploy frontend to Vercel
- deploy backend to Railway
- run DB init SQL
- probe frontend accessibility
- collect deployment metadata

Consumes:
- build output
- backend workspace
- revision metadata
- projectId

Produces:
- frontend URL
- backend URL
- provider metadata
- access warnings

### 13.15 Project Store
Responsibility:
- persist project events, snapshots, tasks, revisions, deployments

Consumes:
- orchestration output
- deployment output
- blackboard state

Produces:
- queryable project history
- session persistence

---

## 14. Data Flow by Stage

### 14.1 Requirement analysis stage
Input:
- raw user message

Output:
- requirements object

Storage:
- `project_sessions.requirements`
- `project_events`
- `project_blackboards`

### 14.2 Clarification stage
Input:
- requirements
- prior answers

Output:
- questions or clarified result

Storage:
- `project_sessions.clarifications`
- `project_events`

### 14.3 Confirmation stage
Input:
- clarification output

Output:
- approved execution gate

Storage:
- `project_sessions.confirmation`

### 14.4 System design stage
Input:
- requirements
- project spec

Output:
- system design JSON

Storage:
- `project_sessions.system_design`

### 14.5 UI spec stage
Input:
- system design
- requirements

Output:
- UI spec / structured spec

Storage:
- `project_sessions.ui_spec`
- `project_sessions.structured_spec`

### 14.6 Blueprint stage
Input:
- requirements
- system design
- UI spec

Output:
- blueprint JSON

Storage:
- `project_sessions.blueprint`

### 14.7 Code generation stage
Input:
- blueprint
- system design
- UI spec
- requirements

Output:
- file map
- patch
- task queue

Storage:
- `project_sessions.code_gen`
- `project_code_revisions`

### 14.8 Test and fix stage
Input:
- generated file map
- workspace path

Output:
- build result
- logs
- repaired files

Storage:
- `project_sessions.test_result`
- `project_events`

### 14.9 Deployment stage
Input:
- build output
- backend output
- workspace path

Output:
- deployment URLs
- provider metadata

Storage:
- `project_sessions.deployment`
- `project_deployments`

---

## 15. Backend Data Model

### 15.1 `users`
Purpose:
- authenticated user identity

Fields:
- id
- name
- email
- password_hash
- created_at

### 15.2 `auth_sessions`
Purpose:
- login session storage

Fields:
- id
- user_id
- token_hash
- ip_address
- user_agent
- created_at
- expires_at
- revoked_at

### 15.3 `project_sessions`
Purpose:
- main orchestration state

Fields:
- id
- user_id
- status
- current_step
- progress
- active_revision_id
- revision_lock_owner
- revision_lock_expires_at
- requirements
- clarifications
- confirmation
- system_design
- ui_spec
- structured_spec
- blueprint
- task_queue
- terminal_logs
- code_gen
- test_result
- deployment
- created_at
- last_active_at

### 15.4 `project_blackboards`
Purpose:
- current snapshot of a project session

Fields:
- id
- project_id
- user_id
- state
- created_at
- updated_at

### 15.5 `project_tasks`
Purpose:
- generation task queue persistence

Fields:
- id
- project_id
- user_id
- phase
- action
- file_path
- status
- priority
- attempt_count
- payload
- error_log
- created_at
- updated_at

### 15.6 `project_events`
Purpose:
- event log for WebSocket and orchestration messages

Fields:
- id
- project_id
- user_id
- event_type
- role
- message
- payload
- created_at

### 15.7 `project_deployments`
Purpose:
- deployment metadata

Fields:
- id
- project_id
- user_id
- frontend_url
- backend_url
- vercel_deployment_id
- vercel_inspect_url
- vercel_status
- vercel_log_url
- railway_deployment_id
- railway_status
- railway_log_url
- railway_dashboard_url
- code_revision_id
- source_archive_path
- source_hash
- raw_payload
- created_at

### 15.8 `project_code_revisions`
Purpose:
- source archive metadata for a generated revision

Fields:
- id
- project_id
- user_id
- workspace_path
- source_archive_path
- source_hash
- patch_path
- patch_applied
- patch_apply_log
- generation_payload
- created_at

---

## 16. Redis Design

Redis is only for transient data.

### Allowed
- session state
- pipeline state
- temporary coordination
- temporary deployment status cache

### Forbidden
- generated source code
- permanent history
- deployment source of truth
- archived build artifacts

### Keying pattern
- `session:{sessionId}:status`
- `project:{projectId}:pipeline`
- `project:{projectId}:temp:*`

---

## 17. Workspace Materialization Flow

### 17.1 Workspace creation
- sanitize `projectId`
- create `/tmp/project-{projectId}`
- ensure parent directories exist
- copy templates

### 17.2 File write flow
- write generated files only
- validate paths
- prevent traversal
- ensure no writes outside workspace

### 17.3 Archive flow
- optionally apply patch
- create source archive
- compute source hash
- persist revision metadata

### 17.4 Cleanup flow
- remove temporary workspace after deployment
- keep only persisted metadata

---

## 18. Build Worker Flow

1. resolve workspace root
2. verify it is under `/tmp`
3. validate generated project files
4. clean stale build outputs
5. install frontend dependencies
6. run frontend build
7. run frontend tests if present
8. install backend dependencies if backend exists
9. run backend build if build script exists
10. run backend tests if present
11. return build directories

### Build safety rules
- never operate on base app source
- never scan unrelated repository files
- never permit traversal outside workspace
- fail closed on invalid workspace structure

---

## 19. Deployment Flow

### 19.1 Frontend deployment
- deploy build output to Vercel
- derive project name from projectId
- store deployment metadata

### 19.2 Backend deployment
- run DB init SQL against shared PostgreSQL
- deploy backend source to Railway
- store backend metadata

### 19.3 Health probe
- probe frontend URL after deployment
- detect access protection
- return warning if blocked by deployment protection

### 19.4 Final output contract
```json
{
  "projectId": "...",
  "frontendUrl": "...",
  "backendUrl": "..." 
}
```
`backendUrl` may be `null` for frontend-only projects.

---

## 20. Error Handling and Recovery

### 20.1 Error classification
Typical categories:
- parsing error
- schema mismatch
- missing data
- semantic inconsistency
- build error
- deployment error
- state transition error
- access or authorization error
- unknown error

### 20.2 Recovery options
- retry
- repair
- ask user
- fallback
- skip non-critical step

### 20.3 Recovery strategy
The orchestrator decides recovery by:
- error type
- stage
- retry count
- whether user input is required
- whether fallback is safe

### 20.4 Fail-closed rules
- never deploy broken builds
- never proceed with invalid blueprint
- never mutate base app as a repair action
- never continue after workspace safety violation

---

## 21. Consistency Rules

The system validates consistency across stages.

### Checks
- requirements pages are reflected in system design
- UI spec components are present in blueprint
- blueprint file registry includes required files
- generated code includes required frontend and backend scaffolds
- App imports resolve to generated components
- backend routes are project scoped
- database queries include `project_id`
- generated backend files are TypeScript-only
- page labels are normalized before comparison

---

## 22. Cross-Component Communication Matrix

| Component | Sends To | Data Sent |
|---|---|---|
| Frontend SPA | WebSocket Gateway | user message, clarification answer, modification request |
| Frontend SPA | HTTP API | project history, project selection, auth calls |
| WebSocket Gateway | Orchestrator | user request context, project/session identity |
| Orchestrator | Requirement Agent | raw user requirement |
| Orchestrator | Clarification Agent | requirements, prior answers |
| Orchestrator | Confirmation Gate | clarification state |
| Orchestrator | System Design Agent | requirements, project spec |
| Orchestrator | UI Spec Agent | system design, requirements |
| Orchestrator | Blueprint Agent | requirements, system design, UI spec |
| Orchestrator | Code Generation Agent | blueprint, UI spec, system design |
| Orchestrator | Workspace Materializer | generated file map, patch |
| Orchestrator | Build Worker | workspace path |
| Orchestrator | Deployment Agent | build output, revision metadata |
| Build Worker | Package Managers | install/build/test commands |
| Deployment Agent | Vercel | frontend build directory |
| Deployment Agent | Railway | backend source directory |
| Project Store | DB | events, snapshots, tasks, deployments |
| Redis | Orchestrator | transient progress/state cache |

---

## 23. What Data Each Agent Uses

### Requirement analysis
Uses:
- user text

Produces:
- structured requirements

### Clarification
Uses:
- requirements
- asked questions
- answers
- modification context

Produces:
- questions or confirmed clarification

### System design
Uses:
- requirements
- project spec

Produces:
- architecture JSON

### UI spec
Uses:
- requirements
- system design
- project spec

Produces:
- component and navigation spec

### Blueprint
Uses:
- requirements
- system design
- UI spec
- project spec

Produces:
- validated file and route blueprint

### Code generation
Uses:
- blueprint
- UI spec
- system design
- requirements
- project spec

Produces:
- generated file map
- patch
- task queue

### Test/fix
Uses:
- workspace files
- build logs
- generated file set

Produces:
- repaired files
- success/failure logs

### Deployment
Uses:
- build output
- backend source
- workspace path
- project/revision metadata

Produces:
- deployment URLs
- provider IDs
- warnings

---

## 24. Safety Guarantees

The system enforces:

- no generated code is written into the base app repo
- no generated code depends on base app internals
- no cross-session source sharing
- no database access without `project_id`
- no deployment without successful validation/build
- no state machine jump without explicit transition
- no workspace writes outside `/tmp/project-{projectId}`
- no permanent storage of generated source in Redis

---

## 25. Known Critical Integration Points

These are the places a reviewer should inspect closely:

1. **Socket server ↔ project session store**
2. **Orchestrator ↔ state machine**
3. **Blueprint ↔ code generation contract**
4. **Code generation ↔ materializer**
5. **Materializer ↔ build worker**
6. **Build worker ↔ deployment agent**
7. **Deployment agent ↔ PostgreSQL/Railway/Vercel**
8. **Event persistence ↔ WebSocket send wrapper**
9. **Project consistency ↔ generated file set**
10. **Workspace cleanup ↔ post-deployment completion**

---

## 26. Final Summary

The architecture is a fully isolated, session-aware, self-healing generation pipeline.

The most important system invariants are:

- the base app is immutable during project generation
- generated projects are ephemeral and project-scoped
- all generated code is in-memory first
- workspace materialization only occurs under `/tmp/project-{projectId}`
- all persistent project data is scoped by `project_id`
- build, validation, and deployment operate only on generated artifacts
- failures are classified and recovered without crashing the pipeline

This document should be used as the implementation reference for runtime behavior, control flow, persistence, and deployment isolation.
