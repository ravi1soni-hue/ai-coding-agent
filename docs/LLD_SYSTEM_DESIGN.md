# Low-Level Design (LLD) — AI Autonomous Website Builder

## 1. Purpose

This document describes the current low-level architecture, runtime behavior, data flow, contracts, storage model, deployment model, validation rules, and safety boundaries of the AI autonomous website builder system.

It is intended for reviewers and automated auditors that need to verify architectural completeness, cross-stage consistency, isolation guarantees, and runtime correctness.

---

## 2. System Summary

The platform is an AI-orchestrated website builder that converts a user request into a deployable web application by running a deterministic multi-stage pipeline.

### Primary pipeline
1. requirementAnalysis
2. clarification
3. confirmation
4. systemDesign
5. uiSpec
6. blueprint
7. codeGen
8. testFix
9. deploy

### Runtime stack
- Frontend runtime: React 18 + Vite
- Frontend language: JavaScript / JSX
- Backend runtime: Node.js + TypeScript
- Backend framework for generated services: Express
- Persistent storage: PostgreSQL
- Transient session/cache layer: Redis
- Frontend deployment: Vercel
- Backend deployment: Railway
- Interactive transport: WebSocket

---

## 3. Architectural Goals

### 3.1 Primary goals
- Convert natural language requirements into production-ready apps
- Maintain strict project isolation
- Produce deterministic intermediate artifacts
- Ensure code generation is schema-driven
- Enforce deployment safety and build verification
- Support multi-project generation without cross-contamination
- Fail closed when validation or build guarantees are not met

### 3.2 Non-goals
- No user selection of framework or language
- No generation outside the fixed stack
- No shared mutable project workspace
- No permanent project state in Redis
- No deployment from outside the workspace
- No per-project database table creation pattern
- No backend source generation in `.js` files

---

## 4. Fixed Stack

### Frontend
- React 18
- Vite
- JavaScript / JSX generation only

### Backend
- Node.js
- TypeScript
- Express runtime for generated backend services
- PostgreSQL persistence
- Redis session/cache support

### Deployment
- Frontend: Vercel
- Backend: Railway

### Enforcement
The system rejects stack drift:
- Frontend must remain React/Vite
- Backend must remain Node.js/TypeScript
- Generated backend files must use `.ts`
- Alternative frontend or backend frameworks are not accepted

---

## 5. High-Level Component Diagram

### 5.1 Runtime components
- Web client / chat UI
- WebSocket gateway
- Pipeline orchestrator
- Requirement analysis agent
- Clarification agent
- Confirmation gate
- System design agent
- UI spec agent
- Blueprint agent
- Code generation agent
- Test/fix agent
- Build worker
- Deployment agent
- Project store
- Redis cache
- PostgreSQL database
- Workspace materializer
- Project consistency validator
- Model routing layer
- LLM proxy client
- Error/logging utilities

### 5.2 Data flow summary
User message → WebSocket → requirement analysis → clarification → confirmation → system design → UI spec → blueprint → code generation → build/test repair → deployment → final URLs returned over WebSocket

---

## 6. Core Runtime Boundaries

### 6.1 Workspace isolation
Each request must create a unique project workspace.

- `projectId = uuid()`
- `workspaceRoot = /projects/{projectId}`

Workspace rules:
- Copy template from the immutable starter template location
- Never modify templates during generation
- Never write outside `/projects/{projectId}`
- Never use parent traversal paths (`../`)
- All generation and build operations must use the workspace root

### 6.2 Persistent data separation
- PostgreSQL stores permanent project/session/task/deployment data
- Redis stores only transient session/pipeline state
- No permanent project artifacts in Redis

### 6.3 Revision isolation
Each project session supports a single active revision.

- `active_revision_id` is stored on `project_sessions`
- revision locking prevents concurrent generation runs from overwriting one another
- generation must acquire a lock before mutating a project workspace

---

## 7. End-to-End Pipeline Design

## 7.1 Stage: requirementAnalysis
### Input
- User product description

