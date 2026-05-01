# AI Autonomous Website Builder 

This is a **starter skeleton** for:
- Node.js + TypeScript backend
- LangGraph orchestration
- Railway deployment
- Ephemeral Docker workers

## Run locally
```bash
cd backend
npm install
npm run dev
```

## Frontend (React + Vite)
The frontend is now a standalone React app in [frontend](frontend) and is built to [frontend/dist](frontend/dist).

Local frontend development:
```bash
cd frontend
npm install
npm run dev
```

Build frontend for backend static serving:
```bash
cd frontend
npm install
npm run build
```

Then run backend:
```bash
cd backend
npm install
npm run dev
```

The backend serves [frontend/dist](frontend/dist) at the root path `/`.

## Deployment URL and Access Path
When deployed on Railway as a single backend service:
- App URL: `https://<your-railway-domain>`
- Frontend path: `/` (root)
- WebSocket endpoint: same host, protocol auto-switches to `wss://<your-railway-domain>` in production

Users access the app directly from the root URL.

## Deploy
Push to GitHub and connect repo to Railway.
