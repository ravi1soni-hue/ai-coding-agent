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

function normalizeTextValue(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate = record.name ?? record.title ?? record.label ?? record.page ?? record.path;
    if (typeof candidate === 'string') return candidate.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function getRequirementPages(requirements: Record<string, unknown> | null): string[] {
  if (!requirements) return [];
  return asArray<unknown>(requirements.pages)
    .map(normalizeTextValue)
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

  // systemDesign checks: only after systemDesign stage has run
  if (atOrAfterStage(activeStage, 'uiSpec')) {
    if (requirements?.backend_required && !systemDesign) {
      addIssue(issues, 'systemDesign', 'required backend architecture is missing');
    }

    if (systemDesign) {
      const frontend = asRecord(systemDesign.frontend);
      const pages = asArray<unknown>(frontend?.pages).map(normalizeTextValue).filter(Boolean);
      const specPages = getRequirementPages(requirements);
      for (const page of specPages) {
        if (!pages.includes(page)) {
          addIssue(issues, 'systemDesign', `missing page from requirements: ${page}`);
        }
      }
    }

    if (systemDesign && !uiSpec) {
      addIssue(issues, 'uiSpec', 'UI spec is missing after system design');
    }
  }

  // blueprint checks: only after blueprint stage has run
  if (atOrAfterStage(activeStage, 'codeGen')) {
    if (uiSpec) {
      const componentNames = getComponentNamesFromUiSpec(uiSpec);
      const blueprintNames = blueprint ? getBlueprintComponentNames(blueprint) : [];
      const blueprintPaths = blueprint ? getBlueprintPaths(blueprint) : [];

      for (const componentName of componentNames) {
        if (!blueprintNames.includes(componentName) && !blueprintPaths.some((filePath) => filePath.includes(componentName))) {
          addIssue(issues, 'blueprint', `missing wiring for UI component: ${componentName}`);
        }
      }
    }

    if (blueprint) {
      const blueprintAppIncludes = getAppMustInclude(blueprint);
      if (!blueprintAppIncludes.some((token) => /router|API_BASE|fetch/i.test(token))) {
        addIssue(issues, 'blueprint', 'src/App.jsx blueprint is missing API_BASE/router/fetch wiring');
      }
    }
  }

  // codeGen checks: only after codeGeneration stage has run
  if (atOrAfterStage(activeStage, 'testFix')) {
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