### Responsibility
- Infer:
  - website type
  - page list
  - backend requirement
  - auth requirement
  - deployment preference

### Output
`RequirementAnalysisOutput`
- `website_type`
- `pages`
- `backend_required`
- `auth_required`
- `deployment_pref`
- `notes`

### Validation
- Must return JSON only
- Must include pages
- For frontend-only requests, backend can be disabled
- For clearly frontend-only requests such as pricing pages or static pages, backend is forced off unless the request explicitly asks for backend functionality
- Must be consistent with the downstream fixed stack

### Current implementation notes
The requirement analysis agent uses the LLM output and then applies a frontend-only override when the request contains strong frontend signals such as:
- pricing page
- landing page
- marketing page
- static page
- client-side
- without backend
- no backend
- mock data
- static content

If those signals are present and no backend signal is present, the agent forces:
- `backend_required = false`
- `auth_required = false`

---

## 7.2 Stage: clarification
### Input
- requirementAnalysis output
- prior asked questions
- any clarification answers
- optional modification context

### Responsibility
- Ask 0–3 blocking questions
- Avoid duplicates
- Resolve ambiguity that affects:
  - data model
  - auth
  - API contracts
  - architecture
- Skip clarification when confidence is high enough to proceed

### Output
`ClarificationOutput`
- `questions`
- `confirmed`
- `done`
- `context`

### Important rules
- Do not repeat asked/answered questions
- If sufficient detail exists, return `confirmed=true`
- Questions must be specific and answerable
- Clarification should only block the pipeline when ambiguity materially impacts generation decisions

---

## 7.3 Stage: confirmation
### Input
- clarification output

### Responsibility
- Convert clarification state into a confirmed project execution gate

### Output
- Confirmation status / approval state

### Role in pipeline
- Prevent downstream generation unless the request is confirmed or safely inferred

---

## 7.4 Stage: systemDesign
### Input
- requirements
- canonical project spec
- modification (if any)

### Responsibility
- Produce a technical architecture JSON:
  - frontend framework
  - frontend pages/components
  - backend framework/routes/middleware/features
  - database tables
  - auth strategy
  - hosting strategy

### Output constraints
- JSON only
- Must always declare React/Vite frontend
- Must use Railway for backend when backend exists
- Must use Vercel for frontend
- Must be consistent with projectSpec
- Must remain deterministic for the same canonical inputs

### Current implementation notes
The system design agent:
- Reads canonical project spec context if provided
- Derives backend/auth requirements from input or projectSpec
- Enforces:
  - `frontend.framework = react-vite`
  - `hosting.frontend = vercel`
  - `hosting.backend = railway` when backend is required
- Normalizes malformed JSON from the LLM before returning
- Fails if backend is required but the backend section is missing

---

## 7.5 Stage: uiSpec
### Input
- systemDesign
- requirements
- canonical projectSpec
- modification

### Responsibility
- Generate UI component specification
- Define:
  - component interfaces
  - data flow
  - API contract
  - layout structure
  - generation order

### Output
`UISpec`
- `appName`
- `components[]`
- `dataFlow[]`
- `layoutStructure`
- `apiContract[]`
- `generationOrder[]`
- `navigationStrategy`
- `stateManagementStrategy`

### Key role
- This stage determines component dependency order and the UI contract for code generation

---

## 7.6 Stage: blueprint
### Input
- requirements
- systemDesign
- uiSpec
- canonical projectSpec

### Responsibility
- Create the machine-readable project blueprint
- Validate cross-stage consistency
- Enforce stack, files, routing, backend route scope, and project isolation

### Current enforced blueprint shape
Top-level:
- `strict`
- `metadata`
- `files`
- `dependencies`
- `backendRoutes`

`strict` must contain:
- `projectType`
- `modules`
- `frontend`
- `backend`
- `database`
- `structure`

`metadata` is optional and used for compatibility, diagnostics, and routing hints.

