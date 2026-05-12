#!/usr/bin/env node
/**
 * pipeline-test.js — Local end-to-end pipeline validation (socket-driven)
 *
 * What this script now does (end-to-end):
 *   1) Checks env + infra connectivity (optional Redis/Postgres)
 *   2) Boots the real server (Fastify + WS) on an ephemeral port
 *   3) Creates a real user via /api/auth/signup and logs in via /api/auth/login
 *   4) Opens a real WS connection using the returned session cookie (sid)
 *   5) Sends the userMessage and then drives orchestration gates by listening:
 *        - clarification_request  → respond with answers until clarification completes
 *        - confirmation_request    → respond "yes"
 *   6) Asserts stage coverage in the live WS event stream:
 *        requirements → clarification → confirmation →
 *        system_design → ui_spec → blueprint →
 *        code_generation → testing → deployment → done OR failed
 *   7) Verifies persisted state via REST snapshot/events:
 *        - /api/projects/current
 *        - /api/projects/:projectId/snapshot
 *        - /api/projects/:projectId/events (sanity checks: file_generated, stage events)
 *   8) Optionally attempts deployment success verification if your env provides tokens.
 *
 * Usage:
 *   node backend/scripts/pipeline-test.js
 *   node backend/scripts/pipeline-test.js --skip docker,redis,postgres
 *   node backend/scripts/pipeline-test.js --skip infra,tsc
 *   node backend/scripts/pipeline-test.js --e2e-only
 *   node backend/scripts/pipeline-test.js --live-prompt "..."         (custom userMessage)
 *   node backend/scripts/pipeline-test.js --logs-path logs.json       (best-effort extraction)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const { execSync, spawn } = require('child_process');

// Optional-only: ws is only used in the e2e section
let WS = null;
try { WS = require('ws'); } catch { /* handled later */ }

// ─── pretty logging ──────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function log(level, ...parts) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = {
    info: `${DIM}${ts}${RESET} ${CYAN}ℹ${RESET} `,
    ok: `${DIM}${ts}${RESET} ${GREEN}✔${RESET} `,
    warn: `${DIM}${ts}${RESET} ${YELLOW}⚠${RESET} `,
    error: `${DIM}${ts}${RESET} ${RED}✘${RESET} `,
    head: `\n${BOLD}${MAGENTA}`,
  }[level] || '';
  const suffix = level === 'head' ? RESET : '';
  console.log(prefix + parts.join(' ') + suffix);
}

function pass(name, detail = '') { log('ok', `${BOLD}${name}${RESET}${detail ? '  ' + DIM + detail + RESET : ''}`); }
function fail(name, detail = '') { log('error', `${BOLD}${name}${RESET}${detail ? '  ' + DIM + detail + RESET : ''}`); }
function skip(name, reason = '') { log('warn', `${BOLD}${name}${RESET} (skipped${reason ? ': ' + reason : ''})`); }

