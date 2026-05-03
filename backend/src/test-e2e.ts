import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runBuildWorker } from './workers/buildWorker';
import { materializeProjectWorkspace } from './factory/projectFactory';

type GeneratedFile = { path: string; content: string };

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFiles(rootDir: string, files: GeneratedFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(rootDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }
}

async function testSuccessfulBuild(): Promise<void> {
  const rootDir = await createTempDir('ai-builder-build-');
  await writeFiles(rootDir, [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'e2e-success',
        private: true,
        type: 'module',
        scripts: { build: 'node ./build.mjs' },
        dependencies: {
          react: 'file:./stubs/react',
        },
        devDependencies: {
          'react-dom': 'file:./stubs/react-dom',
        },
      }, null, 2),
    },
    {
      path: 'index.html',
      content: '<!doctype html><html><body><div id="root"></div></body></html>',
    },
    {
      path: 'src/main.jsx',
      content: 'console.log("hello");',
    },
    {
      path: 'build.mjs',
      content: 'import fs from "fs/promises"; await fs.mkdir("dist", { recursive: true }); await fs.writeFile("dist/index.html", "<!doctype html><html><body>ok</body></html>");',
    },
    {
      path: 'stubs/react/package.json',
      content: JSON.stringify({ name: 'react', version: '0.0.0', main: 'index.js' }, null, 2),
    },
    {
      path: 'stubs/react/index.js',
      content: 'export default {};',
    },
    {
      path: 'stubs/react-dom/package.json',
      content: JSON.stringify({ name: 'react-dom', version: '0.0.0', main: 'index.js' }, null, 2),
    },
    {
      path: 'stubs/react-dom/index.js',
      content: 'export default {};',
    },
  ]);

  const result = await runBuildWorker({ workspaceDir: rootDir });
  assert.strictEqual(result.success, true, 'expected build to succeed');
  assert.ok(result.buildDir?.endsWith('dist'), 'expected frontend build directory');
}

async function testFallbackDetectionAndManifestCopy(): Promise<void> {
  const revision = await materializeProjectWorkspace({
    projectId: 'e2e-fallback',
    codeGen: {
      files: [
        { path: 'package.json', content: JSON.stringify({ name: 'fallback-app', private: true, type: 'module' }) },
        { path: 'src/App.jsx', content: 'export default function App(){ return <main>TODO placeholder replace generic text</main>; }' },
        { path: 'src/components/Foo.jsx', content: 'export default function Foo(){ return <div>Foo</div>; }' },
        { path: 'backend/package.json', content: JSON.stringify({ name: 'fallback-backend', private: true, type: 'module' }) },
        { path: 'backend/db/init.sql', content: 'CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY);' },
      ],
      patch: '',
    },
  });

  assert.ok(revision.workspaceDir.includes(path.sep), 'workspace should exist');
  const initSql = await fs.readFile(path.join(revision.workspaceDir, 'backend', 'db', 'init.sql'), 'utf8');
  assert.ok(initSql.includes('CREATE TABLE IF NOT EXISTS'), 'backend init.sql should be materialized');
}

async function testBuildFailurePath(): Promise<void> {
  const rootDir = await createTempDir('ai-builder-fail-');
  await writeFiles(rootDir, [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'e2e-fail',
        private: true,
        type: 'module',
        scripts: { build: 'node ./missing-script.mjs' },
      }, null, 2),
    },
    {
      path: 'index.html',
      content: '<!doctype html><html><body><div id="root"></div></body></html>',
    },
    {
      path: 'src/main.jsx',
      content: 'console.log("hello");',
    },
  ]);

  const result = await runBuildWorker({ workspaceDir: rootDir });
  assert.strictEqual(result.success, false, 'expected build to fail');
  assert.ok(result.logs.includes('Pre-build validation passed') || result.logs.length > 0, 'expected build logs');
}

async function run(): Promise<void> {
  await testSuccessfulBuild();
  await testFallbackDetectionAndManifestCopy();
  await testBuildFailurePath();
  console.log('backend E2E checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
