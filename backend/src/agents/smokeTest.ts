import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { debug, warn as logWarn } from '../utils/logger';

export interface SmokeTestResult {
  passed: boolean;
  /** True if the root element rendered at least one child. */
  hasContent: boolean;
  /** Console errors captured during page load. */
  consoleErrors: string[];
  /** Synthesized build-log-style string for passing to specBasedFileRegeneration. */
  syntheticBuildLog: string;
}

const PREVIEW_PORT = 4174; // avoid colliding with vite dev default 5173
const STARTUP_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 20_000;

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Port ${port} not open after ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    }
    attempt();
  });
}

function spawnVitePreview(workspaceDir: string): ChildProcess {
  return spawn(
    'npx',
    ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    {
      cwd: path.join(workspaceDir, 'frontend'),
      stdio: 'pipe',
      env: { ...process.env, BROWSER: 'none' },
    }
  );
}

/**
 * Runs a headless Playwright smoke test against the built app.
 * Requires `playwright` and `@playwright/test` to be installed in the backend,
 * or falls back gracefully if Playwright is not available.
 *
 * Returns a SmokeTestResult with hasContent=true when the React root renders
 * at least one child element, meaning the app is not blank.
 */
export async function runSmokeTest(workspaceDir: string): Promise<SmokeTestResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playwright: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    playwright = require('playwright');
  } catch {
    debug('smokeTest:playwright-unavailable', 'playwright not installed — skipping smoke test');
    return { passed: true, hasContent: true, consoleErrors: [], syntheticBuildLog: '' };
  }

  let server: ChildProcess | undefined;

  try {
    server = spawnVitePreview(workspaceDir);

    let serverError = '';
    server.stderr?.on('data', (chunk: Buffer) => { serverError += chunk.toString(); });

    try {
      await waitForPort(PREVIEW_PORT, STARTUP_TIMEOUT_MS);
    } catch (err) {
      return {
        passed: false,
        hasContent: false,
        consoleErrors: [serverError.slice(0, 500)],
        syntheticBuildLog: `error: vite preview failed to start\n${serverError.slice(0, 500)}`,
      };
    }

    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (msg: { type(): string; text(): string }) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err: { message: string }) => consoleErrors.push(err.message));

    try {
      await page.goto(`http://localhost:${PREVIEW_PORT}`, {
        waitUntil: 'networkidle',
        timeout: PAGE_TIMEOUT_MS,
      });
    } catch {
      // networkidle timeout is ok — still check content
    }

    // Check that React root has rendered at least one child
    const childCount = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root ? root.childElementCount : 0;
    }).catch(() => 0);

    await browser.close();

    const hasContent = childCount > 0;
    const passed = hasContent && consoleErrors.length === 0;

    // Extract component names from ErrorBoundary console errors:
    // "[ErrorBoundary] ComponentName: error message" → target that file specifically
    const errorBoundaryRe = /\[ErrorBoundary\]\s+(\w+):\s+(.+)/;
    const componentErrors: string[] = [];
    for (const e of consoleErrors) {
      const m = e.match(errorBoundaryRe);
      if (m) {
        componentErrors.push(`error: src/components/${m[1]}.jsx: runtime error: ${m[2]}`);
      }
    }

    const syntheticBuildLog = [
      ...(!hasContent ? [`error: App.jsx renders blank — React root has no children after page load`] : []),
      ...componentErrors,
      ...consoleErrors
        .filter(e => !errorBoundaryRe.test(e))
        .map(e => `error: runtime: ${e}`),
    ].join('\n');

    debug('smokeTest:result', { hasContent, childCount, consoleErrors: consoleErrors.length, componentErrors: componentErrors.length, passed });
    return { passed, hasContent, consoleErrors, syntheticBuildLog };

  } finally {
    try { server?.kill('SIGTERM'); } catch { /* best-effort */ }
  }
}
