import { Server } from 'ws';
import http from 'http';

import { runAIOrchestration } from '../ai/orchestrator/orchestrator';
import { createPersistenceAdapter } from './persistenceAdapter';
import { createOrchestrationAdapter } from './orchestrationAdapter';
import {
  createProjectSession,
  getOrCreateActiveProjectSession,
  getUserFromSessionToken,
  isProjectOwnedByUser,
  parseCookie,
  touchProjectSession,
} from '../auth/authService';
import { appendProjectEvent } from '../db/projectStore';
import { config } from '../config/env';
import { debug, error as logError } from '../utils/logger';
import { toClientErrorMessage } from '../utils/errors';
import { TTLSet } from '../utils/ttlSet';
import type { OrchestrationCommand } from '../ai/contracts/orchestration';

const AFFIRMATIVE = /^(yes|y|yeah|yep|confirm|confirmed|proceed|ok|okay|sure|go|continue)\b/i;
const NEGATIVE = /^(no|n|nope|cancel|stop|abort)\b/i;

function parseConfirmation(text: string): { confirmed: boolean; userResponse: string } {
  const trimmed = text.trim();
  if (NEGATIVE.test(trimmed)) return { confirmed: false, userResponse: trimmed };
  if (AFFIRMATIVE.test(trimmed)) return { confirmed: true, userResponse: trimmed };
  // Anything else: treat as additional context but proceed
  return { confirmed: true, userResponse: trimmed };
}

export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });
  const activePipelines = new TTLSet();

  wss.on('connection', async (ws, request) => {
    // Origin check
    const allowedOrigins = config.WS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    const origin = request.headers.origin || '';
    if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
      ws.send(JSON.stringify({ type: 'error', message: 'WebSocket origin not allowed.' }));
      ws.close();
      return;
    }

    // Auth
    const cookies = parseCookie(request.headers.cookie);
    const token = cookies.sid;
    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication required.' }));
      ws.close();
      return;
    }
    const user = await getUserFromSessionToken(token);
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session expired. Please login again.' }));
      ws.close();
      return;
    }
    const authedUser = user;

    // Project routing
    const url = new URL(request.url || '/', 'http://localhost');
    const requestedProjectId = url.searchParams.get('projectId');
    let projectId = await getOrCreateActiveProjectSession(authedUser.id);
    if (requestedProjectId) {
      const owned = await isProjectOwnedByUser(authedUser.id, requestedProjectId);
      projectId = owned ? requestedProjectId : await createProjectSession(authedUser.id);
    }
    await touchProjectSession(authedUser.id, projectId);

    const persistence = createPersistenceAdapter({ projectId, userId: authedUser.id });
    const adapter = createOrchestrationAdapter(ws);

    ws.send(JSON.stringify({ type: 'info', stage: 'requirements', message: 'Connected!' }));

    ws.on('message', async (raw) => {
      let parsed: any;
      try { parsed = JSON.parse(raw.toString()); } catch { parsed = raw.toString(); }

      const userText = (typeof parsed === 'object' && parsed !== null
        ? parsed.user_message || parsed.answer || parsed.modification
        : parsed) as string | undefined;

      const text = typeof userText === 'string' ? userText.trim() : '';
      if (!text) {
        ws.send(JSON.stringify({ type: 'info', stage: 'requirements', message: 'Please send a non-empty message.' }));
        return;
      }

      if (activePipelines.has(projectId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Pipeline already running. Please wait.' }));
        return;
      }

      // Record the user's own message
      void appendProjectEvent({
        projectId,
        userId: authedUser.id,
        eventType: 'user_message',
        role: 'user',
        message: text,
        payload: parsed,
      });

      // Inspect current memory state to decide command shape
      const memory = await persistence.loadSnapshot?.(projectId);
      const currentState = memory?.currentState;
      const completed = memory?.status === 'completed' || currentState === 'done';

      let command: OrchestrationCommand;

      if (completed || (typeof parsed === 'object' && parsed?.type === 'modification' && parsed.modification)) {
        // Post-deployment modification
        command = {
          projectId,
          sessionId: projectId,
          userMessage: memory?.requirements?.userMessage || text,
          modification: text,
        };
      } else if (currentState === 'clarification' && memory?.clarifications?.lastQuestion) {
        // Clarification answer keyed by the last asked question
        command = {
          projectId,
          sessionId: projectId,
          userMessage: memory.requirements?.userMessage || '',
          clarificationAnswers: { [memory.clarifications.lastQuestion]: text },
        };
      } else if (currentState === 'confirmation') {
        const conf = parseConfirmation(text);
        command = {
          projectId,
          sessionId: projectId,
          userMessage: memory?.requirements?.userMessage || '',
          confirmation: conf,
        };
      } else {
        // Initial message (or recovering from a non-pause state — treat as fresh kickoff)
        command = {
          projectId,
          sessionId: projectId,
          userMessage: text,
        };
      }

      activePipelines.add(projectId);
      try {
        const result = await runAIOrchestration(command, adapter, persistence);
        debug('socket:orchestration_result', { projectId, status: result.status, currentState: result.memory.currentState });
        if (result.status === 'completed') {
          await touchProjectSession(authedUser.id, projectId);
        }
      } catch (err) {
        logError('socket:orchestration_failed', err);
        ws.send(JSON.stringify({
          type: 'failed',
          projectId,
          issues: [{ message: toClientErrorMessage(err, 'Orchestration failed unexpectedly.') }],
        }));
      } finally {
        activePipelines.delete(projectId);
      }
    });
  });

  return wss;
}
