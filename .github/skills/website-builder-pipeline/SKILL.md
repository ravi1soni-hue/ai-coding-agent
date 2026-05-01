---
name: website-builder-pipeline
description: "Generate and repair this repository's AI website builder pipeline from prompt to deployment. Covers requirement extraction, one-question clarification, confirmation gate, system design JSON, full file code generation, workspace materialization, build/test loop, archive, Vercel and Railway deployment, and deterministic failure triage. Use for frontend/backend/db/deployment website generation or stuck pipeline runs."
argument-hint: "Product prompt + pages + backend/auth/deployment preferences + modification intent"
---

# Website Builder Pipeline

## What This Skill Produces
- A repository-specific execution plan that matches the active WebSocket stage machine.
- Correct JSON contracts for requirement, clarification, system design, and code generation stages.
- A deterministic debug path for malformed LLM JSON, archive races, disconnects, and deployment payload errors.

## When to Use
- You want to build a website from a natural-language product prompt.
- You need aligned frontend, backend, database, and deployment outputs in one pass.
- The pipeline is stuck and you need exact stage-level diagnosis with file-level fixes.

## Codebase Reality (Use This As Source Of Truth)
- Primary runtime flow is in [socket flow](../../../backend/src/api/socket.ts), not only in LangGraph.
- Stage sequence: init -> requirementAnalysis -> clarification -> clarification_wait -> confirmation -> confirmation_wait -> systemDesign -> codeGen -> testFix -> deploy -> done.
- Modification sequence: modification -> clarification_wait_modification -> codeGen_modification -> testFix_modification -> deploy_modification -> done_modification.
- Progress behavior: most stages increment by 0.12, deployment emits progress=1.

Load strict contracts from [workflow contracts](./references/workflow-contracts.md).

## Required Inputs
- Product prompt: what to build and for whom.
- Pages and user roles.
- Backend/auth requirements (required booleans for this pipeline).
- Deployment preference and platform constraints.
- For modification requests: exact requested change plus prior clarification context.

## Preflight (Mandatory)
1. Validate env readiness before generation/deploy:
- VERCEL_ACCESS_TOKEN
- VERCEL_TEAM_ID (if team-scoped)
- RAILWAY_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID
2. Use correct local commands:
- backend dev: cd backend && npm run dev
- backend build: cd backend && npm run build
- frontend dev: cd frontend && npm run dev
3. Do not run root-level npm run dev in this repository (no root package.json).

## Workflow

### 1. Requirement Intake And Clarification
1. Run requirement extraction with strict JSON output.
2. Capture website_type, pages, backend_required, auth_required, deployment_pref.
3. Enter one-question clarification loop (single blocking question only).
4. Maintain askedQuestions and clarificationAnswers to prevent repeats.
5. Move to confirmation only when clarification confirms.

Completion checks:
- Requirements are testable and unambiguous.
- Confirmation gate passes (confirmed=true and no unresolved questions).

### 2. System Design Generation
1. Generate strict JSON shape:
- { frontend, backend, database, auth, hosting: { frontend, backend } }
2. Normalize optional nodes to null when backend/auth is not required.
3. Enforce frontend presence and hosting object.
4. Validate output shape before proceeding.

Decision points:
- If schema parse or validation fails: retry once with validation feedback, then fail fast with explicit error.
- If requirements changed after confirmation: branch back to Step 1.

Completion checks:
- Design satisfies backend_required/auth_required constraints.
- Output matches expected schema exactly.

### 3. Implementation Planning (Frontend, Backend, DB)
1. Frontend plan: page map from requirements.pages and build pipeline to dist.
2. Backend plan: only if backend_required=true; otherwise keep backend null.
3. Database plan: only if backend_required=true and data persistence needed.
4. Deployment plan: Vercel for frontend and Railway for backend service health.

Decision points:
- If data model impacts API shape: regenerate frontend and backend contracts together.
- If provider validation fails with missing project settings: enrich deployment payload with required settings object.

Completion checks:
- Frontend-backend contracts are aligned.
- DB schema supports all required use cases and query patterns.

### 4. Code Generation
1. Produce complete files array and patch string in one JSON response.
2. Materialize workspace from frontend template, then write generated files.
3. Persist patch file and optional patch application log.
4. Create source archive and source hash for deployment traceability.