### Blueprint invariants
- Must be strict JSON
- Must be deterministic
- Must be internally consistent
- Must include frontend and backend structure
- Must include project_id isolation rules
- Must use `backend/src/index.ts` and `backend/src/db/database.ts` for backend entry/scaffold references
- Must not use `.js` backend generation paths

### Current implementation notes
The blueprint agent:
- Requires canonical `projectSpec`
- Rejects mismatched website types
- Ensures canonical pages are present
- Retries up to three times on validation errors
- Uses a fixed system prompt and only accepts JSON
- Validates the output with `validateProjectBlueprint`
- Rejects blueprints missing required files or violating stack rules
- Rejects backend routes when the canonical request is frontend-only

---

## 7.7 Stage: codeGen
### Input
- validated blueprint
- uiSpec
- requirements
- systemDesign
- projectSpec
- modification context

### Responsibility
- Generate source files in the workspace
- Generate frontend scaffold
- Generate backend scaffold
- Generate components in dependency order
- Generate App and CSS
- Ensure import correctness
- Ensure files are within allowed paths only
- Ensure generated backend code is TypeScript-only
- Ensure backend routes query shared tables with `project_id`

### Output
- file list
- patch reference
- generation metadata
- project task queue

### Generation rules
- No full project generation in one call
- Generate per file / per module
- Dependency order matters
- App must compose generated components
- Backend routes must be project-scoped
- Backend generation must only use `.ts` files
- Shared tables are mandatory; no `{projectId}_table` naming

---

## 7.8 Stage: testFix
### Input
- generated files
- build function
- optional fix function

### Responsibility
- Run build/test loop
- Auto-remediate dependency or build issues
- Retry up to a bounded number of times
- Fail closed if build cannot be fixed

### Build safeguards
- Install dependencies only inside the workspace
- Run frontend and backend builds in their respective directories
- Ensure frontend build output exists
- Ensure backend build only runs when backend package exists
- Preserve workspace isolation

### Limits
- max retries per stage
- max build attempts per project
- max LLM calls per project

---

## 7.9 Stage: deploy
### Input
- build output directory
- backend workspace directory
- projectId
- revisionId
- backend presence flag

### Responsibility
- Deploy frontend to Vercel
- Deploy backend to Railway
- Initialize database schema before backend deployment
- Probe frontend for deployment protection status
- Persist deployment metadata

### Output
- `frontend_url`
- `backend_url`
- deployment IDs/log URLs/statuses
- frontend accessibility warning if protected

---

## 8. WebSocket Protocol Design

### 8.1 Connection lifecycle
1. client connects
2. server checks origin
3. server validates session cookie
4. server resolves authenticated user
5. server resolves or creates project session
6. server attaches event persistence wrapper to socket send
7. server begins or resumes pipeline

### 8.2 Message categories
- `info`
- `stream`
- `progress`
- `clarification`
- `confirmation`
- `error`
- `done`

### 8.3 Server outbound payload patterns
#### info
- connection status
- general state updates

#### stream
- user-facing narrative and logs

#### progress
- stage and overall progress percentage

#### clarification
- question prompt

#### error
- user-facing error with retryability

#### done
- final completion payload including URLs

### 8.4 Persistence hook
Outgoing WebSocket messages are persisted to:
- `project_events`
- project snapshot fields
- blackboard state

---

## 9. Project Session and State Machine

### 9.1 Pipeline stages
Defined stages:
- init
- requirementAnalysis
- clarification
- clarification_wait
- clarification_wait_modification
- confirmation
- confirmation_wait
- systemDesign
- uiSpec
- uiSpec_modification
- blueprint
- codeGen
- codeGen_modification
- testFix
- testFix_modification
- deploy
- deploy_modification
- done
- done_modification

### 9.2 Stage grouping
- analysis
- design
- generation
- delivery
- terminal

### 9.3 Stage transitions
- Each stage must advance only when successful
- Paused states wait for user input
- Failure states can retry or reset depending on step
- Completed projects can start a new request by resetting to init

