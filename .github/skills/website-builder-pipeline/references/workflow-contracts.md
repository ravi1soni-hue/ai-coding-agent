# Workflow Contracts

Use these contracts when running the website builder pipeline to reduce malformed outputs and stage drift.

## Runtime Stage Map

Primary stage machine:
- init
- requirementAnalysis
- clarification
- clarification_wait
- confirmation
- confirmation_wait
- systemDesign
- codeGen
- testFix
- deploy
- done

Modification stage machine:
- modification
- clarification_wait_modification
- codeGen_modification
- testFix_modification
- deploy_modification
- done_modification

## Requirement Analysis Contract

Expected JSON keys:
- website_type: business | portfolio | saas | ecommerce
- pages: string[]
- backend_required: boolean
- auth_required: boolean
- deployment_pref: string

Validation gate:
- website_type must be present
- pages must be an array

## Clarification Contract

Input:
- requirements: object
- clarificationAnswers: object
- askedQuestions: string[]
- modification: string | null
- lastQuestion: string | null
- lastAnswer: string | null

Output:
- question: string | null
- confirmed: boolean

Rules:
- One blocking question at a time.
- Never repeat a question already asked or answered.
- If confirmed=true and question=null, move to confirmation gate.

## System Design Contract

Required shape:
- frontend: object
- backend: object | null
- database: object | null
- auth: object | null
- hosting:
  - frontend: string
  - backend: string | null

Rules:
- frontend is always required.
- if backend_required=false, backend and database should be null.
- if auth_required=false, auth should be null.

## Code Generation Contract

Required shape:
- patch: string
- files: Array<{ path: string; content: string }>

Rules:
- Return valid JSON only.
- files must be complete and runnable, no placeholders.

## Materialization And Archive Contract

Materialized revision fields:
- revisionId
- workspaceDir
- archivePath
- sourceHash
- patchPath
- patchApplied
- patchApplyLog

Archive exclusions:
- .git
- node_modules
- dist
- source.tgz

## Build/Test Contract

Build worker flow:
1. npm ci (or npm install when no lock file)
2. npm run build
3. npm test -- --watch=false (only if test script exists)

Output:
- success: boolean
- logs: string
- buildDir: string (on success)

## Deployment Contract

Deployment input:
- projectId
- revisionId
- buildDir
- frontendProjectName
- backendService

Deployment output:
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

Known validation class:
- Vercel 400 with missing_project_settings means payload is incomplete for target account/project policy.

## Socket Message Types

Outbound types:
- info
- progress
- stream
- clarification
- confirmation
- error
- done

Inbound intent fields:
- user_message
- answer
- modification

## Preflight Environment Variables

Vercel:
- VERCEL_ACCESS_TOKEN
- VERCEL_TEAM_ID (if team scoped)

Railway deploy trigger:
- RAILWAY_TOKEN
- RAILWAY_PROJECT_ID
- RAILWAY_SERVICE_ID
- RAILWAY_ENVIRONMENT_ID

Model/router essentials:
- GPT4O_MINI_MODEL or related model aliases
- matching API keys for configured aliases