Decision points:
- If type/build fails: stop forward progress, repair current slice, rerun checks.
- If archive creation fails due mutable files: archive from immutable snapshot directory.

Completion checks:
- Project builds successfully in target runtime.
- Materialized revision has workspaceDir, archivePath, sourceHash.

### 5. Test And Fix Loop
1. Run automated tests and smoke checks.
2. Classify failures by layer (frontend/backend/db/deploy).
3. Apply minimal targeted fixes.
4. Re-run build and tests with retry budget.

Completion checks:
- Critical path tests pass.
- Regressions are not introduced in previously passing stages.

### 6. Archive And Package
1. Ensure archive excludes .git, node_modules, dist, and temporary artifacts.
2. Create deterministic tgz per revision.
3. Store archive path and source hash with deployment metadata.

Decision points:
- If archive reports file mutation during read: re-stage files to a temp snapshot and re-archive.

Completion checks:
- Archive creation is deterministic and reproducible.
- Archive contains required source only.

### 7. Deployment Execution
1. Deploy frontend build output to Vercel API with project name and files payload.
2. Trigger Railway deployment when credentials are configured.
3. Save deployment IDs, status, logs, and URLs.
4. Stream progress and final status to socket client.

Decision points:
- If Vercel returns 400 validation error, parse provider body and map to missing payload fields.
- If Railway trigger cannot execute, fall back to health-check status evaluation.

Completion checks:
- Deployment accepted by provider API.
- Runtime URL/ID returned and persisted.

## Failure Triage Playbook

### Error: Malformed systemDesignAgent output
- Root cause class: output schema mismatch or mixed text+JSON response.
- Action:
1. Enforce strict structured output contract.
2. Parse-and-validate before stage transition.
3. Retry once with validation errors echoed back to generator.

Primary file:
- [systemDesignAgent](../../../backend/src/agents/systemDesignAgent.ts)

### Error: tar: .: file changed as we read it
- Root cause class: source directory mutating during archive.
- Action:
1. Copy deployment input to temp snapshot.
2. Archive snapshot, not live workspace.
3. Exclude volatile files and logs.

Primary file:
- [projectFactory](../../../backend/src/factory/projectFactory.ts)

### Error: Socket disconnected during long run
- Root cause class: dropped client connection without resume strategy.
- Action:
1. Keep server-side job state authoritative.
2. On reconnect, replay latest stage + buffered logs.
3. Add heartbeat and idle timeout diagnostics.

Primary file:
- [socket server](../../../backend/src/api/socket.ts)

### Error: Deployment 400 missing_project_settings
- Root cause class: provider payload incomplete.
- Action:
1. Include required project settings object when provider rejects payload.
2. If framework auto-detection is desired, set skipAutoDetectionConfirmation accordingly.
3. Log sanitized payload keys and provider response code/message.

Primary file:
- [Vercel deployment client](../../../backend/src/agents/vercelDeploy.ts)

## Message Protocol Rules
- Emit plain conversational text on stream tokens.
- Emit clarification messages as a plain question string.
- Emit structured error messages with actionable cause.
- On stale reconnect state, reset to init only when a fresh user prompt exists.

## Output Contract For This Skill
- Stage status model: pending -> running -> passed or failed.
- Every stage emits:
1. Input summary.
2. Validation result.
3. Artifact references.
4. Next-stage gate decision.
- On failure, emit: root-cause hypothesis, evidence, fix plan, and retry policy.

## Definition Of Done
- Requirements confirmed.
- System design validated.
- Code generated, materialized, and archived.
- Build (and tests if present) passed.
- Archive generated without mutation errors.
- Deployment accepted and URL returned.

## Example Prompts
- Build a website builder pipeline from this product idea. Include React frontend, Node backend, PostgreSQL schema, code generation stages, and Vercel deployment.
- Diagnose my pipeline where system design passes but deployment fails with provider 400 errors. Apply this skill and produce exact stage-level fixes.
- Generate an end-to-end architecture and implementation checklist for prompt to frontend backend db code deployment, including retry and rollback logic.
- Optimize my current pipeline run: trace stage by stage from requirementAnalysis to deploy using socket events and return the first failing gate with fix patch.