// ─── load .env ────────────────────────────────────────────────────────────────
const dotenvPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(dotenvPath)) {
  const lines = fs.readFileSync(dotenvPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
  log('info', `Loaded .env from ${dotenvPath}`);
} else {
  log('warn', '.env not found — using existing environment variables only');
}

// ─── arg parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const skipIdx = args.indexOf('--skip');
const promptIdx = args.indexOf('--live-prompt');
const logsIdx = args.indexOf('--logs-path');
const e2eOnly = args.includes('--e2e-only');

const onlyList = onlyIdx !== -1 ? (args[onlyIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;
const skipList = skipIdx !== -1 ? (args[skipIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : [];
const livePrompt = promptIdx !== -1 ? args[promptIdx + 1] : null;
const logsPath = logsIdx !== -1 ? args[logsIdx + 1] : null;

const resultPathIdx = args.indexOf('--result-path');
const resultPath =
  resultPathIdx !== -1 && args[resultPathIdx + 1]
    ? args[resultPathIdx + 1]
    : '/tmp/pipeline-test-e2e.json';

function shouldRun(section) {
  if (onlyList && !onlyList.includes(section)) return false;
  if (skipList.includes(section)) return false;
  return true;
}

// ─── result tracker ──────────────────────────────────────────────────────────
const results = [];
function record(section, name, ok, detail = '') {
  results.push({ section, name, ok, detail });
  if (ok) pass(`[${section}] ${name}`, detail);
  else fail(`[${section}] ${name}`, detail);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function getEnv(key) { return (process.env[key] || '').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGet(url, { timeoutMs = 8000, headers = {}, ignoreCodes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (!ignoreCodes.includes(res.statusCode) && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

async function httpPostWithHeaders(url, payload, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const lib = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || (url.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function httpPost(url, payload, { timeoutMs = 15000, headers = {} } = {}) {
  const res = await httpPostWithHeaders(url, payload, { timeoutMs, headers });
  return { status: res.status, body: res.body };
}

function parseSidFromSetCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const sc of arr) {
    const m = sc.match(/sid=([^;]+)/i);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Best-effort extraction of userMessage + known clarification Q/A from --logs-path.
// Supports multiple possible shapes because logs are produced by different components.
function extractPromptFromLogs(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed) return null;

    if (typeof parsed.userMessage === 'string' && parsed.userMessage.trim()) return parsed.userMessage.trim();
    if (typeof parsed.user_message === 'string' && parsed.user_message.trim()) return parsed.user_message.trim();

    // Generic traversal: find first string at keys commonly used.
    const seen = new Set();
    const stack = [parsed];

    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (const item of cur) stack.push(item);
        continue;
      }

      const candidateKeys = ['userMessage', 'user_message', 'requirement', 'requirementText', 'message', 'content'];
      for (const k of candidateKeys) {
        const v = cur[k];
        if (typeof v === 'string' && v.trim()) {
          // Avoid picking random "stage" messages.
          const lower = v.toLowerCase();
          if (lower.includes('connected!') || lower.includes('orchestration') || lower === 'done') continue;
          return v.trim();
        }
      }

      for (const v of Object.values(cur)) stack.push(v);
    }
  } catch {
    // ignore
  }
  return null;
}

function extractClarificationAnswersFromLogs(filePath) {
  if (!filePath) return {};
  if (!fs.existsSync(filePath)) return {};

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = safeJsonParse(raw);
    if (!parsed) return {};

    const direct =
      (parsed && typeof parsed.clarificationAnswers === 'object' && parsed.clarificationAnswers) ||
      (parsed && typeof parsed.clarification_answers === 'object' && parsed.clarification_answers) ||
      (parsed && typeof parsed.clarifications === 'object' && parsed.clarifications?.answers && typeof parsed.clarifications.answers === 'object' && parsed.clarifications.answers);

    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const out = {};
      for (const [q, a] of Object.entries(direct)) {
        if (typeof q === 'string' && q.trim() && typeof a === 'string' && a.trim()) out[q.trim()] = a.trim();
      }
      return out;
    }

    // Generic traversal of Q/A-like objects
    const seen = new Set();
    const stack = [parsed];
    const out = {};

    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (const item of cur) stack.push(item);
        continue;
      }

      const maybeQ = cur.question || cur.q || cur.prompt || cur.clarificationQuestion || cur.clarification_question;
      const maybeA = cur.answer || cur.a || cur.response || cur.clarificationAnswer || cur.clarification_answer;

      if (typeof maybeQ === 'string' && maybeQ.trim() && typeof maybeA === 'string' && maybeA.trim()) {
        out[maybeQ.trim()] = maybeA.trim();
      }

      for (const v of Object.values(cur)) stack.push(v);
    }

    return out;
  } catch {
    // ignore
  }

  return {};
}

async function llmProxyChatCompletion(messages, { apiKey, chatUrl, model, temperature = 0.1, top_p = 0.9, max_tokens = 300, timeoutMs = 120_000 } = {}) {
  if (!apiKey || String(apiKey).trim().length < 3) throw new Error('LLM proxy: missing apiKey');
  if (!chatUrl || String(chatUrl).trim().length < 3) throw new Error('LLM proxy: missing chatUrl');
  if (!model || String(model).trim().length < 1) throw new Error('LLM proxy: missing model');

  if (typeof fetch !== 'function') {
    throw new Error('LLM proxy: global fetch() not available in this Node runtime');
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestPayload = { model, messages, temperature, top_p, max_tokens };
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`LLM proxy HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    const parsed = safeJsonParse(raw);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`LLM proxy JSON missing content: ${raw.slice(0, 300)}`);
    }
    return content.trim();
  } finally {
    clearTimeout(t);
  }
}

async function generateClarificationAnswerViaLLM({ question, userMessage } = {}) {
  const apiKey = getEnv('GPT4O_MINI_API_KEY') || getEnv('GPT4O_MINI_MODEL_ID') || getEnv('OPENAI_API_KEY');
  const chatUrl = getEnv('LLM_PROXY_CHAT_URL');
  const model =
    getEnv('GPT4O_MINI_MODEL') ||
    getEnv('GPT4O_MINI_MODEL_ID') ||
    'gpt-4o-mini';

  const system = 'You are an automated assistant helping an e2e pipeline test. Return only a short direct answer.';
  const prompt = [
    `User request:`,
    String(userMessage || '').slice(0, 1200),
    '',
    `Clarification question:`,
    String(question || '').slice(0, 800),
    '',
    `Answer with a single concise paragraph. No bullets. No commentary. Do not quote the question.`,
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  return llmProxyChatCompletion(messages, { apiKey, chatUrl, model, temperature: 0.2, max_tokens: 260 });
}

// ─── SECTION 1: Environment Variables ────────────────────────────────────────
async function testEnv() {
  log('head', '1. ENVIRONMENT VARIABLES');

  const required = [
    ['LLM_PROXY_CHAT_URL', 'LLM chat endpoint'],
    ['LLM_PROXY_EMBEDDING_URL', 'LLM embedding endpoint'],
  ];

  let allRequired = true;
  for (const [k, desc] of required) {
    const v = getEnv(k);
    if (!v) {
      record('env', k, false, `MISSING — ${desc}`);
      allRequired = false;
    } else record('env', k, true, `${v.slice(0, 60)}…`);
  }

  const apiKey = getEnv('GPT4O_MINI_API_KEY') || getEnv('GPT4O_MINI_MODEL_ID') || getEnv('OPENAI_API_KEY');
  if (!apiKey) record('env', 'API_KEY_RESOLVED', false, 'No API key found in GPT4O_MINI_API_KEY / GPT4O_MINI_MODEL_ID / OPENAI_API_KEY');
  else record('env', 'API_KEY_RESOLVED', true, `key starts with "${apiKey.slice(0, 8)}…"`);
  return allRequired;
}

// ─── SECTION 2: Redis ────────────────────────────────────────────────────────
async function testRedis() {
  log('head', '2. REDIS');
  const url = getEnv('REDIS_URL');
  if (!url) {
    skip('redis', 'REDIS_URL not set — Redis optional');
    return true;
  }

  let Redis;
  try { Redis = require('ioredis'); } catch {
    record('redis', 'ioredis_import', false, 'ioredis not installed');
    return false;
  }

  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await client.connect();
    const pong = await client.ping();
    record('redis', 'PING', pong === 'PONG', pong);

    const testKey = `pipeline_test_${Date.now()}`;
    await client.set(testKey, 'ok', 'PX', 5000);
    const val = await client.get(testKey);
    record('redis', 'SET/GET', val === 'ok', `key=${testKey}`);

    const streamKey = `pipeline_test_stream_${Date.now()}`;
    await client.xadd(streamKey, 'MAXLEN', '~', 10, '*', 'field', 'value');
    const entries = await client.xlen(streamKey);
    record('redis', 'XADD/XLEN', entries > 0, `stream has ${entries}`);
    await client.del(streamKey);

    await client.quit();
    return true;
  } catch (err) {
    record('redis', 'CONNECTION', false, err.message);
    try { await client.quit(); } catch {}
    return false;
  }
}

// ─── SECTION 3: Postgres ────────────────────────────────────────────────────
async function testPostgres() {
  log('head', '3. POSTGRES');
  const url = getEnv('POSTGRES_URL') || getEnv('DATABASE_URL');
  if (!url) {
    skip('postgres', 'Postgres URL not set — DB features unavailable');
    return true;
  }

  let pg;
  try { pg = require('pg'); } catch {
    record('postgres', 'pg_import', false, 'pg not installed');
    return false;
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('railway') || url.includes('sslmode') ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });

  try {
    const res = await pool.query('SELECT 1 AS ok, version() AS v');
    record('postgres', 'SELECT 1', res.rows[0]?.ok === 1, res.rows[0]?.v?.slice(0, 50));
    await pool.end();
    return true;
  } catch (err) {
    record('postgres', 'CONNECTION', false, err.message);
    try { await pool.end(); } catch {}
    return false;
  }
}

// ─── SECTION 4: TypeScript Build ─────────────────────────────────────────────
async function testTypeCheck() {
  log('head', '4. TYPESCRIPT TYPE-CHECK');
  const backendDir = path.resolve(__dirname, '..');
  try {
    execSync('npx tsc --noEmit', { cwd: backendDir, stdio: 'pipe', timeout: 60000 });
    record('tsc', 'NO_ERRORS', true);
    return true;
  } catch (err) {
    const output = (err.stdout || err.stderr || err.message || '').toString();
    const errorLines = output.split('\n').filter(l => l.includes('error TS')).slice(0, 20);
    record('tsc', 'NO_ERRORS', false, `${errorLines.length} TS errors`);
    return false;
  }
}

// ─── SECTION 5: Server Boot (kept alive for e2e) ────────────────────────────
async function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

async function startServerKeepAlive() {
  log('head', '5. SERVER BOOT (for e2e)');
  const basePort = parseInt(getEnv('PORT') || '3000', 10);
  const testPort = basePort + 100 + Math.floor(Math.random() * 1000);

  const ok = await isPortFree(testPort);
  if (!ok) {
    record('server', 'PORT_FREE', false, `Port ${testPort} in use`);
    return null;
  }
  record('server', 'PORT_FREE', true, `port ${testPort} available`);

  log('info', `Starting ts-node backend/src/index.ts on port ${testPort}...`);
  const env = { ...process.env, PORT: String(testPort), NODE_ENV: 'test' };
  const proc = spawn('npx', ['ts-node', 'src/index.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', c => { stdout += c; });
  proc.stderr.on('data', c => { stderr += c; });

  const started = await new Promise((resolve) => {
    const deadlineAt = Date.now() + 25_000;

    const attempt = async () => {
      try {
        const res = await httpGet(`http://127.0.0.1:${testPort}/health`, {
          timeoutMs: 900,
          ignoreCodes: [503, 502],
        });
        if (res && res.status < 500) return resolve(true);
      } catch {
        // keep polling
      }

      if (Date.now() > deadlineAt) return resolve(false);
      setTimeout(() => void attempt(), 500);
    };

    void attempt();

    proc.on('exit', () => resolve(false));
  });

  if (!started) {
    record('server', 'BOOT', false, `Failed to start (health never became ready within 25s). stderr tail: ${stderr.slice(-300)}`);
    try { proc.kill('SIGTERM'); } catch {}
    return null;
  }

  await sleep(200);

  try {
    const res = await httpGet(`http://127.0.0.1:${testPort}/health`, { timeoutMs: 8000, ignoreCodes: [503, 502] });
    record('server', 'HEALTH_ENDPOINT', res.status < 500, `HTTP ${res.status}`);
  } catch (err) {
    record('server', 'HEALTH_ENDPOINT', false, err.message);
  }

  const TAIL_CHARS = 20000;
  return {
    proc,
    port: testPort,
    baseUrl: `http://127.0.0.1:${testPort}`,
    getStdoutTail: () => stdout.slice(-TAIL_CHARS),
    getStderrTail: () => stderr.slice(-TAIL_CHARS),
    stop: async () => {
      try { proc.kill('SIGTERM'); } catch {}
      await sleep(300);
      return { stdoutTail: stdout.slice(-TAIL_CHARS), stderrTail: stderr.slice(-TAIL_CHARS) };
    },
  };
}

