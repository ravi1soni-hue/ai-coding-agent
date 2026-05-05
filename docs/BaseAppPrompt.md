You are a principal architect redesigning an AI-powered project generation system.

This is a FULL SYSTEM REWRITE.

---

# 🚨 CRITICAL SYSTEM BOUNDARY (NON-NEGOTIABLE)

The system is divided into TWO completely isolated domains:

---

## 1. BASE APP (IMMUTABLE CORE)

This is the permanent system.

Includes:

* socket server (user input)
* orchestration engine
* agent implementations
* deployment logic
* database configuration
* system utilities

STRICT RULES:

❌ NEVER modify base app code during project generation
❌ NEVER write generated files into base app directories
❌ NEVER couple generated code with base app internals
❌ NEVER persist generated project code in base system

If base app is modified, the entire system is considered BROKEN.

---

## 2. GENERATED PROJECT (EPHEMERAL RUNTIME)

This is created per session.

Rules:

* Each session creates one project
* Each project has a unique `projectId`
* All generated code must exist ONLY in:

  * memory (preferred), OR
  * temporary workspace (e.g., `/tmp/project-{projectId}`)

STRICT RULES:

❌ Generated code must NEVER be written into base app repo
❌ Generated code must NEVER affect other sessions
❌ Generated code must be disposable after deployment

---

# 🎯 OBJECTIVE

Rewrite the AI system into:

* self-healing
* state-machine driven
* session-aware
* fully isolated from base app
* capable of generating, fixing, and deploying projects autonomously

---

# ⚙️ GENERATION PIPELINE (NEW MODEL)

1. Receive user requirement via socket (base app)
2. Create session → assign projectId
3. AI orchestrator processes requirement
4. Generate project in MEMORY (file map or virtual FS)
5. Run test + fix loop on generated files ONLY
6. Materialize into temp workspace (if needed)
7. Deploy:

   * frontend → Vercel
   * backend → Railway (if required)
8. Return deployment URLs
9. Destroy workspace

---

# 🌐 DEPLOYMENT MODES

### Frontend-only

* static/mock data
* deploy to Vercel only

### Full-stack

* frontend → Vercel
* backend → Railway
* database → shared PostgreSQL

---

# 🧱 DATABASE RULE (MULTI-TENANT)

* Single shared PostgreSQL instance
* Every table MUST include `project_id`
* Every query MUST filter by `project_id`

No exceptions.

---

# 🔁 SELF-HEALING SYSTEM

* No step should crash the pipeline
* All failures must:
  → be classified
  → be fixed
  → resume execution

---

# 🧠 CENTRAL ORCHESTRATOR

Must manage:

* sessionId
* projectId
* pipeline state
* generated artifacts (in memory)
* errors and fixes
* deployment status

---

# 🧩 EXECUTION ISOLATION (VERY IMPORTANT)

ALL of the following must operate ONLY on generated project:

* code generation
* validation
* testing
* fixing

They MUST NOT:

* read base app files
* modify base app files
* depend on base app structure

---

# 🔧 TEST & FIX CONSTRAINT

Test/Fix agent must:

* operate only on generated file set
* never scan or modify base app
* fix:

  * code issues
  * dependency issues
  * minor structural issues

---

# 📦 FINAL OUTPUT CONTRACT

Return:

{
"projectId": "...",
"frontendUrl": "...",
"backendUrl": "..." | null
}

---

# 🚫 FORBIDDEN ACTIONS

* modifying base app code
* persisting generated files in system repo
* sharing state across sessions
* skipping projectId scoping
* crashing on validation errors

---

# ✅ SUCCESS CRITERIA

* base app remains completely untouched
* each session produces isolated deployable project
* system never crashes on imperfect output
* projects are built in memory and deployed externally
* system recovers from failures automatically

---

Design the system in full detail:

* architecture
* orchestrator
* state machine
* memory model
* execution flow
* deployment flow
* error recovery
