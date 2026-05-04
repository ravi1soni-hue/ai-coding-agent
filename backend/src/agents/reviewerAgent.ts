import { debug } from '../utils/logger';
import { validateProjectBlueprint, type BlueprintApproval, type ProjectBlueprint } from './blueprintContract';

type ReviewerInput = {
  blueprint: ProjectBlueprint;
  reviewerName?: string;
};

function buildApprovalNotes(blueprint: ProjectBlueprint): string[] {
  const notes: string[] = [];
  const files = Array.isArray(blueprint.files) ? blueprint.files : [];
  const invariants = Array.isArray(blueprint.invariants) ? blueprint.invariants : [];
  const navigationRoutes = blueprint.navigation?.routes || [];

  if (files.length === 0) {
    notes.push('Blueprint has no files.');
  }

  if (!invariants.some((rule: string) => /project_id/i.test(rule))) {
    notes.push('Blueprint is missing a project_id isolation invariant.');
  }

  if (navigationRoutes.length > 0 && !navigationRoutes.some((route) => route.component === 'App')) {
    notes.push('Blueprint navigation is missing the App root route.');
  }

  return notes;
}

export async function reviewerAgent(input: ReviewerInput): Promise<ProjectBlueprint> {
  debug('reviewerAgent:start', { title: input.blueprint?.title });

  const blueprint = validateProjectBlueprint(input.blueprint);
  const notes = buildApprovalNotes(blueprint);
  const approved = notes.length === 0;

  const approval: BlueprintApproval = {
    approved,
    reviewer: input.reviewerName || 'Reviewer Agent',
    reviewedAt: new Date().toISOString(),
    notes,
  };

  const reviewedBlueprint: ProjectBlueprint = {
    ...blueprint,
    approved: approval,
  };

  debug('reviewerAgent:done', {
    title: reviewedBlueprint.title,
    approved: approval.approved,
    noteCount: approval.notes.length,
  });

  return reviewedBlueprint;
}