// ─── SECTION 6: Socket-driven Full Pipeline E2E ─────────────────────────────
async function testSocketE2E({ userMessage, timeoutMs = 25 * 60_000, resultPath: resultPathArg } = {}) {
  log('head', '6. SOCKET-DRIVEN FULL PIPELINE (requirements→deployment)');

  const resultPathFinal = typeof resultPathArg === 'string' && resultPathArg.trim()
    ? resultPathArg
    : '/tmp/pipeline-test-e2e.json';

  const writeE2E = (payload) => {
    try { fs.writeFileSync(resultPathFinal, JSON.stringify(payload, null, 2), 'utf8'); } catch {}
  };

  writeE2E({
    ok: false,
    phase: 'started',
    startedAt: new Date().toISOString(),
    userMessage,
    timeoutMs,
    resultPath: resultPathFinal,
    stagesSeen: [],
    missingStages: [],
    fileGeneratedCount: 0,
    status: null,
    lastEventType: null,
    lastStage: null,
    lastEventAt: null,
    lastWriteAt: new Date().toISOString(),
    reason: null,
  });

  if (!WS) {
    record('e2e', 'ws_import', false, 'ws package missing');
    return false;
  }

  const server = await startServerKeepAlive();
  if (!server) return false;

  const projectSnapshotVerify = async (projectId, userId, labelPrefix) => {
    try {
      const snapshotRes = await httpGet(`${server.baseUrl}/api/projects/${projectId}/snapshot`, { timeoutMs: 20000, headers: { cookie: `sid=${userId}` } });
      // NOTE: above assumes userId is sid; we don't. We'll avoid this in favor of using real cookie below.
      return { ok: true, snapshot: safeJsonParse(snapshotRes.body) };
    } catch {
      return { ok: false };
    }
  };

  // Auth: signup/login so WS auth middleware passes.
  const email = `pipe_user_${Date.now()}@example.com`;
  const password = 'Password123!';
  const name = `PipelineUser${Date.now()}`;

  let authCookie = null;

  try {
    const signupRes = await httpPostWithHeaders(`${server.baseUrl}/api/auth/signup`, { name, email, password }, { timeoutMs: 20000 });
    if (signupRes.status >= 400) throw new Error(`signup failed: ${signupRes.status} ${signupRes.body.slice(0, 120)}`);

    const loginRes = await httpPostWithHeaders(`${server.baseUrl}/api/auth/login`, { email, password }, { timeoutMs: 20000 });
    authCookie = parseSidFromSetCookie(loginRes.headers['set-cookie']);
    if (!authCookie) throw new Error(`No sid cookie returned from login. headers=${JSON.stringify(loginRes.headers)}`);

    record('e2e', 'auth_login_sid', true, `sid=${authCookie.slice(0, 10)}…`);
  } catch (err) {
    record('e2e', 'auth_login', false, err.message);
    await server.stop();
    return false;
  }

  // Create a fresh project session so we can select it as ACTIVE.
  let projectId = null;
  try {
    const createRes = await httpPostWithHeaders(`${server.baseUrl}/api/projects/new`, {}, {
      timeoutMs: 20000,
      headers: { cookie: `sid=${authCookie}` },
    });
    const data = safeJsonParse(createRes.body);
    projectId = data?.projectId || null;
    if (!projectId) throw new Error(`projectId missing in /api/projects/new: ${createRes.body.slice(0, 200)}`);
    record('e2e', 'projectId_new', true, projectId);
  } catch (err) {
    record('e2e', 'projectId_new', false, err.message);
    await server.stop();
    return false;
  }

  // Ensure the new project is the ACTIVE session for this user.
  try {
    await httpPostWithHeaders(`${server.baseUrl}/api/projects/select`, { projectId }, {
      timeoutMs: 20000,
      headers: { cookie: `sid=${authCookie}` },
    });
    record('e2e', 'projectId_selected', true, projectId);
  } catch (err) {
    record('e2e', 'projectId_selected', false, err && err.message ? err.message : String(err));
    await server.stop();
    return false;
  }

  // IMPORTANT: the socket server will attach to *its* computed active projectId.
  // Fetch it from the server so WS subscription channel + REST snapshot/events always match.
  try {
    const curRes = await httpGet(`${server.baseUrl}/api/projects/current`, {
      timeoutMs: 20000,
      headers: { cookie: `sid=${authCookie}` },
    });
    const data = safeJsonParse(curRes.body);
    const activeProjectId = data?.projectId || null;
    if (!activeProjectId) throw new Error(`projectId missing in /api/projects/current: ${curRes.body.slice(0, 200)}`);
    if (activeProjectId !== projectId) record('e2e', 'projectId_active_mismatch', true, `from=${projectId} to=${activeProjectId}`);
    projectId = activeProjectId;
  } catch (err) {
    record('e2e', 'projectId_active_fetch', false, err && err.message ? err.message : String(err));
    await server.stop();
    return false;
  }

  // Connect WS WITHOUT a projectId query param to avoid ownership mismatch routing.
  const wsUrl = `ws://127.0.0.1:${server.port}`;
  record('e2e', 'ws_url', true, wsUrl);

  const ws = new WS(wsUrl, { headers: { cookie: `sid=${authCookie}` } });

  const seen = {
    stages: new Set(),
    clarificationRequests: 0,
    confirmationRequests: 0,
    fileGeneratedCount: 0,
    done: false,
    failed: false,
    lastDoneEvent: null,
    failedIssues: [],
  };

  const stageOrderExpected = [
    'requirements',
    'clarification',
    'confirmation',
    'system_design',
    'ui_spec',
    'blueprint',
    'code_generation',
    'testing',
    'deployment',
  ];

  let currentEventBuffer = [];
  let wsResolved = false;

  // IMPORTANT: must be initialized before ws message handler references it (no TDZ)
  let status = null;

  // Debug/progress guard: if WS starts but no stage events arrive, we still
  // want the result file to move off "phase":"started".
  let wroteFirstWsMessage = false;

  // Throttle writes so we can record *all* WS traffic (incl. progress/info)
  // without hammering the filesystem.
  let lastWsWriteAt = 0;

  let pingTimer = null;

  const clarificationDefaultAnswer = 'Default answer: proceed with defaults for testing.';
  const confirmationAnswer = 'yes';

  const logsClarificationAnswers = extractClarificationAnswersFromLogs(logsPath);
  const usedClarificationAnswers = {};

  function normalizeKey(s) {
    return String(s || '').trim();
  }

  async function resolveClarificationAnswer(questionText) {
    const q = normalizeKey(questionText);
    if (!q) return clarificationDefaultAnswer;

    // 1) If we already answered this question in this run, reuse it.
    if (typeof usedClarificationAnswers[q] === 'string' && usedClarificationAnswers[q].trim()) {
      return usedClarificationAnswers[q].trim();
    }

    // 2) If the logs file contains a direct answer for this exact question text, use it.
    if (typeof logsClarificationAnswers[q] === 'string' && logsClarificationAnswers[q].trim()) {
      usedClarificationAnswers[q] = logsClarificationAnswers[q].trim();
      return usedClarificationAnswers[q];
    }

    // 3) Case-insensitive match fallback (some systems may alter whitespace/case).
    const foundKey = Object.keys(logsClarificationAnswers).find((k) => normalizeKey(k) === q);
    if (foundKey && typeof logsClarificationAnswers[foundKey] === 'string' && logsClarificationAnswers[foundKey].trim()) {
      usedClarificationAnswers[q] = logsClarificationAnswers[foundKey].trim();
      return usedClarificationAnswers[q];
    }

    // 4) Otherwise, try LLM-based generation (if env is set); else default.
    try {
      const generated = await generateClarificationAnswerViaLLM({ question: q, userMessage });
      if (typeof generated === 'string' && generated.trim()) {
        usedClarificationAnswers[q] = generated.trim();
        return usedClarificationAnswers[q];
      }
    } catch {
      // best-effort: fall back to default answer
    }

    usedClarificationAnswers[q] = clarificationDefaultAnswer;
    return clarificationDefaultAnswer;
  }

  function recordStage(stage) {
    if (!stage) return;
    seen.stages.add(String(stage));
  }

  let resolvePromise = null;

  function timeoutError(msg) {
    if (wsResolved) return;
    wsResolved = true;
    record('e2e', 'timeout', false, msg);
    try { ws.terminate(); } catch {}
    try { if (pingTimer) clearInterval(pingTimer); } catch { /* ignore */ }

    // Ensure the harness finishes even if we never receive done/failed.
    if (typeof resolvePromise === 'function') {
      resolvePromise('timeout');
    }
  }

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    const timer = setTimeout(() => timeoutError(`WS orchestration exceeded ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

    // Poll REST snapshot periodically so the harness can still progress/finish
    // even when WS stage events stall or never arrive.
    const pollMs = 10_000;
    let snapshotPollAttempt = 0;
    let snapshotPollFailureNotified = false;

    const pollTimer = setInterval(async () => {
      if (wsResolved) return;
      if (!server || !projectId || !authCookie) return;

      snapshotPollAttempt += 1;

      try {
        const snapshotRes = await httpGet(`${server.baseUrl}/api/projects/${projectId}/snapshot`, {
          timeoutMs: 20000,
          headers: { cookie: `sid=${authCookie}` },
        });
        const snapshot = safeJsonParse(snapshotRes.body);
        if (!snapshot) {
          if (!snapshotPollFailureNotified) {
            snapshotPollFailureNotified = true;
            lastWsWriteAt = Date.now();
            writeE2E({
              ok: false,
              phase: 'progress',
              status: status || null,
              userMessage,
              timeoutMs,
              resultPath: resultPathFinal,
              stagesSeen: Array.from(seen.stages.values()),
              missingStages: [],
              fileGeneratedCount: seen.fileGeneratedCount,
              lastEventType: 'snapshot_poll_parse_failed',
              lastStage: null,
              lastEventMessage: `snapshotPollAttempt=${snapshotPollAttempt}`,
              snapshotStatus: null,
              snapshotCurrentStep: null,
              snapshotRaw: { bodyPrefix: String(snapshotRes.body || '').slice(0, 200) },
              lastEventAt: new Date().toISOString(),
            });
          }
          return;
        }

        const curStep = snapshot.currentStep ?? snapshot.current_step ?? null;
        const snapshotStatus = snapshot.status ?? null;

        if (typeof curStep === 'string' && stageOrderExpected.includes(curStep)) {
          if (!seen.stages.has(curStep)) {
            recordStage(curStep);
          }
        }

        // Always persist snapshot state changes at a low rate so we can diagnose stalls.
        const shouldPersistSnapshot =
          (Date.now() - lastWsWriteAt > 5000) ||
          (typeof curStep === 'string' && stageOrderExpected.includes(curStep) && !seen.stages.has(curStep));

        if (shouldPersistSnapshot) {
          lastWsWriteAt = Date.now();
          writeE2E({
            ok: false,
            phase: 'progress',
            status: status || null,
            userMessage,
            timeoutMs,
            resultPath: resultPathFinal,
            stagesSeen: Array.from(seen.stages.values()),
            missingStages: [],
            fileGeneratedCount: seen.fileGeneratedCount,
            lastEventType: 'snapshot_poll',
            lastStage: typeof curStep === 'string' ? curStep : null,
            lastEventMessage: `snapshot.status=${snapshotStatus} currentStep=${String(curStep)}`,
            snapshotStatus,
            snapshotCurrentStep: curStep,
            snapshotRaw: {
              status: snapshotStatus,
              currentStep: curStep,
              projectId: snapshot.projectId ?? null,
              serverStderrTail: server && typeof server.getStderrTail === 'function' ? server.getStderrTail().slice(-3000) : null,
              serverStdoutTail: server && typeof server.getStdoutTail === 'function' ? server.getStdoutTail().slice(-3000) : null,
            },
            lastEventAt: new Date().toISOString(),
          });
        }

        if (snapshot.status === 'completed' || snapshot.status === 'failed') {
          // Treat DB terminal state as authoritative.
          wsResolved = true;
          clearTimeout(timer);
          clearInterval(pollTimer);
          status = snapshot.status === 'completed' ? 'done' : 'failed';
          try { ws.terminate(); } catch {}

          resolve(status);
        }
      } catch (err) {
        if (!snapshotPollFailureNotified) {
          snapshotPollFailureNotified = true;
          lastWsWriteAt = Date.now();
          writeE2E({
            ok: false,
            phase: 'progress',
            status: status || null,
            userMessage,
            timeoutMs,
            resultPath: resultPathFinal,
            stagesSeen: Array.from(seen.stages.values()),
            missingStages: [],
            fileGeneratedCount: seen.fileGeneratedCount,
            lastEventType: 'snapshot_poll_error',
            lastStage: null,
            lastEventMessage: `snapshotPollAttempt=${snapshotPollAttempt} error=${err && err.message ? err.message : String(err)}`,
            snapshotStatus: null,
            snapshotCurrentStep: null,
            snapshotRaw: null,
            lastEventAt: new Date().toISOString(),
          });
        }
        // best-effort polling: ignore subsequent failures
      }
    }, pollMs);

    ws.on('open', () => {
      record('e2e', 'ws_open', true);
      // Send kickoff message in expected shape
      ws.send(JSON.stringify({ type: 'user_message', user_message: userMessage }));

      // App-level heartbeat: socket.ts expects periodic {type:'ping'}.
      // This avoids WS timeouts/idle reap during slow LLM/codegen phases.
      if (!pingTimer) {
        pingTimer = setInterval(() => {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
        }, 25_000);
      }
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Write once on first WS message so the result file can't remain stuck at phase:"started"
      if (!wroteFirstWsMessage) {
        wroteFirstWsMessage = true;
        writeE2E({
          ok: false,
          phase: 'progress',
          status: status || null,
          userMessage,
          timeoutMs,
          resultPath: resultPathFinal,
          stagesSeen: Array.from(seen.stages.values()),
          missingStages: [],
          fileGeneratedCount: seen.fileGeneratedCount,
          lastEventType: msg?.type || null,
          lastStage: msg?.stage || null,
          lastEventMessage: msg?.message || null,
          lastEventAt: new Date().toISOString(),
        });
      }

      // Also persist info() messages (these include "resume" when pipelineHub refuses to acquire).
      if (msg?.type === 'info') {
        recordStage(msg?.stage);
        if (Date.now() - lastWsWriteAt > 1000) {
          lastWsWriteAt = Date.now();
          writeE2E({
            ok: false,
            phase: 'progress',
            status: status || null,
            userMessage,
            timeoutMs,
            resultPath: resultPathFinal,
            stagesSeen: Array.from(seen.stages.values()),
            missingStages: [],
            fileGeneratedCount: seen.fileGeneratedCount,
            lastEventType: msg?.type || null,
            lastStage: msg?.stage || null,
            lastEventMessage: msg?.message || null,
            lastEventAt: new Date().toISOString(),
          });
        }
      }

      // Persist orchestration progress events too.
      if (msg?.type === 'progress') {
        recordStage(msg?.stage);
        if (Date.now() - lastWsWriteAt > 800) {
          lastWsWriteAt = Date.now();
          writeE2E({
            ok: false,
            phase: 'progress',
            status: status || null,
            userMessage,
            timeoutMs,
            resultPath: resultPathFinal,
            stagesSeen: Array.from(seen.stages.values()),
            missingStages: [],
            fileGeneratedCount: seen.fileGeneratedCount,
            lastEventType: msg?.type || null,
            lastStage: msg?.stage || null,
            lastEventMessage: msg?.message || null,
            percent: typeof msg?.percent === 'number' ? msg.percent : undefined,
            lastEventAt: new Date().toISOString(),
          });
        }
      }

      currentEventBuffer.push(msg);
      if (currentEventBuffer.length > 2000) currentEventBuffer = currentEventBuffer.slice(-2000);
      // Track stage coverage by outer stage types from events.
      if (msg.type === 'stage_start' || msg.type === 'stage_complete' || msg.type === 'stage_error') {
        recordStage(msg.stage);
        writeE2E({
          ok: false,
          phase: 'progress',
          status: status || null,
          userMessage,
          timeoutMs,
          resultPath: resultPathFinal,
          stagesSeen: Array.from(seen.stages.values()),
          missingStages: [],
          fileGeneratedCount: seen.fileGeneratedCount,
          lastEventType: msg.type,
          lastStage: msg.stage,
          lastEventAt: new Date().toISOString(),
        });
      }

      if (msg.type === 'clarification_request') {
        seen.clarificationRequests += 1;
        // Even if the orchestrator doesn't emit stage_start/stage_complete for this gate in some paths,
        // the existence of a clarification_request is the authoritative signal that the gate ran.
        recordStage(msg.stage || 'clarification');

        writeE2E({
          ok: false,
          phase: 'progress',
          status: status || null,
          userMessage,
          timeoutMs,
          resultPath: resultPathFinal,
          stagesSeen: Array.from(seen.stages.values()),
          missingStages: [],
          fileGeneratedCount: seen.fileGeneratedCount,
          lastEventType: msg.type,
          lastStage: msg.stage,
          clarificationRequests: seen.clarificationRequests,
          lastEventAt: new Date().toISOString(),
        });

        // Answer the exact clarification question the orchestrator asked.
        // Contract: clarification_request includes `questions: string[]` (currently usually length=1).
        const questionText =
          Array.isArray(msg.questions) && msg.questions.length > 0
            ? String(msg.questions[0])
            : normalizeKey(msg.lastQuestion || msg.question || '');

        const answerText = await resolveClarificationAnswer(questionText);
        usedClarificationAnswers[questionText] = answerText;

        // socket.ts maps answers to memory.clarifications.lastQuestion
        ws.send(JSON.stringify({ type: 'user_message', user_message: answerText }));
      }

      if (msg.type === 'confirmation_request') {
        seen.confirmationRequests += 1;
        // The confirmation gate might not emit stage_* events for confirmation,
        // but confirmation_request is the definitive indicator.
        recordStage(msg.stage || 'confirmation');

        writeE2E({
          ok: false,
          phase: 'progress',
          status: status || null,
          userMessage,
          timeoutMs,
          resultPath: resultPathFinal,
          stagesSeen: Array.from(seen.stages.values()),
          missingStages: [],
          fileGeneratedCount: seen.fileGeneratedCount,
          lastEventType: msg.type,
          lastStage: msg.stage,
          confirmationRequests: seen.confirmationRequests,
          lastEventAt: new Date().toISOString(),
        });
        ws.send(JSON.stringify({ type: 'user_message', user_message: confirmationAnswer }));
      }

      if (msg.type === 'file_generated') {
        seen.fileGeneratedCount += 1;
      }

      if (msg.type === 'done') {
        seen.done = true;
        seen.lastDoneEvent = msg;
        if (!wsResolved) {
          wsResolved = true;
          clearTimeout(timer);
          resolve('done');
        }
        return;
      }

      if (msg.type === 'failed') {
        seen.failed = true;
        seen.failedIssues = msg.issues || [];
        if (!wsResolved) {
          wsResolved = true;
          clearTimeout(timer);
          resolve('failed');
        }
        return;
      }

      // Some deployments may fail and never emit done/failed; keep the buffer anyway.
    });

    ws.on('error', (err) => {
      if (wsResolved) return;
      wsResolved = true;
      clearTimeout(timer);
      try { if (pingTimer) clearInterval(pingTimer); } catch { /* ignore */ }
      record('e2e', 'ws_error', false, err.message);
      resolve('ws_error');
    });

    ws.on('close', () => {
      if (wsResolved) return;
      wsResolved = true;
      clearTimeout(timer);
      try { if (pingTimer) clearInterval(pingTimer); } catch { /* ignore */ }
      resolve('ws_closed');
    });
  });

  try {
    status = await promise;
  } catch (err) {
    status = 'exception';
  }

  // Close WS
  try { ws.terminate(); } catch {}

  // Assert stage coverage
  function stageIsSeen(stage) {
    // confirmation gate is represented by confirmation_request events in socket.ts
    if (stage === 'confirmation') return seen.confirmationRequests > 0 || seen.stages.has(stage);
    return seen.stages.has(stage);
  }

  const stageCoverage = stageOrderExpected.map((s) => ({
    stage: s,
    ok: stageIsSeen(s),
  }));

  const missing = stageCoverage.filter((x) => !x.ok).map((x) => x.stage);

  const serverStderrTailPre = server && typeof server.getStderrTail === 'function' ? server.getStderrTail() : '';
  const serverStdoutTailPre = server && typeof server.getStdoutTail === 'function' ? server.getStdoutTail() : '';
  const crashDetected =
    status === 'ws_closed' ||
    status === 'ws_error' ||
    status === 'timeout' ||
    status === 'exception' ||
    /FATAL ERROR: Reached heap limit|JavaScript heap out of memory|out of memory/i.test(serverStderrTailPre);

  const missingForReport = crashDetected ? [] : missing;

  if (crashDetected) {
    const reason = /out of memory/i.test(serverStderrTailPre)
      ? 'process_out_of_memory'
      : /ECONNREFUSED|ECONNRESET/i.test(serverStderrTailPre)
        ? 'connection_refused'
        : 'websocket_closed_crash';
    record('e2e', 'stage_coverage', false, `orchestration crashed (${reason}) — see server stderr/stdout tails`);
  } else if (missingForReport.length === 0) {
    record('e2e', 'stage_coverage', true, `all stages seen`);
  } else {
    record('e2e', 'stage_coverage', false, `missing: ${missingForReport.join(', ')}`);
  }

  record('e2e', 'clarification_gate', seen.clarificationRequests > 0 || seen.stages.has('clarification'), true, `clarification_request_count=${seen.clarificationRequests}`);
  record('e2e', 'confirmation_gate', seen.confirmationRequests > 0 || seen.stages.has('confirmation'), true, `confirmation_request_count=${seen.confirmationRequests}`);
  record('e2e', 'file_generated_sanity', seen.fileGeneratedCount > 0, `file_generated_count=${seen.fileGeneratedCount}`);

  // Persisted state verification
  // Use REST snapshot events to check terminal status.
  let snapshot = null;
  try {
    const snapshotRes = await httpGet(`${server.baseUrl}/api/projects/${projectId}/snapshot`, {
      timeoutMs: 20000,
      headers: { cookie: `sid=${authCookie}` },
    });
    snapshot = safeJsonParse(snapshotRes.body);
    const okState = snapshot?.status === 'completed' || snapshot?.status === 'failed' || snapshot?.status === 'active' || snapshot?.status === 'paused';
    record('e2e', 'snapshot_loaded', okState, snapshot ? `status=${snapshot.status} currentStep=${snapshot.currentStep}` : '');
  } catch (err) {
    record('e2e', 'snapshot_loaded', false, err.message);
  }

  try {
    const eventsRes = await httpGet(`${server.baseUrl}/api/projects/${projectId}/events?limit=5000`, {
      timeoutMs: 20000,
      headers: { cookie: `sid=${authCookie}` },
    });
    const events = safeJsonParse(eventsRes.body)?.events;
    const hasFileEvent = Array.isArray(events) && events.some(e => e.event_type === 'file_generated');
    const hasStageEvents = Array.isArray(events) && events.some(e => e.event_type === 'stage_start' || e.event_type === 'stage_complete');
    record('e2e', 'events_sanity', hasFileEvent && hasStageEvents, `hasFileEvent=${hasFileEvent} hasStageEvents=${hasStageEvents}`);
  } catch (err) {
    record('e2e', 'events_sanity', false, err.message);
  }

  await server.stop();

  // Determine expected outcome: if missing deployment tokens, we might fail at deployment.
  const pre = ['requirements', 'clarification', 'confirmation', 'system_design', 'ui_spec', 'blueprint', 'code_generation', 'testing'];
  const preMissing = pre.filter(s => !seen.stages.has(s));

  const finalOk =
    (status === 'done' && missing.length === 0) ||
    (status === 'failed' && (seen.stages.has('deployment') || missing.includes('deployment') === false) && preMissing.length === 0);

  // Persist final e2e verdict so we can verify even if outer process times out.
  const serverStderrTail = server && typeof server.getStderrTail === 'function' ? server.getStderrTail() : '';
  const serverStdoutTail = server && typeof server.getStdoutTail === 'function' ? server.getStdoutTail() : '';
  const lastWsEventsTail = currentEventBuffer.slice(-30).map((e) => ({
    type: e?.type || null,
    stage: e?.stage || null,
    message: typeof e?.message === 'string' ? e.message.slice(0, 200) : null,
    lastStage: e?.lastStage || null,
    questions: Array.isArray(e?.questions) ? e.questions.slice(0, 3) : undefined,
    summary: typeof e?.summary === 'string' ? e.summary.slice(0, 200) : null,
    filePath: typeof e?.filePath === 'string' ? e.filePath : null,
    issuesCount: Array.isArray(e?.issues) ? e.issues.length : undefined,
  }));

  writeE2E({
    ok: finalOk,
    phase: 'finished',
    finishedAt: new Date().toISOString(),
    status,
    userMessage,
    timeoutMs,
    stagesSeen: Array.from(seen.stages.values()),
    missingStages: missingForReport,
    clarificationRequests: seen.clarificationRequests,
    confirmationRequests: seen.confirmationRequests,
    fileGeneratedCount: seen.fileGeneratedCount,
    snapshot: snapshot ? { status: snapshot.status, currentStep: snapshot.current_step || snapshot.currentStep || null } : null,
    // snapshot schema varies across endpoints; keep raw snapshot object too
    snapshotRaw: snapshot,
    // Server tails help diagnose crashes (e.g., ECONNREFUSED)
    serverStdoutTail,
    serverStderrTail,
    // Best-effort only: events can be huge — don't include raw list, but include a sanitized tail
    currentEventBufferSize: currentEventBuffer.length,
    lastWsEventsTail,
    lastWsEventTypesTail: lastWsEventsTail.map((e) => e.type).filter(Boolean),
  });

  return finalOk;
}

// ─── SECTION 7: Live prompt fallback and full run orchestrator ─────────────
// This script runs real behavior only in the socket E2E section.

async function main() {
  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN}  AI Coding Agent — Full Pipeline Test Suite (socket E2E)${RESET}`);
  console.log(`${BOLD}${CYAN}  ${new Date().toISOString()}${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}\n`);

  if (onlyList) log('info', `Running only: ${onlyList.join(', ')}`);
  if (skipList.length) log('info', `Skipping: ${skipList.join(', ')}`);

  // Determine userMessage
  const extracted = extractPromptFromLogs(logsPath);
  const userMessage =
    livePrompt ||
    extracted ||
    'Create a landing page with a Pricing page (include pricing tiers, responsive layout, and a clear call-to-action).';

  log('info', `E2E userMessage: ${userMessage}`);

  const sections = {
    env: testEnv,
    redis: testRedis,
    postgres: testPostgres,
    tsc: testTypeCheck,
    e2e: () => testSocketE2E({ userMessage, resultPath }),
  };

  const sectionOrder = ['env', 'redis', 'postgres', 'tsc', 'e2e'];
  const runList = e2eOnly ? ['e2e'] : sectionOrder;

  for (const s of runList) {
    if (!shouldRun(s)) { skip(s, 'filtered'); continue; }
    try {
      await sections[s]();
    } catch (err) {
      record(s, 'UNHANDLED_ERROR', false, err && err.message ? err.message : String(err));
    }
  }

  // Summary
  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  TEST SUMMARY${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`);

  const passed = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  if (failed.length === 0) {
    console.log(`\n  ${GREEN}${BOLD}ALL ${passed.length} TESTS PASSED${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${GREEN}${BOLD}PASSED: ${passed.length}${RESET}  ${RED}${BOLD}FAILED: ${failed.length}${RESET}\n`);
    console.log(`${RED}${BOLD}  FAILURES:${RESET}`);
    for (const r of failed) {
      console.log(`    ${RED}✘ [${r.section}] ${r.name}${RESET}`);
      if (r.detail) console.log(`      ${DIM}${String(r.detail).split('\n').slice(0, 3).join('\n      ')}${RESET}`);
    }

    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error running test suite:', err);
  process.exit(2);
});
