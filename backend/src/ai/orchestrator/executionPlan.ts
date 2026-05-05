import type { BlueprintMemory, DeploymentMode, ExecutionPlan, ProjectMemory, RetryPolicy } from '../contracts/orchestration';

function normalizePathValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizePathValue).filter(Boolean)));
}

function defaultRetryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: overrides.maxAttempts ?? 2,
    maxFixAttempts: overrides.maxFixAttempts ?? 2,
    relaxOnRetry: overrides.relaxOnRetry ?? true,
    allowFallback: overrides.allowFallback ?? true,
    allowUserQuestion: overrides.allowUserQuestion ?? false,
  };
}

function getFilesFromBlueprint(blueprint: BlueprintMemory | undefined): Array<{ path: string; dependsOn?: string[]; kind?: string; purpose?: string }> {
  const raw = (blueprint?.blueprint as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((file) => (file && typeof file === 'object' ? (file as Record<string, unknown>) : null))
    .filter((file): file is Record<string, unknown> => Boolean(file && typeof file.path === 'string'))
    .map((file) => ({
      path: normalizePathValue(String(file.path)),
      dependsOn: Array.isArray(file.dependsOn) ? file.dependsOn.map((item) => String(item)) : [],
      kind: typeof file.kind === 'string' ? file.kind : undefined,
      purpose: typeof file.purpose === 'string' ? file.purpose : undefined,
    }));
}

export function deriveDeploymentMode(memory: ProjectMemory): DeploymentMode {
  const requirements = memory.requirements;
  return requirements?.backend_required ? 'full-stack' : 'frontend-only';
}

export function buildExecutionPlan(memory: ProjectMemory): ExecutionPlan {
  const files = getFilesFromBlueprint(memory.blueprint);
  const fileOrder = unique([
    ...files.filter((file) => file.kind === 'config' || file.kind === 'entry' || file.path === 'package.json').map((file) => file.path),
    ...files.map((file) => file.path),
  ]);

  const dependencyGraph = Object.fromEntries(
    files.map((file) => [file.path, unique(file.dependsOn || [])])
  );

  const frontendFiles = fileOrder.filter((file) => !file.startsWith('backend/'));
  const backendFiles = fileOrder.filter((file) => file.startsWith('backend/'));

  const phases = [
    {
      name: 'frontend_scaffold',
      files: frontendFiles.filter((file) => ['package.json', 'index.html', 'vite.config.js', 'src/main.jsx', 'src/App.jsx', 'src/index.css'].includes(file) || file.startsWith('src/components/')),
      dependencies: ['requirements', 'clarification', 'system_design', 'ui_spec'],
      retryPolicy: defaultRetryPolicy({ maxAttempts: 2, maxFixAttempts: 2, allowFallback: true }),
    },
    {
      name: 'backend_scaffold',
      files: backendFiles,
      dependencies: ['blueprint'],
      retryPolicy: defaultRetryPolicy({ maxAttempts: 2, maxFixAttempts: 2, allowFallback: true }),
    },
    {
      name: 'verification',
      files: [],
      dependencies: ['code_generation'],
      retryPolicy: defaultRetryPolicy({ maxAttempts: 3, maxFixAttempts: 3, allowFallback: false }),
    },
  ];

  const apiUsageClarity = backendFiles
    .filter((file) => file.startsWith('backend/src/routes/'))
    .map((file) => ({
      file,
      endpoint: `/api/${file.split('/').pop()?.replace(/\.ts$/, '') || 'resource'}`,
      method: 'GET',
      projectIdRequired: true,
      dataScope: 'project-scoped' as const,
    }));

  return {
    projectId: memory.projectId,
    sessionId: memory.sessionId,
    deploymentMode: deriveDeploymentMode(memory),
    fileOrder,
    dependencyGraph,
    phases,
    apiUsageClarity,
    repairOrder: unique([
      ...fileOrder.filter((file) => file.startsWith('src/components/')).reverse(),
      'src/App.jsx',
      'src/index.css',
      'src/main.jsx',
      'backend/src/db/database.ts',
      ...backendFiles.filter((file) => file.startsWith('backend/src/routes/')).reverse(),
    ]),
  };
}
