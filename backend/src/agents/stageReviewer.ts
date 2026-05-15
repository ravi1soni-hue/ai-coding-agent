// Stage-scoped reviewer — deterministic rules + optional cheap LLM pass.
// Fails safe: LLM unavailability falls back to rules-only output so a flaky
// proxy never blocks forward progress.
import { debug } from '../utils/logger';
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { parseJsonResponse } from './llmUtils';
import type { RequirementsMemory, ClarificationMemory } from '../ai/contracts/orchestration';

export type ReviewableStage = 'system_design' | 'ui_spec' | 'blueprint';

export type StageReviewInput = {
  stage: ReviewableStage;
  projectId: string;
  requirements?: RequirementsMemory;
  clarifications?: ClarificationMemory;
  /** Raw artifact to review. Stage-specific shape — see rule functions. */
  artifact: unknown;
};

export type StageReviewResult = {
  approved: boolean;
  /** Raw notes with `[llm]` prefix preserved for logging/history. */
  notes: string[];
  /** Same notes with `[llm]` prefix stripped, ready to feed agents/fixer. */
  hints: string[];
};

// ---------------------------------------------------------------------------
// Deterministic per-stage rules
// ---------------------------------------------------------------------------

function reviewUiSpecRules(input: StageReviewInput): string[] {
  const notes: string[] = [];
  const spec: any = input.artifact;
  if (!spec || typeof spec !== 'object') {
    notes.push('UI spec is missing entirely.');
    return notes;
  }

  const components: any[] = Array.isArray(spec.componentSchema) ? spec.componentSchema : [];
  const layoutTree = spec.layoutTree;
  const apiContracts: any[] = Array.isArray(spec.apiContracts) ? spec.apiContracts : [];

  if (components.length === 0) {
    notes.push('componentSchema is empty — no components defined.');
  }
  if (!layoutTree || typeof layoutTree !== 'object') {
    notes.push('layoutTree is missing — no root layout to render.');
  }

  // Page coverage: every requested page should map to at least one component
  // whose name is the page word as a whole token (PascalCase or snake-separated),
  // not just a substring. "Dashboard" page must match "Dashboard" or
  // "DashboardPage", NOT "DashboardCard" / "UserDashboardWidget".
  const requestedPages = Array.isArray(input.requirements?.pages) ? input.requirements!.pages : [];
  if (requestedPages.length > 0 && components.length > 0) {
    const componentNames = components.map((c) => String(c?.name || '')).filter(Boolean);
    for (const page of requestedPages) {
      const needle = String(page || '').replace(/[^a-zA-Z0-9]/g, '');
      if (!needle) continue;
      // Token boundary: needle must appear as a PascalCase token (start of name,
      // or preceded by a non-letter), optionally followed by "Page"/"Screen"/"View".
      const tokenRe = new RegExp(`(^|[^a-zA-Z])${needle}(Page|Screen|View)?($|[^a-zA-Z])`, 'i');
      const matched = componentNames.some((name) => tokenRe.test(name));
      if (!matched) {
        notes.push(`Requested page "${page}" has no matching component in componentSchema.`);
      }
    }
  }

  // Backend coverage: if requirements demand backend, apiContracts should exist.
  if (input.requirements?.backend_required && apiContracts.length === 0) {
    notes.push('requirements.backend_required is true but apiContracts is empty.');
  }

  // Auth coverage: if auth is required, the spec should mention auth somewhere.
  if (input.requirements?.auth_required) {
    const haystack = JSON.stringify({ components: components.map((c) => c?.name), apiContracts }).toLowerCase();
    if (!/auth|login|signin|signup|session/.test(haystack)) {
      notes.push('requirements.auth_required is true but spec has no auth/login surface.');
    }
  }

  return notes;
}

function reviewSystemDesignRules(input: StageReviewInput): string[] {
  const notes: string[] = [];
  const sd: any = input.artifact;
  if (!sd || typeof sd !== 'object') {
    notes.push('System design is missing entirely.');
    return notes;
  }
  if (!sd.frontend) notes.push('System design has no frontend module.');
  if (input.requirements?.backend_required && !sd.backend) {
    notes.push('requirements.backend_required is true but system design has no backend module.');
  }
  if (input.requirements?.auth_required && !sd.auth) {
    notes.push('requirements.auth_required is true but system design has no auth module.');
  }
  return notes;
}