### 9.4 Progress model
- Weighted progress per stage
- Progress is updated once per stage
- Stage-level completion does not exceed 1.0

---

## 10. Data Model Design

## 10.1 PostgreSQL schema

### Core user/auth tables
#### users
- id
- name
- email
- password_hash
- created_at

#### auth_sessions
- id
- user_id
- token_hash
- ip_address
- user_agent
- created_at
- expires_at
- revoked_at

### Project orchestration tables
#### project_sessions
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
- blueprint
- task_queue
- terminal_logs
- code_gen
- test_result
- deployment
- created_at
- last_active_at

#### project_blackboards
- id
- project_id
- user_id
- state
- created_at
- updated_at

#### project_tasks
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

#### project_events
- id
- project_id
- user_id
- event_type
- role
- message
- payload
- created_at

#### project_deployments
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

#### project_code_revisions
- id
- project_id
- user_id
- workspace_path
- source_archive_path
- source_hash
- patch_path
- patch_apply_log
- patch_applied
- generation_payload
- created_at

### 10.2 Schema access rules
- All project queries filter by both `project_id` and `user_id`
- All deployment and revision tables are project-scoped
- Queries must never mix tenants
- Active revision locking must prevent concurrent writes for the same project

---

## 11. Redis Design

### Allowed use cases
- session state
- pipeline state
- transient events
- deployment status cache
- short-lived coordination values

### Forbidden use cases
- permanent project data
- source code artifacts
- archived build outputs
- deployment history source of truth

### Redis keying pattern
Recommended:
- `session:{sessionId}:status`
- `project:{projectId}:pipeline`
- `project:{projectId}:temp:*`

### Safety
- TTL should be used for transient entries
- Redis can be disabled if unavailable without breaking core persistence

---

## 12. Workspace Materialization Design

### 12.1 Input
- `projectId`
- code generation output

### 12.2 Steps
1. sanitize project ID segment
2. create `/projects/{projectId}`
3. create or reuse workspace directory
4. copy template
5. write generated files
6. write generated patch file
7. optionally apply patch
8. archive workspace
9. hash workspace contents

### 12.3 Workspace output artifacts
- workspace directory
- archive path
- source hash
- patch path
- patch applied flag
- patch apply log

### 12.4 Safety rules
- no writes outside workspace
- no template modification
- no traversal paths
- archive excludes `node_modules`, `dist`, `.git`, `source.tgz`

---

## 13. Build Worker Design

### Frontend build
- install dependencies in frontend workspace
- run build
- optional tests
- verify dist output exists

### Backend build
- install dependencies in backend workspace
- run build if build script exists
- optional tests

### Validation
- workspace root must be under `/projects`
- frontend must have required files
- backend must have required files if backend exists
- backend build must fail if legacy `.js` backend entrypoints are present

### Failure handling
- return logs and error summary
- do not deploy if build fails

---

## 14. Deployment Design

## 14.1 Frontend deployment
- build output deployed to Vercel
- frontend project name derived from projectId
- deployment metadata persisted

## 14.2 Backend deployment
- backend source deployed to Railway
- backend service name derived from projectId
- DB init SQL run before backend deployment

## 14.3 Health/protection probe
- probe deployed frontend URL
- detect 401/403 deployment protection
- expose warning back to user

---

## 15. Blueprint Contract Design

### 15.1 Strict contract goals
- machine-readable
- deterministic
- no prose
- complete and consistent

### 15.2 Required top-level logical shape
The current blueprint contract enforces:
- `strict`
- `metadata`
- `files`
- `dependencies`
- `backendRoutes`

### 15.3 Required strict shape
`strict` must include:
- `projectType`
- `modules`
- `frontend`
- `backend`
- `database`
- `structure`

### 15.4 Compatibility metadata
`metadata` currently preserves compatibility and routing hints such as:
- `title`
- `stack`
- `buildCriticalFiles`
- `entrypoints`
- `state`
- `navigation`
- `invariants`

