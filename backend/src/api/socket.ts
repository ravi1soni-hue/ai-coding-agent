import { Server, WebSocket as WsWebSocket, type RawData } from 'ws';
import http from 'http';

import { runAIOrchestration } from '../ai/orchestrator/orchestrator';
import { createPersistenceAdapter } from './persistenceAdapter';
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
import { pipelineHub, createHubAdapter } from '../orchestration/pipelineHub';
import type { OrchestrationCommand } from '../ai/contracts/orchestration';

const AFFIRMATIVE = /^(yes|y|yeah|yep|confirm|confirmed|proceed|ok|okay|sure|go|continue)\b/i;
const NEGATIVE = /^(no|n|nope|cancel|stop|abort)\b/i;
const MAX_CONNECTIONS_PER_USER = 5; // Limit connections per user
const MAX_CONNECTIONS_TOTAL = 100; // Global limit

// Track connections
const userConnections = new Map<string, Set<WsWebSocket>>();
const totalConnections = new Set<WsWebSocket>();

// Rate limiting: messages per minute per user
const userMessageCounts = new Map<string, { count: number; resetTime: number }>();
const MAX_MESSAGES_PER_MINUTE = 10;

function sanitizeInput(input: string): string {
  // Remove HTML tags
  let sanitized = input.replace(/<[^>]*>/g, '');
  // Remove script tags and javascript: URLs
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/javascript:/gi, '');
  // Remove potential path traversal
  sanitized = sanitized.replace(/\.\./g, '');
  // Trim and limit length
  sanitized = sanitized.trim();
  if (sanitized.length > 50000) {
    sanitized = sanitized.slice(0, 50000) + '...';
  }
  return sanitized;
}

function rawDataToTextAndSize(raw: RawData): { text: string; byteLength: number } {
  if (typeof raw === 'string') return { text: raw, byteLength: Buffer.byteLength(raw) };
  if (Buffer.isBuffer(raw)) return { text: raw.toString(), byteLength: raw.byteLength };
  if (raw instanceof ArrayBuffer) {
    const buf = Buffer.from(raw);
    return { text: buf.toString(), byteLength: buf.byteLength };
  }

  // ws can also provide Buffer[]
  if (Array.isArray(raw) && raw.every((part) => Buffer.isBuffer(part))) {
    const buf = Buffer.concat(raw);
    return { text: buf.toString(), byteLength: buf.byteLength };
  }

  // Fallback: stringify something stable
  const text = String(raw);
  return { text, byteLength: Buffer.byteLength(text) };
}

function parseConfirmation(text: string): { confirmed: boolean; userResponse: string } {
  const trimmed = text.trim();
  if (NEGATIVE.test(trimmed)) return { confirmed: false, userResponse: trimmed };
  if (AFFIRMATIVE.test(trimmed)) return { confirmed: true, userResponse: trimmed };
  // Anything else: treat as additional context but proceed
  return { confirmed: true, userResponse: trimmed };
}

function addConnection(userId: string, ws: WsWebSocket): boolean {
  if (totalConnections.size >= MAX_CONNECTIONS_TOTAL) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server at capacity. Please try again later.' }));
    ws.close();
    return false;
  }

  const userSockets = userConnections.get(userId) || new Set();
  if (userSockets.size >= MAX_CONNECTIONS_PER_USER) {
    ws.send(JSON.stringify({ type: 'error', message: 'Too many connections for this user.' }));
    ws.close();
    return false;
  }

  userSockets.add(ws);
  userConnections.set(userId, userSockets);
  totalConnections.add(ws);
  return true;
}

function removeConnection(userId: string, ws: WsWebSocket) {
  const userSockets = userConnections.get(userId);
  if (userSockets) {
    userSockets.delete(ws);
    if (userSockets.size === 0) {
      userConnections.delete(userId);
    }
  }
  totalConnections.delete(ws);
}

