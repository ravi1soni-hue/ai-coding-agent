import type { RequirementAnalysisOutput } from './requirementAnalysisAgent';
import type { ClarificationOutput } from './clarificationAgent';

export type ProjectSpec = {
  projectId?: string;
  userMessage: string;
  requirements: RequirementAnalysisOutput;
  clarifications: ClarificationOutput;
  clarificationAnswers: Record<string, string>;
  askedQuestions: string[];
  systemDesign?: unknown;
  uiSpec?: unknown;
  blueprint?: unknown;
  modification?: string;
  createdAt: string;
  validated: boolean;
};

export function consolidateProjectSpec(input: {
  projectId?: string;
  userMessage: string;
  requirements: RequirementAnalysisOutput;
  clarifications: ClarificationOutput;
  clarificationAnswers: Record<string, string>;
  systemDesign?: unknown;
  uiSpec?: unknown;
  blueprint?: unknown;
  modification?: string;
}): ProjectSpec {
  const clarificationAnswers = normalizeAnswerMap(input.clarificationAnswers);
  const askedQuestions = Array.isArray(input.clarifications?.context?.askedQuestions)
    ? input.clarifications.context.askedQuestions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  return {
    projectId: input.projectId,
    userMessage: input.userMessage.trim(),
    requirements: input.requirements,
    clarifications: input.clarifications,
    clarificationAnswers,
    askedQuestions,
    systemDesign: input.systemDesign,
    uiSpec: input.uiSpec,
    blueprint: input.blueprint,
    modification: input.modification,
    createdAt: new Date().toISOString(),
    validated: false,
  };
}

export function validateProjectSpec(spec: ProjectSpec, options?: { partial?: boolean }): ProjectSpec {
  const errors: string[] = [];

  if (!spec.userMessage?.trim()) errors.push('userMessage is required');
  if (!spec.requirements?.website_type) errors.push('requirements.website_type is required');
  if (!options?.partial) {
    if (!Array.isArray(spec.requirements?.pages) || spec.requirements.pages.length === 0) errors.push('requirements.pages cannot be empty');
    if (!spec.clarifications || typeof spec.clarifications !== 'object') errors.push('clarifications are required');
  }

  if (spec.requirements?.backend_required && !spec.systemDesign && !options?.partial) {
    errors.push('systemDesign is required when backend_required is true');
  }

  // Sequential stage checks are only enforced for complete (non-partial) specs.
  // Intermediate pipeline builds pass partial=true to avoid premature failures before
  // downstream stages (uiSpec, blueprint) have been generated.
  if (!options?.partial) {
    if (spec.systemDesign && !spec.uiSpec) {
      errors.push('uiSpec is required after systemDesign');
    }

    if (spec.uiSpec && !spec.blueprint) {
      errors.push('blueprint is required after uiSpec');
    }
  }

  const hasAnyClarification = Object.keys(spec.clarificationAnswers || {}).length > 0;
  if (spec.clarifications?.confirmed === false && spec.askedQuestions.length > 0 && !hasAnyClarification) {
    errors.push('clarification answers are required when clarification stage is not confirmed');
  }

  if (errors.length > 0) {
    throw new Error(`ProjectSpec validation failed: ${errors.join('; ')}`);
  }

  return {
    ...spec,
    validated: true,
  };
}

function normalizeAnswerMap(input: Record<string, string> | undefined): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  return Object.entries(input).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) {
      acc[key.trim()] = value.trim();
    }
    return acc;
  }, {});
}
