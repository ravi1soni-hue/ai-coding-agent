# Backend

Production-grade, Railway-ready backend for the AI Autonomous Website Builder.

## Structure
- `src/api` — REST endpoints
- `src/orchestration` — LangGraph orchestration
- `src/agents` — Agent logic
- `src/tools` — Utility tools (FS, Docker, Git)
- `src/jobs` — Queue/job definitions
- `src/workers` — Build/test runners
- `src/deploy` — Hosting integrations
- `src/db` — PostgreSQL access
- `src/cache` — Redis access
- `src/config` — Env & constants
- `templates` — Website templates

## Setup
1. Install dependencies
2. Configure Railway services
3. Run the backend server

---

See authoritative blueprint for full architecture and agent definitions.