function reviewBlueprintRules(input: StageReviewInput): string[] {
  const notes: string[] = [];
  const bp: any = input.artifact;
  if (!bp || typeof bp !== 'object') {
    notes.push('Blueprint is missing entirely.');
    return notes;
  }
  const files = Array.isArray(bp.files) ? bp.files : [];
  if (files.length === 0) notes.push('Blueprint has no files.');
  return notes;
}

function runDeterministicRules(input: StageReviewInput): string[] {
  switch (input.stage) {
    case 'ui_spec': return reviewUiSpecRules(input);
    case 'system_design': return reviewSystemDesignRules(input);
    case 'blueprint': return reviewBlueprintRules(input);
  }
}

// Shared digest builders — also imported by stageFixer so the prompts the
// reviewer and the fixer see remain in sync.
export function buildRequirementsDigest(
  requirements: RequirementsMemory | undefined,
  clarifications: ClarificationMemory | undefined,
  cap = 2000,
): string {
  const summary = {
    userMessage: requirements?.userMessage,
    website_type: requirements?.website_type,
    pages: requirements?.pages,
    backend_required: requirements?.backend_required,
    auth_required: requirements?.auth_required,
    clarifications: clarifications?.answers,
  };
  try {
    return JSON.stringify(summary).slice(0, cap);
  } catch {
    return '';
  }
}

export function buildArtifactDigest(artifact: unknown, cap = 8000): string {
  try {
    return JSON.stringify(artifact).slice(0, cap);
  } catch {
    return String(artifact).slice(0, cap);
  }
}

type LlmVerdict = { approved: boolean; notes: string[] };

function parseLlmVerdict(raw: string): LlmVerdict {
  try {
    const parsed = parseJsonResponse(raw);
    const notes = Array.isArray(parsed?.notes)
      ? parsed.notes.map((n: unknown) => String(n)).filter((n: string) => n.trim().length > 0)
      : [];
    const approved = typeof parsed?.approved === 'boolean' ? parsed.approved : notes.length === 0;
    return { approved, notes };
  } catch {
    // Fail safe: unparseable → treat as approved so a flaky LLM never blocks.
    return { approved: true, notes: [] };
  }
}

async function runLlmStageReview(input: StageReviewInput): Promise<LlmVerdict | null> {
  const chain = getModelPriorityChain('stage_review');
  const [primary, ...fallbacks] = chain;
  if (!primary?.apiKey) {
    debug('stageReviewer:llm_skip', { stage: input.stage, reason: 'no_api_key' });
    return null;
  }

  const client = new LLMProxyClient({ apiKey: primary.apiKey, projectId: input.projectId, fallbacks });
  const system = [
    `You are a strict reviewer auditing the "${input.stage}" output of a multi-agent code-generation pipeline.`,
    'Compare the artifact against the user requirements. Surface only concrete, high-signal defects:',
    'missing pages, missing modules, contract drift, requirement-coverage gaps. Ignore style and naming preferences.',
    'Each note must be actionable — name the missing thing and where it belongs.',
    'Respond with strict JSON: {"approved": boolean, "notes": string[]}.',
    'If the artifact satisfies the requirements, return {"approved": true, "notes": []}.',
  ].join(' ');

  const user = [
    'Requirements:',
    buildRequirementsDigest(input.requirements, input.clarifications),
    '',
    `Artifact (${input.stage}):`,
    buildArtifactDigest(input.artifact),
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
      0.1,
      0.9,
      500,
    );
    const text = String(response?.choices?.[0]?.message?.content ?? response?.content ?? '');
    if (!text.trim()) return null;
    return parseLlmVerdict(text);
  } catch (err: any) {
    debug('stageReviewer:llm_error', { stage: input.stage, error: err?.message || String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function reviewStage(input: StageReviewInput): Promise<StageReviewResult> {
  debug('stageReviewer:start', { stage: input.stage });

  const notes = runDeterministicRules(input);

  // Skip the LLM pass when deterministic checks already failed — we already
  // have actionable feedback, no need to burn tokens to learn more.
  if (notes.length === 0) {
    const verdict = await runLlmStageReview(input);
    if (verdict && verdict.notes.length > 0) {
      for (const note of verdict.notes) {
        const tagged = note.startsWith('[llm]') ? note : `[llm] ${note}`;
        notes.push(tagged);
      }
    }
  }

  const hints = notes.map((n) => n.replace(/^\[llm\]\s*/, ''));
  const approved = notes.length === 0;

  debug('stageReviewer:done', { stage: input.stage, approved, noteCount: notes.length });

  return { approved, notes, hints };
}
