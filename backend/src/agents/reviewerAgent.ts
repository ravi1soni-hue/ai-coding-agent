import { debug } from '../utils/logger';
import { validateProjectBlueprint, type BlueprintApproval, type ProjectBlueprint } from './blueprintContract';

type ReviewerInput = {
  blueprint: ProjectBlueprint;
  reviewerName?: string;
};

function buildApprovalNotes(blueprint: ProjectBlueprint): string[] {
  const notes: string[] = [];

  if (!Array.isArray(blueprint.files) || blueprint.files.length === 0) {
    notes.push('Blueprint has no files.');
  }

  const hasBackendRoutes = Array.isArray(blueprint.backendRoutes) && blueprint.backendRoutes.length > 0;

  if (!blueprint.invariants.some((rule) => /project_id/i.test(rule))) {
    notes.push('Blueprint is missing a project_id isolation invariant.');
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
