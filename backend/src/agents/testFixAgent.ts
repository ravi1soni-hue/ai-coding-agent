// Test & Fix Agent
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_PUBLIC_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

type GeneratedFile = {
  path: string;
  content: string;
};

async function ensureReactPublicIndexHtml(
  files: GeneratedFile[],
  workspaceDir: string
): Promise<void> {
  // Determine if this is a React project by checking for a react dependency in package.json
  const packageJsonFile = files.find(
    (f) => f.path === 'package.json' || f.path === '/package.json'
  );
  if (!packageJsonFile) return;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJsonFile.content);
  } catch {
    return;
  }

  const hasReact =
    typeof pkg.dependencies?.['react'] === 'string' ||
    typeof pkg.devDependencies?.['react'] === 'string';
  if (!hasReact) return;

  // Check whether public/index.html is already present in the files array
  const normalise = (p: string) => p.replace(/^\/*/, '');
  const hasPublicIndexHtml = files.some(
    (f) => normalise(f.path) === 'public/index.html'
  );

  if (!hasPublicIndexHtml) {
    console.log(
      '[testFixAgent] React project is missing public/index.html — injecting default file.'
    );
    const targetPath = path.join(workspaceDir, 'public', 'index.html');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, DEFAULT_PUBLIC_INDEX_HTML, 'utf8');
  }
}

export async function testFixAgent(input: {
  buildFn: () => Promise<{ success: boolean; logs: string }>;
  fixFn?: (logs: string) => Promise<void>;
  files?: GeneratedFile[];
  workspaceDir?: string;
}) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[testFixAgent] called with:', input);
  }

  // Pre-build validation: ensure React projects have public/index.html
  if (input.files && input.workspaceDir) {
    try {
      await ensureReactPublicIndexHtml(input.files, input.workspaceDir);
    } catch (err) {
      console.warn('[testFixAgent] Pre-build validation warning:', err);
    }
  }

  let retries = 0;
  let result: { success: boolean; logs: string } | undefined;
  try {
    do {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[testFixAgent] Attempt ${retries + 1}`);
      }
      result = await input.buildFn();
      if (process.env.NODE_ENV !== 'production') {
        console.log('[testFixAgent] buildFn result:', result);
      }
      if (result.success) {
        if (process.env.NODE_ENV !== 'production') {
          console.log('[testFixAgent] Success:', { ...result, fixed: retries > 0 });
        }
        return { ...result, fixed: retries > 0 };
      }
      // Attempt LLM-based fix before retrying
      if (input.fixFn && retries < 2) {
        console.log(`[testFixAgent] Build failed, attempting fix (retry ${retries + 1})...`);
        try {
          await input.fixFn(result.logs);
        } catch (fixErr) {
          console.error('[testFixAgent] fixFn error:', fixErr);
        }
      }
      retries++;
    } while (retries < 3);
    const lastLogs = result?.logs || 'No build output captured.';
    throw new Error(`Build failed after 3 attempts. Last error:\n${lastLogs.slice(-2000)}`);
  } catch (err) {
    console.error('[testFixAgent] error:', err);
    throw err;
  }
}
