# AI Layer Capability Audit

## Verdict
Partially capable. The pipeline can generate session-scoped projects and persist project metadata/history, but there are correctness gaps that can prevent reliable end-to-end backend+DB deployment per project.

## What is working
1. **Session-scoped project orchestration and persistence**
   - Project sessions are user-scoped and tracked in Postgres (`project_sessions`, `project_events`, `project_code_revisions`, `project_deployments`).
2. **Code materialization by project+revision**
   - Generated files are materialized into per-project/per-revision workspaces and archived with source hash.
3. **Frontend deployment integration (Vercel)**
   - Build directory is uploaded to Vercel with project-name isolation derived from projectId.
4. **Backend deployment integration (Railway)**
   - Railway deploy supports CLI path and GraphQL trigger fallback.

## Critical gaps (must-fix)
1. **Backend deployment is attempted unconditionally**
   - `deploymentAgent` always calls Railway deployment even when generated app is frontend-only.
   - Impact: frontend-only projects can fail overall pipeline at deploy stage.
2. **Railway deployment target is global, not truly project-scoped**
   - `deployToRailway` uses shared env vars (`RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID`) regardless of user project.
   - Impact: multiple user projects can deploy into the same Railway service unless external automation creates isolated services.
3. **Database provisioning is not project-scoped in current code path**
   - No per-project PostgreSQL database creation/binding logic is executed in `deploymentAgent` flow.
   - Generated backend template expects `POSTGRES_URL`, but provisioning per project is not orchestrated.
4. **WebSocket auth hardening still pending**
   - Cookie-authenticated websocket connection lacks explicit `Origin` allowlist validation.

## High-priority recommendations
1. Add `hasBackend` detection from generated outputs/system design and skip Railway when backend is absent.
2. Introduce explicit per-project Railway service provisioning (or documented shared-service mode).
3. Add DB provisioning step (project DB/schema per session) and inject env vars during deploy.
4. Add `Origin` validation for websocket handshake.
5. Add integration tests for: frontend-only deploy, fullstack deploy, redeploy from revision, concurrent projects.

## Bottom line
- **Frontend generation/deploy and session history are implemented.**
- **Strict “frontend + backend + project-wise DB + isolated deploy target per project” is not fully guaranteed yet.**
