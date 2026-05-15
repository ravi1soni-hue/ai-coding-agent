import { debug } from '../utils/logger';
import { validateProjectBlueprint, type BlueprintApproval, type ProjectBlueprint } from './blueprintContract';
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';

type ReviewerFile = { path: string; content: string };

type ReviewerInput = {
  blueprint: ProjectBlueprint;
  reviewerName?: string;
  /** When provided alongside projectId, enables the LLM code-review pass. */
  files?: ReviewerFile[];
  /** Required for the LLM pass — enables per-project token budget enforcement. */
  projectId?: string;
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

/**
 * Build a compact, token-bounded view of generated files for the LLM.
 * Strategy: include every file's path; include the head of each file up to a
 * shared character cap so prompts stay within budget on large projects.
 */
function buildFilesDigest(files: ReviewerFile[], totalCharCap = 24_000): string {
  if (!files.length) return '';
  const perFileCap = Math.max(800, Math.floor(totalCharCap / Math.max(1, files.length)));
  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    const head = String(f.content || '').slice(0, perFileCap);
    const block = `--- ${f.path} ---\n${head}`;
    if (used + block.length > totalCharCap) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

type LlmReviewVerdict = {
  approved: boolean;
  notes: string[];
};

function parseLlmReviewVerdict(raw: string): LlmReviewVerdict {
  // Models occasionally wrap JSON in markdown fences; strip them defensively.
  const cleaned = raw.replace(/```json\s*|```\s*$|^\s*```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { approved: true, notes: [] };
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const notes = Array.isArray(parsed?.notes)
      ? parsed.notes.map((n: unknown) => String(n)).filter((n: string) => n.trim().length > 0)
      : [];
    const approved = typeof parsed?.approved === 'boolean' ? parsed.approved : notes.length === 0;
    return { approved, notes };
  } catch {
    return { approved: true, notes: [] };
  }
}

async function runLlmReview(
  blueprint: ProjectBlueprint,
  files: ReviewerFile[],
  projectId: string,
): Promise<LlmReviewVerdict | null> {
  const chain = getModelPriorityChain('code_review');
  const [primary, ...fallbacks] = chain;
  if (!primary?.apiKey) {
    debug('reviewerAgent:llm_skip', { reason: 'no_api_key' });
    return null;
  }

  const client = new LLMProxyClient({ apiKey: primary.apiKey, projectId, fallbacks });
  const digest = buildFilesDigest(files);
  const blueprintSummary = JSON.stringify({
    title: blueprint.title,
    invariants: blueprint.invariants,
    navigation: blueprint.navigation,
    fileList: (blueprint.files || []).map((f: any) => f?.path).filter(Boolean),
  }).slice(0, 6000);

  const system = [
    'You are a senior code reviewer auditing a generated codebase against its blueprint.',
    'Surface only concrete, high-signal issues: security holes, broken imports, missing error handling,',
    'contract drift between blueprint and code, dead state, and obvious correctness bugs.',
    'Ignore style nits and subjective preferences. Be terse.',
    'Respond with strict JSON: {"approved": boolean, "notes": string[]}.',
    'If the code is acceptable, return {"approved": true, "notes": []}.',
  ].join(' ');

  const user = [
    'Blueprint (summary):',
    blueprintSummary,
    '',
    'Generated files (truncated):',
    digest || '(no files provided)',
    '',
    'Return JSON only.',
  ].join('\n');

  try {
    const response = await client.chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      primary.model,
      0.2,
      0.9,
      800,
    );
    const text = String(response?.choices?.[0]?.message?.content ?? response?.content ?? '');
    if (!text.trim()) return null;
    return parseLlmReviewVerdict(text);
  } catch (err: any) {
    // LLM review is advisory — never block the pipeline if the proxy is unhealthy.
    debug('reviewerAgent:llm_error', { error: err?.message || String(err) });
    return null;
  }
}

export async function reviewerAgent(input: ReviewerInput): Promise<ProjectBlueprint> {
  debug('reviewerAgent:start', { title: input.blueprint?.title, fileCount: input.files?.length || 0 });

  const blueprint = validateProjectBlueprint(input.blueprint);
  const notes = buildApprovalNotes(blueprint);

  const filesForReview = Array.isArray(input.files) ? input.files.filter((f) => f && f.path && typeof f.content === 'string') : [];
  if (input.projectId && filesForReview.length > 0) {
    const verdict = await runLlmReview(blueprint, filesForReview, input.projectId);
    if (verdict && verdict.notes.length > 0) {
      for (const note of verdict.notes) {
        const tagged = note.startsWith('[llm]') ? note : `[llm] ${note}`;
        if (!notes.includes(tagged)) notes.push(tagged);
      }
    }
  }

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
