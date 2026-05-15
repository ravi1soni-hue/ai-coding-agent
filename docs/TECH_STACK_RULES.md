# Tech Stack Rules — Non-Negotiable

## Fixed Stack

This platform has one stack and one stack only. It is configured at the infrastructure level and cannot be changed per project.

| Layer    | Technology                        |
|----------|-----------------------------------|
| Frontend | React + Vite (JSX, no TypeScript) |
| Backend  | Node.js + TypeScript + Express    |
| Database | PostgreSQL                        |

## What this means for every agent

### Clarification Agent
- **NEVER ask the user about tech stack, data models, database schema, UI component names, or implementation approach.**
- Ask only product/content questions: what to show, who it's for, what the primary actions are, what content exists.
- If a user volunteers tech/implementation details in their answer, acknowledge the intent but do not treat it as a spec constraint. Extract the product intent only.

### System Design Agent
- Always output `frontend.framework = "react-vite"`.
- When `backend_required = true`: always use Express + PostgreSQL. Never design for any other database or runtime.
- When `backend_required = false`: `backend` and `database` fields must be `null`. Ignore any clarification answers that mention PostgreSQL, Prisma, or other databases — no backend = no database, period.

### UI Spec Agent
- Never put technology or library choices in component specs. Components are described by what they render, not how.
- Component count must stay within the feasibility budget (see below).

### Blueprint Agent
- If component count exceeds the feasibility cap, consolidate before passing to code generation.

### Code Generation Agent
- Stack is pre-configured. Never ask for or accept alternative stacks.
- Frontend: React + Vite, plain JSX. No TypeScript in `.jsx` files.
- Backend: TypeScript + Express + `pg` (node-postgres). Never Prisma, Sequelize, or other ORMs.
- Database: PostgreSQL with raw SQL via `pg`. Schema defined in `backend/db/init.sql`.

## Feasibility Budget

Code generation is reliable within these limits. Exceeding them causes truncation and syntax errors.

| Project type       | Max components |
|--------------------|---------------|
| Single page        | 6             |
| 2–3 pages          | 10            |
| 4+ pages           | 14            |

If a user's request implies more components than the budget allows, the UI Spec agent must consolidate — combine related sub-features into a single component rather than splitting them out.

## Why this is fixed

Asking the user about tech stack produces two problems:
1. Users who know the answer give implementation instructions that inflate component count and complexity beyond what the generator can reliably build.
2. Users who don't know the answer get confused and stall.

The stack is decided. The only decisions that belong to the user are product decisions: what to build, for whom, with what content.