### 15.5 Validation rules
- frontend pages/components cannot be empty
- backend required implies backend routes/modules cannot be empty
- backend routes must be project-scoped
- `src/App.jsx` must exist when frontend composition is built
- if backend exists, App must include fetch/API wiring references
- invariants must include `project_id` isolation
- required build files must be present in the file registry
- backend file registry entries must use `.ts` paths

### 15.6 Current implementation notes
The blueprint validator:
- enforces required strict fields
- rejects placeholder text
- validates navigation and file registry rules
- requires build-critical frontend files
- requires backend source files when backend is required
- normalizes all file paths before validation
- rejects path traversal and invalid paths

---

## 16. Code Generation Rules

### 16.1 File generation rules
- one file per component / utility / route / schema
- keep files focused
- avoid giant monolithic outputs
- ensure every file path is safe and workspace-local
- code generation must only write files listed in the blueprint file registry

### 16.2 Frontend scaffolding rules
Required files:
- `package.json`
- `index.html`
- `vite.config.js`
- `src/main.jsx`
- `src/App.jsx`
- `src/index.css`

### 16.3 Backend scaffolding rules
Required files:
- `backend/package.json`
- `backend/src/index.ts`
- `backend/src/db/database.ts`
- `backend/db/init.sql`

### 16.4 Component generation rules
- generate in dependency order
- every component must export default function
- no placeholder text
- meaningful props/state/effects
- valid imports only

### 16.5 App generation rules
- compose all generated components
- if backend exists, use API_BASE or fetch
- support loading/error states when data fetching exists

### 16.6 Backend data access rules
- backend routes must query shared tables
- each query must include `project_id`
- no per-project table naming pattern is allowed
- route handlers must reject requests missing `project_id` when the route is project scoped

---

## 17. Security and Isolation Rules

### 17.1 Mandatory rules
- never ask user for stack/framework/language
- never write outside workspace
- never modify templates
- never deploy from base repo
- never mix project data across project IDs
- never store permanent project data in Redis

### 17.2 Project ID scoping
- all database tables are scoped by `project_id`
- deployment records are project-scoped
- events and tasks are project-scoped
- workspace directory is project-scoped

### 17.3 Auth/session rules
- WebSocket requires session cookie
- project access requires ownership validation
- unauthorized project requests create or redirect to owned scope only

---

## 18. Error Handling Strategy

### 18.1 LLM failures
- retry bounded number of times
- parse JSON strictly
- fail closed if output is invalid
- fall back to deterministic scaffolds where appropriate
- do not silently coerce schema mismatches

### 18.2 Build failures
- retry build/fix loops
- stream logs back to UI
- stop deployment if build fails

### 18.3 Deployment failures
- return provider-specific deployment metadata
- do not hide Railway/Vercel failures
- preserve successful frontend deployment even if backend deploy fails when possible

### 18.4 Validation failures
- return structured validation errors
- include exact issue description
- avoid silent coercion

---

## 19. Logging and Observability

### 19.1 Logs stored in project workspace
- workspace root
- file writes
- build cwd
- deployment paths

### 19.2 Runtime logs
- pipeline transitions
- stage retries
- event persistence
- deployment statuses
- workspace materialization details
- revision lock acquisition/release events

### 19.3 Verification targets
A verifier should inspect:
- stage correctness
- workspace boundaries
- data isolation
- build execution context
- blueprint contract consistency
- deployment consistency
- revision locking correctness

---

## 20. Public API Surface

### 20.1 WebSocket
Primary interactive pipeline transport.

### 20.2 HTTP routes
The backend exposes project/auth routes for:
- current project resolution
- new project creation
- project history
- project selection
- event listing
- redeploy
- job queue compatibility
- deployment status lookup

### 20.3 Frontend SPA
- React/Vite UI renders chat/workspace
- communicates with WebSocket backend
- consumes project history and status endpoints

---

## 21. Component Responsibilities