export function createSocketServer(server: http.Server) {
  const wss = new Server({ server });
  const PING_INTERVAL_MS = 25_000;
  // Allow ~3 missed pongs before reaping. During code generation we ship full
  // file contents through the socket, which can queue ahead of pings and delay
  // the pong well beyond a single 25s window. Using a separate reap threshold
  // (rather than killing on the next tick) prevents spurious disconnects.
  const REAP_AFTER_MS = 75_000;

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const c = client as WsWebSocket & { lastSeenAt?: number };
      if (c.readyState !== c.OPEN) continue;
      if (typeof c.lastSeenAt === 'number' && now - c.lastSeenAt > REAP_AFTER_MS) {
        try { c.terminate(); } catch { /* ignore */ }
        continue;
      }
      try { c.ping(); } catch { /* ignore */ }
    }
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (ws, request) => {
    (ws as WsWebSocket & { lastSeenAt?: number }).lastSeenAt = Date.now();
    ws.on('pong', () => { (ws as WsWebSocket & { lastSeenAt?: number }).lastSeenAt = Date.now(); });
    ws.on('message', () => { (ws as WsWebSocket & { lastSeenAt?: number }).lastSeenAt = Date.now(); });
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

    // Connection limits
    if (!addConnection(authedUser.id, ws)) {
      return; // Connection rejected
    }

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
    // Orchestration publishes to the per-project hub channel; this socket
    // subscribes so it receives live events even if it's a reconnecting client
    // attaching to a pipeline that was started by an earlier (now-dead) socket.
    const adapter = createHubAdapter(projectId);
    const unsubscribe = pipelineHub.subscribe(projectId, (event) => {
      try { ws.send(JSON.stringify(sanitizeEmitEvent(event))); } catch { /* socket may be closing */ }
    });

    function sanitizeEmitEvent(event: any) {
      if (event?.type === 'stage_complete') {
        const { output, ...trimmed } = event;
        return trimmed;
      }
      return event;
    }

    ws.send(JSON.stringify({ type: 'info', stage: 'requirements', message: 'Connected!' }));

    // If a pipeline is already running for this project, let the client know
    // they're attached to the live stream rather than starting fresh.
    if (await pipelineHub.isActive(projectId)) {
      ws.send(JSON.stringify({
        type: 'info',
        stage: 'resume',
        message: 'Resuming live updates for your in-progress build…',
      }));
    }

    ws.on('message', async (raw: RawData) => {
      const { text: rawText, byteLength } = rawDataToTextAndSize(raw);

      // Validate message size (max 10KB)
      if (byteLength > 10240) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message too large.' }));
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawText);

        // If client sent a JSON string (e.g. "\"hello\""), treat it as user_message
        if (typeof parsed === 'string') {
          parsed = { type: 'user_message', user_message: parsed };
        }

        // Validate structure
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('Invalid message structure');
        }

        // Application-level heartbeat: browsers cannot send native WS pings,
        // so the client emits {type:'ping'} every ~25s. Respond and bail.
        if (parsed.type === 'ping') {
          (ws as WsWebSocket & { lastSeenAt?: number }).lastSeenAt = Date.now();
          try { ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch { /* ignore */ }
          return;
        }

        // Check for valid types (type is optional, but if present must be known)
        const validTypes = ['user_message', 'answer', 'modification', 'confirmation'];
        if (parsed.type && !validTypes.includes(parsed.type)) {
          throw new Error('Invalid message type');
        }
      } catch (e) {
        // If it's not JSON at all, accept it as plain user_message text
        if (e instanceof SyntaxError) {
          parsed = { type: 'user_message', user_message: rawText };
        } else {
          const message = e instanceof Error ? e.message : String(e);
          logError('socket:message_parse_failed', { error: message, rawPreview: rawText.slice(0, 100) });
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format. Please send valid JSON.' }));
          return;
        }
      }

      const userText = (typeof parsed === 'object' && parsed !== null
        ? parsed.user_message || parsed.answer || parsed.modification
        : parsed) as string | undefined;

      const sanitizedText = typeof userText === 'string' ? sanitizeInput(userText.trim()) : '';
      if (!sanitizedText) {
        ws.send(JSON.stringify({ type: 'info', stage: 'requirements', message: 'Please send a non-empty message.' }));
        return;
      }

      // Rate limiting
      const now = Date.now();
      const userRate = userMessageCounts.get(authedUser.id) || { count: 0, resetTime: now + 60000 };
      if (now > userRate.resetTime) {
        userRate.count = 0;
        userRate.resetTime = now + 60000;
      }
      if (userRate.count >= MAX_MESSAGES_PER_MINUTE) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Please wait before sending more messages.' }));
        return;
      }
      userRate.count++;
      userMessageCounts.set(authedUser.id, userRate);

      // Don't start a duplicate pipeline if one is already running for this
      // project — but unlike before, don't error out either: this WS is already
      // subscribed to the hub, so it will see the live events.
      if (await pipelineHub.isActive(projectId)) {
        ws.send(JSON.stringify({
          type: 'info',
          stage: 'resume',
          message: 'A build is already running for this project — streaming live updates here.',
        }));
        return;
      }

      // Record the user's own message
      void appendProjectEvent({
        projectId,
        userId: authedUser.id,
        eventType: 'user_message',
        role: 'user',
        message: sanitizedText,
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
          userMessage: memory?.requirements?.userMessage || sanitizedText,
          modification: sanitizedText,
        };
      } else if (currentState === 'clarification' && memory?.clarifications?.lastQuestion) {
        // Clarification answer keyed by the last asked question
        command = {
          projectId,
          sessionId: projectId,
          userMessage: memory?.requirements?.userMessage || '',
          clarificationAnswers: { [memory.clarifications.lastQuestion]: sanitizedText },
        };
      } else if (currentState === 'confirmation') {
        const conf = parseConfirmation(sanitizedText);
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
          userMessage: sanitizedText,
        };
      }

      // Race-safe acquire: in-process + Redis (when enabled).
      if (!(await pipelineHub.tryAcquire(projectId))) {
        ws.send(JSON.stringify({
          type: 'info',
          stage: 'resume',
          message: 'A build is already running for this project — streaming live updates here.',
        }));
        return;
      }
      try {
        const result = await runAIOrchestration(command, adapter, persistence);
        debug('socket:orchestration_result', { projectId, status: result.status, currentState: result.memory.currentState });
        if (result.status === 'completed') {
          await touchProjectSession(authedUser.id, projectId);
        }
      } catch (err) {
        logError('socket:orchestration_failed', err);
        // Publish through the hub so every attached client (not just this one)
        // sees the failure.
        pipelineHub.publish(projectId, {
          type: 'failed',
          projectId,
          issues: [{ message: toClientErrorMessage(err, 'Orchestration failed unexpectedly.') }],
        } as any);
      } finally {
        await pipelineHub.release(projectId);
      }
    });

    ws.on('close', () => {
      unsubscribe();
      removeConnection(authedUser.id, ws);
    });

    ws.on('error', () => {
      unsubscribe();
      removeConnection(authedUser.id, ws);
    });
  });

  return wss;
}
