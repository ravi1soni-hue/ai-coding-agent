import type { ProjectSpec } from './projectSpec';
import { atOrAfterStage, normalizePipelineStage, type PipelineStage } from '../orchestration/pipelineStateMachine';

export type ConsistencyIssue = {
  stage: string;
  message: string;
};

export type ConsistencyReport = {
  ok: boolean;
  issues: ConsistencyIssue[];
};

function addIssue(issues: ConsistencyIssue[], stage: string, message: string): void {
  issues.push({ stage, message });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function getNames(items: Array<{ name?: string }>): string[] {
  return items.map((item) => String(item?.name || '').trim()).filter(Boolean);
}

function getComponentNamesFromUiSpec(uiSpec: unknown): string[] {
  const record = asRecord(uiSpec);
  if (!record) return [];
  return getNames(asArray<{ name?: string }>(record.components));
}

function getComponentPathsFromUiSpec(uiSpec: unknown): string[] {
  const record = asRecord(uiSpec);
  if (!record) return [];
  return asArray<{ path?: string }>(record.components)
    .map((item) => String(item?.path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter(Boolean);
}

function normalizePageName(value: unknown): string {
  const raw = normalizeTextValue(value);
  if (!raw) return '';
  return raw
    .replace(/\bpage\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTextValue(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate =
      record.name ??
      record.title ??
      record.label ??
      record.page ??
      record.path ??
      record.slug ??
      record.id ??
      record.value;
    if (typeof candidate === 'string') return candidate.toLowerCase().replace(/\s+/g, ' ').trim();
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate).toLowerCase().trim();
  }
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getRequirementPages(requirements: Record<string, unknown> | null): string[] {
  if (!requirements) return [];
  return asArray<unknown>(requirements.pages)
    .flatMap((page) => {
      const normalized = normalizePageName(page);
      if (normalized && normalized !== '[object object]') return [normalized];
      if (page && typeof page === 'object') {
        const record = page as Record<string, unknown>;
        return [record.name, record.title, record.label, record.page, record.path, record.slug, record.id, record.value]
          .filter((item): item is string | number | boolean => item !== undefined)
          .map((item) => normalizePageName(item))
          .filter(Boolean);
      }
      return [normalized].filter(Boolean);
    })
    .filter(Boolean);
}

function getBlueprintComponentNames(blueprint: unknown): string[] {
  const record = asRecord(blueprint);
  if (!record) return [];
  const navigation = asRecord(record.navigation);
  return getNames(asArray<{ component?: string }>(navigation?.routes).map((route) => ({ name: route.component })));
}

function getBlueprintPaths(blueprint: unknown): string[] {
  const record = asRecord(blueprint);
  if (!record) return [];
  return asArray<{ path?: string }>(record.files).map((file) => String(file?.path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()).filter(Boolean);
}

function getAppMustInclude(blueprint: unknown): string[] {
  const record = asRecord(blueprint);
  if (!record) return [];
  const appFile = asArray<{ path?: string; mustInclude?: string[] }>(record.files).find((file) => file.path === 'src/App.jsx');
  return asArray<string>(appFile?.mustInclude);
}


export function validateProjectConsistency(input: {
  projectSpec: ProjectSpec;
  requirementAnalysis?: unknown;
  clarifications?: unknown;
  systemDesign?: unknown;
  uiSpec?: unknown;
  blueprint?: unknown;
  codeGen?: unknown;
  activeStage?: string;
}): ConsistencyReport {
  const issues: ConsistencyIssue[] = [];
  const { projectSpec } = input;
  const activeStage = normalizePipelineStage(input.activeStage || 'done');

  const clarificationAnswers = projectSpec.clarificationAnswers || {};
  const clarifications = asRecord(input.clarifications) || asRecord(projectSpec.clarifications);
  const systemDesign = asRecord(input.systemDesign) || asRecord(projectSpec.systemDesign);
  const uiSpec = asRecord(input.uiSpec) || asRecord(projectSpec.uiSpec);
  const blueprint = asRecord(input.blueprint) || asRecord(projectSpec.blueprint);
  const codeGen = asRecord(input.codeGen);
  const requirements = asRecord(projectSpec.requirements);

  if (!projectSpec.userMessage.trim()) {
    addIssue(issues, 'projectSpec', 'userMessage is missing');
  }

  if (!requirements?.website_type) {
    addIssue(issues, 'requirements', 'website_type is missing');
  }

  if (!Array.isArray(requirements?.pages) || requirements.pages.length === 0) {
    addIssue(issues, 'requirements', 'pages are missing');
  }

  const askedQuestions = Array.isArray(projectSpec.askedQuestions) ? projectSpec.askedQuestions : [];
  const answerCount = Object.keys(clarificationAnswers).length;
  const clarificationConfirmed = Boolean(clarifications?.confirmed);

  if (!clarificationConfirmed && askedQuestions.length > 0 && answerCount === 0) {
    addIssue(issues, 'clarification', 'clarification answers are missing for unresolved questions');
  }

  // systemDesign checks: fire AT (and after) the systemDesign stage so the
  // producer stage itself is gated on its own invariants.
  if (atOrAfterStage(activeStage, 'systemDesign')) {
    if (requirements?.backend_required && !systemDesign) {
      addIssue(issues, 'systemDesign', 'required backend architecture is missing');
    }

    if (systemDesign) {
      const frontend = asRecord(systemDesign.frontend);
      const pages = asArray<unknown>(frontend?.pages).map(normalizePageName).filter(Boolean);
      const specPages = getRequirementPages(requirements);
      for (const page of specPages) {
        if (!pages.includes(page)) {
          addIssue(issues, 'systemDesign', `missing page from requirements: ${page}`);
        }
      }
    }
  }

  // uiSpec presence is only required once the uiSpec stage is in scope.
  if (atOrAfterStage(activeStage, 'uiSpec')) {
    if (systemDesign && !uiSpec) {
      addIssue(issues, 'uiSpec', 'UI spec is missing after system design');
    }
  }

  // blueprint checks: fire AT the blueprint stage (not after codeGen begins).
  if (atOrAfterStage(activeStage, 'blueprint')) {
    if (blueprint && systemDesign) {
      // A page is "covered" only when there is real implementation evidence in the
      // blueprint — a navigation route, a component, or a file. Merely echoing the
      // page name in `blueprint.strict.frontend.pages` is tautological (the agent
      // copies it there from requirements) so it does NOT count as coverage.
      //
      // For single-page projects (projectType=landing_page with one or zero
      // declared pages) the entire app composes the page; per-page route checking
      // is not meaningful and we skip it.
      const systemPages = asArray<unknown>(asRecord(systemDesign.frontend)?.pages).map(normalizePageName).filter(Boolean);
      const blueprintRecord = asRecord(blueprint);
      const strict = asRecord(blueprintRecord?.strict);
      const blueprintFrontend = asRecord(strict?.frontend);
      const projectType = String(strict?.projectType || '');
      const metadataNavRoutes = asArray<{ path?: string; component?: string }>(
        asRecord(asRecord(blueprintRecord?.metadata)?.navigation)?.routes ?? asRecord(blueprintRecord?.navigation)?.routes
      );
      const routeComponents = metadataNavRoutes.map((r) => String(r?.component || '').toLowerCase());
      const routePaths = metadataNavRoutes.map((r) => String(r?.path || '').toLowerCase());
      const blueprintComponents = asArray<unknown>(blueprintFrontend?.components).map((value) => String(value || '').toLowerCase());
      const blueprintFilePaths = getBlueprintPaths(blueprint).map((p) => p.toLowerCase());

      const isSinglePageApp =
        projectType === 'landing_page' &&
        systemPages.length <= 1;

      if (!isSinglePageApp) {
        for (const page of systemPages) {
          const slug = page.replace(/[^a-z0-9]/g, '');
          const covered =
            // Route path slug matches the page (e.g. /pricing for "pricing")
            routePaths.some((rp) => rp.replace(/[^a-z0-9]/g, '').includes(slug) && slug.length > 0) ||
            // A navigation route's component name carries the page identity
            routeComponents.some((c) => c.includes(page)) ||
            // A declared component carries the page identity
            blueprintComponents.some((component) => component.includes(page)) ||
            // A file path carries the page identity
            blueprintFilePaths.some((filePath) => filePath.includes(page));
          if (!covered) {
            addIssue(issues, 'blueprint', `blueprint missing route for system design page: ${page}`);
          }
        }
      }
    }

    if (uiSpec) {
      const componentNames = getComponentNamesFromUiSpec(uiSpec);
      const blueprintNames = blueprint ? getBlueprintComponentNames(blueprint) : [];
      const blueprintPaths = blueprint ? getBlueprintPaths(blueprint) : [];
      const blueprintRecord = asRecord(blueprint);
      const blueprintComponentList = asArray<unknown>(asRecord(asRecord(blueprintRecord?.strict)?.frontend)?.components)
        .map((value) => String(value || ''));

      for (const componentName of componentNames) {
        const found =
          blueprintNames.includes(componentName) ||
          blueprintComponentList.includes(componentName) ||
          blueprintPaths.some((filePath) => filePath.toLowerCase().includes(componentName.toLowerCase()));
        if (!found) {
          addIssue(issues, 'blueprint', `missing wiring for UI component: ${componentName}`);
        }
      }
    }

    if (blueprint) {
      // App.jsx wiring requirements are conditional, not universal:
      //   - 'App' is always required (composition root).
      //   - 'router' is required only when there is more than one navigation route.
      //   - 'fetch'/'API_BASE' is required only when a backend was requested.
      // Demanding all three on every project (the previous behaviour) made every
      // frontend-only run fail this check by design.
      const blueprintAppIncludes = getAppMustInclude(blueprint).map((token) => String(token));
      const blueprintRecord = asRecord(blueprint);
      const metadataNav = asRecord(blueprintRecord?.metadata)?.navigation;
      const topLevelNav = blueprintRecord?.navigation;
      const navigationRoutes = asArray<unknown>(asRecord(metadataNav)?.routes ?? asRecord(topLevelNav)?.routes);
      const routeCount = navigationRoutes.length;
      const backendRequired = Boolean(requirements?.backend_required || requirements?.auth_required);

      const includes = (pattern: RegExp) => blueprintAppIncludes.some((token) => pattern.test(token));

      if (!includes(/^App$|app/i)) {
        addIssue(issues, 'blueprint', 'src/App.jsx mustInclude must declare the App component');
      }
      if (routeCount > 1 && !includes(/router/i)) {
        addIssue(issues, 'blueprint', 'src/App.jsx mustInclude must declare router wiring (multiple routes present)');
      }
      if (backendRequired && !includes(/API_BASE|fetch/i)) {
        addIssue(issues, 'blueprint', 'src/App.jsx mustInclude must declare API_BASE/fetch wiring (backend required)');
      }
    }
  }

  // codeGen checks: fire AT the code_generation stage.
  if (atOrAfterStage(activeStage, 'codeGen')) {
    if (codeGen) {
      const files = asArray<{ path?: string; content?: string }>(codeGen.files);
      const expectedPaths = new Set<string>([
        'src/App.jsx',
        'src/index.css',
        ...getComponentPathsFromUiSpec(uiSpec),
      ]);

      for (const expectedPath of expectedPaths) {
        if (expectedPath && !files.some((file) => String(file?.path || '').replace(/\\/g, '/').replace(/^\/+/, '') === expectedPath)) {
          addIssue(issues, 'codeGen', `missing generated file for expected path: ${expectedPath}`);
        }
      }

      for (const file of files) {
        const normalized = String(file?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (normalized === 'src/App.jsx' && !String(file?.content || '').includes('export default function App')) {
          addIssue(issues, 'codeGen', 'generated App.jsx is missing default App export');
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function formatConsistencyIssues(report: ConsistencyReport): string {
  if (report.ok) return 'Project consistency checks passed.';
  return report.issues.map((issue) => `[${issue.stage}] ${issue.message}`).join('\n');
}