### Backend core
- `socket.ts`: pipeline orchestrator and WebSocket broker
- `projectFactory.ts`: workspace materialization and archiving
- `buildWorker.ts`: install/build/test execution
- `deploymentAgent.ts`: Vercel/Railway deployment
- `blueprintContract.ts`: strict blueprint validation and compatibility logic
- `blueprintAgent.ts`: blueprint generation
- `codeGenerationAgent.ts`: multi-file code generation
- `testFixAgent.ts`: build/test repair loop
- `systemDesignAgent.ts`: architecture generation
- `uiSpecAgent.ts`: UI spec generation
- `clarificationAgent.ts`: clarification logic
- `requirementAnalysisAgent.ts`: requirement parsing
- `projectConsistency.ts`: cross-stage consistency checks
- `projectStore.ts`: persistence layer
- `modelRouter.ts`: model selection by task
- `llmProxyClient.ts`: LLM provider abstraction

### Frontend core
- `App.jsx`: UI shell
- `ChatWorkspace.jsx`: interactive chat/pipeline interface
- `AuthPage.jsx`: auth UI
- `ProjectHistory.jsx`: history interface

---

## 22. Validation and Consistency Rules

### 22.1 Cross-stage consistency
The system validates that:
- requirement pages are reflected in system design
- UI spec components are wired into the blueprint
- blueprint file registry includes required files
- generated code contains expected files for the UI spec
- App uses the expected export form
- backend-required projects have backend architecture and routes

### 22.2 Current normalization behavior
The consistency validator now normalizes page labels before comparing them. This prevents false mismatches such as:
- `pricing page`
- `Pricing`

The normalization removes the literal word `page` and compares lowercase normalized labels.

### 22.3 Validation scope
- consistency validation is staged
- checks run only after the relevant pipeline stage has completed
- validation returns a structured issue list with stage names and messages

---

## 23. Verification Checklist for External Reviewer

A separate verifier should confirm:

1. Workspace writes only occur under `/projects/{projectId}`
2. Templates remain read-only
3. Pipeline stages advance correctly
4. Blueprint output matches strict machine-readable contract
5. Backend routes are project-scoped
6. Redis is only used transiently
7. PostgreSQL stores all permanent data
8. Build worker uses workspace-local cwd
9. Deployment only happens after successful build/test
10. Frontend/backend stack is fixed to React/Vite + Node/TypeScript
11. App composition includes generated components
12. All generated imports resolve
13. Project isolation is enforced in all persistence paths
14. WebSocket message flow persists state and events correctly
15. Shared-table database queries always filter by `project_id`
16. Backend generation never emits `.js` files
17. Requirement pages and system design pages use normalized comparison
18. Blueprint retry prompts are clean and valid text

---

## 24. Known Gaps / Review Targets

Areas a separate verifier should inspect closely:
- Whether blueprint contract metadata is still more permissive than desired
- Whether backend route scoping is enforced everywhere at query-time
- Whether `socket.ts` cleanup and retry flows can leave stale state
- Whether build/test/deploy logs are fully persisted and correlated by project/revision
- Whether frontend deployment warnings are surfaced clearly enough to users
- Whether Redis fallbacks are safe when unavailable
- Whether path sanitization is enforced consistently across all generators
- Whether revision locking is held for the full mutation window

---

## 25. Suggested Follow-Up Hardening

Recommended next steps:
- split blueprint compatibility metadata from strict generation contract even further if needed
- require explicit route-to-table mapping for every backend route
- store formal pipeline audit logs in a dedicated table
- add unit tests for contract validation and workspace safety
- add integration tests for WebSocket stage transitions
- add build verification for generated project workspaces
- add deployment contract tests for Vercel/Railway response parsing
- add concurrency tests for revision locking
- add regression tests for page normalization in consistency checks

---

## 26. Final Note

This system is designed to be verified by an external agent. The most important invariants to validate are:

- workspace isolation
- fixed stack enforcement
- strict blueprint determinism
- backend route project scoping
- shared-table database usage
- build/deploy gating
- persistence correctness
- revision locking correctness
- cross-stage consistency normalization

Any deviation from those invariants should be treated as a system gap.
