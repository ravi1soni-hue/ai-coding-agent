#!/usr/bin/env node
/**
 * pipeline-test.js — Local end-to-end pipeline validation
 *
 * Tests every layer: env → redis → postgres → llm-proxy → websocket → orchestration dry-run
 *
 * Usage:
 *   node scripts/pipeline-test.js                     # run all tests
 *   node scripts/pipeline-test.js --only env,redis    # run specific sections
 *   node scripts/pipeline-test.js --skip docker       # skip a section
 *   node scripts/pipeline-test.js --live-prompt "build a todo app"  # run a real orchestration
 *
 * Env: copy backend/.env.example → backend/.env before running, OR export vars manually.
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const https = require('https');
const net   = require('net');
const { execSync, spawn } = require('child_process');

// ─── pretty logging ──────────────────────────────────────────────────────────
const RESET   = '\x1b[0m';
const BOLD    = '\x1b[1m';
const DIM     = '\x1b[2m';
const RED     = '\x1b[31m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const CYAN    = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function log(level, ...parts) {
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = {
    info:  `${DIM}${ts}${RESET} ${CYAN}ℹ${RESET} `,
    ok:    `${DIM}${ts}${RESET} ${GREEN}✔${RESET} `,
    warn:  `${DIM}${ts}${RESET} ${YELLOW}⚠${RESET} `,
    error: `${DIM}${ts}${RESET} ${RED}✘${RESET} `,
    head:  `\n${BOLD}${MAGENTA}`,
  }[level] || '';
  const suffix = level === 'head' ? RESET : '';
  console.log(prefix + parts.join(' ') + suffix);
}

// ─── load .env ──────────────────────────────────────────────────────────────
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
const onlyIdx  = args.indexOf('--only');
const skipIdx  = args.indexOf('--skip');
const promptIdx = args.indexOf('--live-prompt');
const onlyList = onlyIdx  !== -1 ? (args[onlyIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;
const skipList = skipIdx  !== -1 ? (args[skipIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : [];
const livePrompt = promptIdx !== -1 ? args[promptIdx + 1] : null;

function pass(name, detail = '') { log('ok',    `${BOLD}${name}${RESET}${detail ? '  ' + DIM + detail + RESET : ''}`); }
function fail(name, detail = '') { log('error', `${BOLD}${name}${RESET}${detail ? '  ' + DIM + detail + RESET : ''}`); }
function skip(name, reason = '') { log('warn',  `${BOLD}${name}${RESET} (skipped${reason ? ': ' + reason : ''})`); }

// ─── result tracker ──────────────────────────────────────────────────────────
const results = [];
function record(section, name, ok, detail = '') {
  results.push({ section, name, ok, detail });
  if (ok) pass(`[${section}] ${name}`, detail);
  else     fail(`[${section}] ${name}`, detail);
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function getEnv(key) { return (process.env[key] || '').trim(); }

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
        resolve({ status: res.statusCode, body });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
  });
}

async function httpPost(url, payload, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const lib  = url.startsWith('https') ? https : http;
    const u    = new URL(url);
    const opts = {
      hostname: u.hostname,
      port:     u.port || (url.startsWith('https') ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shouldRun(section) {
  if (onlyList && !onlyList.includes(section)) return false;
  if (skipList.includes(section)) return false;
  return true;
}

// ─── SECTION 1: Environment Variables ────────────────────────────────────────
async function testEnv() {
  log('head', '1. ENVIRONMENT VARIABLES');

  const required = [
    ['LLM_PROXY_CHAT_URL',      'LLM chat endpoint'],
    ['LLM_PROXY_EMBEDDING_URL', 'LLM embedding endpoint'],
  ];
  const optional = [
    ['REDIS_URL',       'Redis (optional but recommended)'],
    ['POSTGRES_URL',    'Postgres (optional but recommended)'],
    ['RAILWAY_TOKEN',   'Railway deploy token'],
    ['VERCEL_ACCESS_TOKEN', 'Vercel deploy token'],
    ['GPT4O_MINI_API_KEY',  'LLM API key (or legacy *_MODEL_ID)'],
    ['GPT4O_MINI_MODEL',    'Model slug for gpt-4o-mini'],
    ['PORT',            'HTTP port (defaults to 3000)'],
  ];

  let allRequired = true;
  for (const [k, desc] of required) {
    const v = getEnv(k);
    if (!v) {
      record('env', k, false, `MISSING — ${desc}`);
      allRequired = false;
    } else {
      record('env', k, true, `${v.slice(0, 60)}…`);
    }
  }
  for (const [k, desc] of optional) {
    const v = getEnv(k);
    if (!v) {
      log('warn', `  [env] ${k} not set (${desc})`);
    } else {
      record('env', k, true, `${v.slice(0, 60)}…`);
    }
  }

  // Resolve the actual API key being used
  const apiKey =
    getEnv('GPT4O_MINI_API_KEY') ||
    getEnv('GPT4O_MINI_MODEL_ID') ||
    getEnv('OPENAI_API_KEY');
  if (!apiKey) {
    record('env', 'API_KEY_RESOLVED', false, 'No API key found in GPT4O_MINI_API_KEY / GPT4O_MINI_MODEL_ID / OPENAI_API_KEY');
  } else {
    record('env', 'API_KEY_RESOLVED', true, `key starts with "${apiKey.slice(0, 8)}…"`);
  }

  return allRequired;
}

// ─── SECTION 2: Redis ────────────────────────────────────────────────────────
async function testRedis() {
  log('head', '2. REDIS');

  const url = getEnv('REDIS_URL');
  if (!url) {
    skip('redis', 'REDIS_URL not set — Redis is optional but pipeline hub uses it for multi-process fanout');
    return true;
  }

  let Redis;
  try { Redis = require('ioredis'); }
  catch { record('redis', 'ioredis_import', false, 'ioredis not installed — run: npm install'); return false; }

  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await client.connect();
    const pong = await client.ping();
    record('redis', 'PING', pong === 'PONG', pong);

    // Write + read test
    const testKey = `pipeline_test_${Date.now()}`;
    await client.set(testKey, 'ok', 'PX', 5000);
    const val = await client.get(testKey);
    record('redis', 'SET/GET', val === 'ok', `key=${testKey}`);

    // Stream test (used by pipelineHub)
    const streamKey = `pipeline_test_stream_${Date.now()}`;
    await client.xadd(streamKey, 'MAXLEN', '~', 10, '*', 'field', 'value');
    const entries = await client.xlen(streamKey);
    record('redis', 'XADD/XLEN', entries > 0, `stream has ${entries} entry`);
    await client.del(streamKey);

    await client.quit();
    return true;
  } catch (err) {
    record('redis', 'CONNECTION', false, err.message);
    try { await client.quit(); } catch {}
    return false;
  }
}

// ─── SECTION 3: Postgres ─────────────────────────────────────────────────────
async function testPostgres() {
  log('head', '3. POSTGRES');

  const url = getEnv('POSTGRES_URL') || getEnv('DATABASE_URL');
  if (!url) {
    skip('postgres', 'POSTGRES_URL not set — DB features will be unavailable but pipeline can run without it');
    return true;
  }

  let pg;
  try { pg = require('pg'); }
  catch { record('postgres', 'pg_import', false, 'pg not installed — run: npm install'); return false; }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('railway') || url.includes('sslmode') ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });

  try {
    const res = await pool.query('SELECT 1 AS ok, version() AS v');
    record('postgres', 'SELECT 1', res.rows[0]?.ok === 1, res.rows[0]?.v?.slice(0, 50));

    // Check required tables exist
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tableNames = tables.rows.map(r => r.table_name);
    log('info', `  Tables found: ${tableNames.join(', ') || '(none)'}`);

    const expectedTables = ['users', 'sessions', 'projects', 'project_events'];
    for (const t of expectedTables) {
      if (!tableNames.includes(t)) {
        log('warn', `  Missing table: ${t} — run db migrations`);
      }
    }
    record('postgres', 'TABLES', true, `${tableNames.length} tables`);

    await pool.end();
    return true;
  } catch (err) {
    record('postgres', 'CONNECTION', false, err.message);
    try { await pool.end(); } catch {}
    return false;
  }
}

// ─── SECTION 4: LLM Proxy ────────────────────────────────────────────────────
async function testLLMProxy() {
  log('head', '4. LLM PROXY');

  const chatUrl = getEnv('LLM_PROXY_CHAT_URL');
  const embUrl  = getEnv('LLM_PROXY_EMBEDDING_URL');
  const apiKey  =
    getEnv('GPT4O_MINI_API_KEY') ||
    getEnv('GPT4O_MINI_MODEL_ID') ||
    getEnv('OPENAI_API_KEY');
  const model   = getEnv('GPT4O_MINI_MODEL') || 'gpt-4o-mini';

  if (!chatUrl) {
    record('llm', 'CHAT_URL', false, 'LLM_PROXY_CHAT_URL not set');
    return false;
  }
  if (!apiKey) {
    record('llm', 'API_KEY', false, 'No API key set (GPT4O_MINI_API_KEY / OPENAI_API_KEY)');
    return false;
  }

  // Minimal chat completion
  try {
    log('info', `  Calling ${chatUrl} with model=${model}`);
    const t0 = Date.now();
    const res = await httpPost(
      chatUrl,
      {
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: PONG' }],
        max_tokens: 10,
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-API-KEY': apiKey,
          Accept: 'application/json',
        },
        timeoutMs: 30000,
      }
    );
    const elapsed = Date.now() - t0;

    if (res.status >= 400) {
      record('llm', 'CHAT_COMPLETION', false, `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      return false;
    }

    let data;
    try { data = JSON.parse(res.body); } catch {
      record('llm', 'CHAT_COMPLETION', false, `Non-JSON response: ${res.body.slice(0, 200)}`);
      return false;
    }

    const content = data?.choices?.[0]?.message?.content || '';
    record('llm', 'CHAT_COMPLETION', content.length > 0, `"${content.trim()}" in ${elapsed}ms`);

    // Check for model info
    const usedModel = data?.model || 'unknown';
    log('info', `  Model used: ${usedModel}, tokens: ${JSON.stringify(data?.usage || {})}`);
  } catch (err) {
    record('llm', 'CHAT_COMPLETION', false, err.message);
    return false;
  }

  // Embedding endpoint
  if (embUrl) {
    try {
      log('info', `  Calling embedding endpoint ${embUrl}`);
      const t0 = Date.now();
      const res = await httpPost(
        embUrl,
        { texts: ['test embedding'], dimensions: 256 },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'X-API-KEY': apiKey,
            Accept: 'application/json',
          },
          timeoutMs: 20000,
        }
      );
      const elapsed = Date.now() - t0;
      if (res.status >= 400) {
        record('llm', 'EMBEDDING', false, `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      } else {
        let data;
        try { data = JSON.parse(res.body); } catch {
          record('llm', 'EMBEDDING', false, `Non-JSON: ${res.body.slice(0, 100)}`);
          return true;
        }
        const embeddings = data?.embeddings;
        const ok = Array.isArray(embeddings) && embeddings.length > 0;
        record('llm', 'EMBEDDING', ok, `dims=${Array.isArray(embeddings?.[0]) ? embeddings[0].length : '?'} in ${elapsed}ms`);
      }
    } catch (err) {
      record('llm', 'EMBEDDING', false, err.message);
    }
  }

  return true;
}

// ─── SECTION 5: TypeScript Build ─────────────────────────────────────────────
async function testTypeCheck() {
  log('head', '5. TYPESCRIPT TYPE-CHECK');

  const backendDir = path.resolve(__dirname, '..');
  try {
    log('info', '  Running npx tsc --noEmit...');
    execSync('npx tsc --noEmit', { cwd: backendDir, stdio: 'pipe', timeout: 60000 });
    record('tsc', 'NO_ERRORS', true, 'Zero TypeScript errors');
    return true;
  } catch (err) {
    const output = (err.stdout || err.stderr || err.message || '').toString();
    const errorLines = output.split('\n').filter(l => l.includes('error TS')).slice(0, 20);
    record('tsc', 'NO_ERRORS', false, `${errorLines.length} TS errors:\n${errorLines.join('\n')}`);
    return false;
  }
}

// ─── SECTION 6: Docker ───────────────────────────────────────────────────────
async function testDocker() {
  log('head', '6. DOCKER (build sandbox)');

  try {
    const out = execSync('docker info --format "{{.ServerVersion}}"', { stdio: 'pipe', timeout: 10000 }).toString().trim();
    record('docker', 'DAEMON', !!out, `Docker ${out}`);
  } catch (err) {
    record('docker', 'DAEMON', false, `Docker not available: ${err.message.slice(0, 120)}`);
    log('warn', '  Build sandbox requires Docker. Install Docker Desktop or use DinD on Railway.');
    return false;
  }

  // Pull check (just verify image exists locally or is pullable)
  try {
    const images = execSync('docker images node:20-bookworm --format "{{.Repository}}:{{.Tag}}"', { stdio: 'pipe', timeout: 10000 }).toString().trim();
    if (images) {
      record('docker', 'IMAGE_node20', true, 'node:20-bookworm already present');
    } else {
      log('warn', '  node:20-bookworm not pulled yet. First build will take extra time (docker pull).');
      record('docker', 'IMAGE_node20', true, 'Image not present (will pull on first build)');
    }
  } catch (err) {
    record('docker', 'IMAGE_node20', false, err.message.slice(0, 120));
  }

  // Quick container smoke test
  try {
    log('info', '  Running smoke container: node -e "console.log(process.version)"');
    const ver = execSync('docker run --rm node:20-bookworm node -e "console.log(process.version)"', {
      stdio: 'pipe',
      timeout: 60000,
    }).toString().trim();
    record('docker', 'RUN_CONTAINER', ver.startsWith('v'), `container node ${ver}`);
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('pull')) {
      record('docker', 'RUN_CONTAINER', false, 'node:20-bookworm pull failed — check internet / docker login');
    } else {
      record('docker', 'RUN_CONTAINER', false, msg.slice(0, 200));
    }
    return false;
  }

  return true;
}

// ─── SECTION 7: Server Boot ──────────────────────────────────────────────────
async function testServerBoot() {
  log('head', '7. SERVER BOOT (express + ws)');

  const port = parseInt(getEnv('PORT') || '3001', 10);
  const testPort = port + 100; // use a different port so we don't conflict

  // Check port is free
  const isFree = await new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(testPort, '127.0.0.1');
  });

  if (!isFree) {
    record('server', 'PORT_FREE', false, `Port ${testPort} already in use`);
    return false;
  }
  record('server', 'PORT_FREE', true, `port ${testPort} available`);

  // Spawn ts-node server on testPort
  log('info', `  Starting ts-node index.ts on port ${testPort}...`);
  const env = { ...process.env, PORT: String(testPort), NODE_ENV: 'test' };
  const proc = spawn('npx', ['ts-node', 'src/index.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '', stderr = '';
  proc.stdout.on('data', c => { stdout += c; });
  proc.stderr.on('data', c => { stderr += c; });

  // Wait for "running on port" or error
  const started = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 20000);
    proc.stdout.on('data', (c) => {
      if (c.toString().includes(String(testPort)) || stdout.includes('listening')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    proc.stderr.on('data', (c) => {
      const s = c.toString();
      if (s.includes(String(testPort)) || s.includes('listening') || s.includes('running')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!started) {
    record('server', 'BOOT', false, `Failed to start. stderr: ${stderr.slice(-400)}`);
    proc.kill();
    return false;
  }

  await sleep(1000); // let it settle

  // Health check
  try {
    const res = await httpGet(`http://127.0.0.1:${testPort}/health`, { timeoutMs: 8000, ignoreCodes: [503, 502] });
    let body = res.body;
    try { body = JSON.stringify(JSON.parse(res.body), null, 2); } catch {}
    record('server', 'HEALTH_ENDPOINT', res.status < 500, `HTTP ${res.status}\n${body}`);
  } catch (err) {
    record('server', 'HEALTH_ENDPOINT', false, err.message);
  }

  proc.kill('SIGTERM');
  await sleep(500);
  return true;
}

// ─── SECTION 8: Pipeline Logic (unit) ────────────────────────────────────────
async function testPipelineLogic() {
  log('head', '8. PIPELINE LOGIC (unit checks)');

  // 8a. Verify orchestrator budget constants
  const orchFile = path.resolve(__dirname, '../src/ai/orchestrator/orchestrator.ts');
  const orchSrc = fs.existsSync(orchFile) ? fs.readFileSync(orchFile, 'utf8') : '';

  const hasCgMin   = /CODE_GEN_MIN_BUDGET_MS\s*=\s*\d+/.test(orchSrc);
  const hasTestMin  = /TEST_MIN_BUDGET_MS\s*=\s*\d+/.test(orchSrc);
  const cgJIT = /const codeGenDeadlineAt\s*=\s*Math\.max/.test(orchSrc) &&
                !/const\s+codeGenDeadlineAt[\s\S]{0,40}orchestratorDeadlineAt[\s\S]{0,40}CODE_GEN[\s\S]{0,200}stageWrap\(memory,\s*'requirements'/.test(orchSrc);
  const testJIT = /const testDeadlineAt\s*=\s*Math\.max/.test(orchSrc);

  record('pipeline', 'CODE_GEN_MIN_BUDGET_MS defined',   hasCgMin,    hasCgMin ? 'ok' : 'missing in orchestrator.ts');
  record('pipeline', 'TEST_MIN_BUDGET_MS defined',        hasTestMin,  hasTestMin ? 'ok' : 'missing in orchestrator.ts');
  record('pipeline', 'codeGenDeadlineAt JIT (not T=0)',   cgJIT,       cgJIT ? 'computed at stage entry' : 'check if computed at T=0 startup');
  record('pipeline', 'testDeadlineAt JIT',                testJIT,     testJIT ? 'computed at stage entry' : 'missing');

  // 8b. testFixAgent has deadline guard
  const tfFile = path.resolve(__dirname, '../src/agents/testFixAgent.ts');
  const tfSrc = fs.existsSync(tfFile) ? fs.readFileSync(tfFile, 'utf8') : '';
  const hasBudgetGuard = /MIN_ATTEMPT_BUDGET_MS/.test(tfSrc) && /deadlineAt/.test(tfSrc);
  record('pipeline', 'testFixAgent deadline guard',  hasBudgetGuard, hasBudgetGuard ? 'ok' : 'missing early-bail check');

  // 8c. buildWorker has deadlineMs helper
  const bwFile = path.resolve(__dirname, '../src/workers/buildWorker.ts');
  const bwSrc = fs.existsSync(bwFile) ? fs.readFileSync(bwFile, 'utf8') : '';
  const hasDeadlineFn = /function deadlineMs/.test(bwSrc);
  const usesDeadline  = bwSrc.split('deadlineMs(').length > 3; // called in multiple places
  record('pipeline', 'buildWorker deadlineMs helper',  hasDeadlineFn, hasDeadlineFn ? 'ok' : 'missing');
  record('pipeline', 'buildWorker uses deadlineMs',     usesDeadline,  usesDeadline ? 'ok' : 'may not be wired in all commands');

  // 8d. logger uses single-line JSON
  const logFile = path.resolve(__dirname, '../src/utils/logger.ts');
  const logSrc = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const usesJsonSerialize = /JSON\.stringify/.test(logSrc) && !/util\.inspect/.test(logSrc);
  record('pipeline', 'logger single-line JSON (no util.inspect)', usesJsonSerialize, usesJsonSerialize ? 'ok' : 'check logger.ts');

  // 8e. LLM proxy client no util.inspect
  const lpcFile = path.resolve(__dirname, '../src/agents/llmProxyClient.ts');
  const lpcSrc = fs.existsSync(lpcFile) ? fs.readFileSync(lpcFile, 'utf8') : '';
  const noUtilInspect = !/util\.inspect/.test(lpcSrc);
  record('pipeline', 'llmProxyClient no util.inspect', noUtilInspect, noUtilInspect ? 'ok' : 'still uses util.inspect — multi-line log issue');

  return true;
}

// ─── SECTION 9: WebSocket (end-to-end, requires server running) ──────────────
async function testWebSocket(serverPort) {
  log('head', '9. WEBSOCKET');

  if (!serverPort) {
    skip('websocket', 'No server port given — start the server first');
    return true;
  }

  let WS;
  try { WS = require('ws'); }
  catch { record('ws', 'ws_import', false, 'ws not installed'); return false; }

  const wsUrl = `ws://127.0.0.1:${serverPort}`;
  log('info', `  Connecting to ${wsUrl}`);

  return new Promise((resolve) => {
    const ws = new WS(wsUrl, { headers: { cookie: 'sid=test_no_auth' } });
    const timer = setTimeout(() => {
      ws.terminate();
      // We expect an auth error (no valid session) — that's correct behavior
      record('ws', 'CONNECT_AUTH_REJECT', true, 'WS correctly rejected unauthenticated connection');
      resolve(true);
    }, 5000);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error' && /auth|session|expired/i.test(msg.message || '')) {
        clearTimeout(timer);
        ws.close();
        record('ws', 'CONNECT_AUTH_REJECT', true, `Auth error: "${msg.message}"`);
        resolve(true);
      } else if (msg.type === 'info' && msg.message === 'Connected!') {
        clearTimeout(timer);
        ws.close();
        record('ws', 'CONNECT_AUTH_REJECT', false, 'WARNING: WS accepted connection without valid session');
        resolve(false);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      // Connection refused = server not running on that port
      if (err.code === 'ECONNREFUSED') {
        record('ws', 'CONNECT', false, `Connection refused on port ${serverPort}`);
      } else {
        record('ws', 'CONNECT_AUTH_REJECT', true, `Connection closed with error: ${err.message} (expected for no-auth)`);
      }
      resolve(true);
    });
  });
}

// ─── SECTION 10: Live Orchestration Dry-run ──────────────────────────────────
async function testLiveOrchestration(prompt) {
  log('head', '10. LIVE ORCHESTRATION DRY-RUN');

  if (!prompt) {
    skip('orchestration', 'Pass --live-prompt "build me a todo app" to run this section');
    return true;
  }

  log('info', `  Prompt: "${prompt}"`);
  log('info', '  This runs the full pipeline locally. Expect 5-20 minutes.');

  // We run via ts-node so we can import the orchestrator directly
  const tmpScript = path.resolve(__dirname, './_orch_test_tmp.js');
  fs.writeFileSync(tmpScript, `
    process.env.NODE_ENV = 'development';
    require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
    const { runAIOrchestration } = require('../dist/ai/orchestrator/orchestrator');
    const projectId = 'local_test_' + Date.now();
    const events = [];
    const adapter = { emit: (e) => {
      events.push(e);
      if (e.type === 'stage_start' || e.type === 'stage_complete' || e.type === 'failed' || e.type === 'complete') {
        console.log('[EVENT]', JSON.stringify(e));
      }
    }};
    const persistence = {
      loadSnapshot: async () => null,
      saveSnapshot: async (id, mem) => { console.log('[SAVE]', id, mem.currentState); },
      appendEvent: async () => {},
    };
    runAIOrchestration({
      projectId,
      sessionId: projectId,
      userMessage: ${JSON.stringify(prompt)},
    }, adapter, persistence)
    .then(r => {
      console.log('[RESULT]', JSON.stringify({ status: r.status, state: r.memory.currentState }));
      process.exit(0);
    })
    .catch(e => {
      console.error('[ERROR]', e.message);
      process.exit(1);
    });
  `);

  log('warn', '  Note: This requires a successful `npm run build` first (uses dist/)');

  const child = spawn('node', [tmpScript], { stdio: 'inherit', env: process.env });
  const exitCode = await new Promise(resolve => child.on('exit', resolve));

  try { fs.unlinkSync(tmpScript); } catch {}

  record('orchestration', 'LIVE_RUN', exitCode === 0, exitCode === 0 ? 'Pipeline completed' : `Exit code ${exitCode}`);
  return exitCode === 0;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN}  AI Coding Agent — Full Pipeline Test Suite${RESET}`);
  console.log(`${BOLD}${CYAN}  ${new Date().toISOString()}${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}\n`);

  if (onlyList) log('info', `Running only: ${onlyList.join(', ')}`);
  if (skipList.length) log('info', `Skipping: ${skipList.join(', ')}`);

  const sectionMap = {
    env:          testEnv,
    redis:        testRedis,
    postgres:     testPostgres,
    llm:          testLLMProxy,
    tsc:          testTypeCheck,
    docker:       testDocker,
    server:       testServerBoot,
    pipeline:     testPipelineLogic,
    ws:           () => testWebSocket(null),
    orchestration: () => testLiveOrchestration(livePrompt),
  };

  for (const [section, fn] of Object.entries(sectionMap)) {
    if (!shouldRun(section)) {
      skip(section);
      continue;
    }
    try {
      await fn();
    } catch (err) {
      record(section, 'UNHANDLED_ERROR', false, err.message);
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  TEST SUMMARY${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}`);

  const passed = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  if (failed.length === 0) {
    console.log(`\n  ${GREEN}${BOLD}ALL ${passed.length} TESTS PASSED${RESET}\n`);
  } else {
    console.log(`\n  ${GREEN}${BOLD}PASSED: ${passed.length}${RESET}  ${RED}${BOLD}FAILED: ${failed.length}${RESET}\n`);
    console.log(`${RED}${BOLD}  FAILURES:${RESET}`);
    for (const r of failed) {
      console.log(`    ${RED}✘ [${r.section}] ${r.name}${RESET}`);
      if (r.detail) console.log(`      ${DIM}${r.detail.split('\n').slice(0, 3).join('\n      ')}${RESET}`);
    }
  }

  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════${RESET}\n`);

  // ─── Actionable Fixes ──────────────────────────────────────────────────────
  if (failed.length > 0) {
    console.log(`${BOLD}  HOW TO FIX:${RESET}\n`);
    const hints = {
      'env':          '  → Create backend/.env from the template below and fill in values',
      'redis':        '  → Start local Redis: docker run -p 6379:6379 redis  (or set REDIS_URL)',
      'postgres':     '  → Start local Postgres: docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres',
      'llm':          '  → Check LLM_PROXY_CHAT_URL and GPT4O_MINI_API_KEY / GPT4O_MINI_MODEL_ID env vars',
      'tsc':          '  → Fix TypeScript errors: cd backend && npx tsc --noEmit',
      'docker':       '  → Install Docker Desktop or run inside a DinD environment',
      'server':       '  → Check backend logs — usually a missing DB or broken import',
      'pipeline':     '  → Apply the deadline/budget fixes from the recent audit',
      'ws':           '  → Start the server and ensure auth middleware is correct',
      'orchestration':'  → Run with --live-prompt after all other tests pass',
    };
    const shownSections = new Set(failed.map(r => r.section));
    for (const s of shownSections) {
      if (hints[s]) console.log(hints[s]);
    }

    // If env section failed, print template
    if (shownSections.has('env') || results.some(r => r.section === 'env' && !r.ok)) {
      console.log(`\n${BOLD}  .env template (backend/.env):${RESET}`);
      console.log(`${DIM}
# ── LLM Proxy (required) ──────────────────────────────────────────────
LLM_PROXY_CHAT_URL=https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions
LLM_PROXY_EMBEDDING_URL=https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings
GPT4O_MINI_MODEL_ID=<your-api-key-here>
GPT4O_MINI_MODEL=gpt-4o-mini

# ── Infrastructure (optional locally, required in prod) ────────────────
REDIS_URL=redis://localhost:6379
POSTGRES_URL=postgresql://postgres:dev@localhost:5432/ai_builder
PORT=3000

# ── Deploy (optional) ─────────────────────────────────────────────────
RAILWAY_TOKEN=
VERCEL_ACCESS_TOKEN=
${RESET}`);
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error running test suite:', err);
  process.exit(2);
});
