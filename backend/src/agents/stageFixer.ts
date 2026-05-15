// Surgical fix agent — patches an artifact in place using reviewer notes.
// Output is round-tripped through the stage's schema validator; an invalid
// patch returns null so the caller can fall back to full regeneration.
import { debug } from '../utils/logger';
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { parseJsonResponse } from './llmUtils';
import { validateStructuredSpec, type StructuredSpec } from './structuredSpec';
import type { RequirementsMemory, ClarificationMemory } from '../ai/contracts/orchestration';
import { buildRequirementsDigest, type ReviewableStage } from './stageReviewer';

export type StageFixInput = {
  stage: ReviewableStage;
  projectId: string;
  artifact: unknown;
  notes: string[];
  requirements?: RequirementsMemory;
  clarifications?: ClarificationMemory;
};

export type StageFixResult = {
  /** The patched artifact, schema-validated. */
  artifact: unknown;
  /** Reviewer notes the fixer claims to have addressed. */
  applied: string[];
  /** Notes the fixer rejected as false positives, with reasoning. */
  rejected: Array<{ note: string; reason: string }>;
  /**
   * True when the fixer applied no notes and rejected every input note as a
   * false positive. The caller should treat this as "stop looping" — the
   * fixer is pushing back on the reviewer, and re-running review will just
   * regenerate the same notes.
   */
  allRejected: boolean;
};

function buildArtifactDigest(artifact: unknown, cap = 12000): string {
  try {
    return JSON.stringify(artifact).slice(0, cap);
  } catch {
    return String(artifact).slice(0, cap);
  }
}

type RawFixResponse = {
  artifact?: unknown;
  applied?: unknown;
  rejected?: unknown;
};

function parseFixResponse(raw: string): RawFixResponse | null {
  try {
    return parseJsonResponse(raw) as RawFixResponse;
  } catch {
    return null;
  }
}

function normalizeApplied(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
}

function normalizeRejected(value: unknown): Array<{ note: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ note: string; reason: string }> = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      const note = String((entry as any).note ?? '').trim();
      const reason = String((entry as any).reason ?? '').trim();
      if (note) out.push({ note, reason: reason || 'no reason given' });
    }
  }
  return out;
}

/**
 * Stage-specific schema validation. Returns the validated artifact, or throws
 * if the patched output does not satisfy the contract. The orchestrator treats
 * a throw here as "fixer failed, fall back to regenerate".
 */
function validatePatched(stage: ReviewableStage, artifact: unknown): unknown {
  switch (stage) {
    case 'ui_spec': {
      // The orchestrator stores both `uiSpec` and `structuredSpec` from the same
      // StructuredSpec value; we validate against that shape.
      const validated: StructuredSpec = validateStructuredSpec(artifact);
      return validated;
    }
    case 'system_design': {
      // Light shape check — must be an object with the canonical top-level keys.
      // Existing `assertConsistencyWithSelfHeal` covers deeper semantics.
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        throw new Error('system_design must be an object');
      }
      const obj = artifact as Record<string, unknown>;
      for (const key of ['frontend', 'backend', 'database', 'auth', 'hosting']) {
        if (!(key in obj)) throw new Error(`system_design is missing required key "${key}"`);
      }
      return artifact;
    }
    case 'blueprint': {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        throw new Error('blueprint must be an object');
      }
      const obj = artifact as Record<string, unknown>;
      if (!Array.isArray(obj.files)) throw new Error('blueprint.files must be an array');
      return artifact;
    }
  }
}

export async function fixStage(input: StageFixInput): Promise<StageFixResult | null> {
  if (!input.notes.length) return null;

  const chain = getModelPriorityChain('stage_review');
  const [primary, ...fallbacks] = chain;
  if (!primary?.apiKey) {
    debug('stageFixer:skip', { stage: input.stage, reason: 'no_api_key' });
    return null;
  }

  const client = new LLMProxyClient({ apiKey: primary.apiKey, projectId: input.projectId, fallbacks });

  const system = [
    `You are a surgical fix agent for the "${input.stage}" artifact in a multi-agent code-generation pipeline.`,
    'You receive a JSON artifact and a list of reviewer notes. For each note, either:',
    '  (a) apply the smallest possible change to the artifact that resolves the note, OR',
    '  (b) reject the note as a false positive with a one-sentence reason.',
    'Do NOT rewrite or restructure parts of the artifact that are not implicated by a note.',
    'Preserve the artifact schema exactly. Preserve existing component names, file paths, and identifiers unless a note requires changing them.',
    'Respond with strict JSON of the form:',
    '{"artifact": <patched artifact, same schema as input>,',
    ' "applied": [<note strings you addressed>],',
    ' "rejected": [{"note": <note string>, "reason": <why this is a false positive>}]}',
    'Every reviewer note must appear in either "applied" or "rejected".',
  ].join(' ');

  const user = [
    'Requirements:',
    buildRequirementsDigest(input.requirements, input.clarifications),
    '',
    `Reviewer notes for ${input.stage}:`,
    input.notes.map((n, i) => `${i + 1}. ${n}`).join('\n'),
    '',
    `Current ${input.stage} artifact:`,
    buildArtifactDigest(input.artifact),
    '',
    'Return JSON only.',
  ].join('\n');

  let raw: RawFixResponse | null = null;
  try {
    const response = await client.chatCompletion(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      primary.model,
      0.1,
      0.9,
      2000,
    );
    const text = String(response?.choices?.[0]?.message?.content ?? response?.content ?? '');
    if (!text.trim()) return null;
    raw = parseFixResponse(text);
  } catch (err: any) {
    debug('stageFixer:llm_error', { stage: input.stage, error: err?.message || String(err) });
    return null;
  }

  if (!raw || raw.artifact === undefined) return null;

  let validated: unknown;
  try {
    validated = validatePatched(input.stage, raw.artifact);
  } catch (err: any) {
    debug('stageFixer:schema_invalid', { stage: input.stage, error: err?.message || String(err) });
    return null;
  }

  const applied = normalizeApplied(raw.applied);
  const rejected = normalizeRejected(raw.rejected);
  const allRejected = applied.length === 0 && rejected.length >= input.notes.length;

  debug('stageFixer:done', {
    stage: input.stage,
    appliedCount: applied.length,
    rejectedCount: rejected.length,
    allRejected,
  });

  return { artifact: validated, applied, rejected, allRejected };
}
