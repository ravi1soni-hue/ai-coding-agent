import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import type { ProjectBlueprint } from './blueprintContract';

export type ClarificationContext = {
  clarificationAnswers: Record<string, string>;
  askedQuestions: string[];
  modification?: string;
  lastQuestion?: string;
  lastAnswer?: string;
};

export type BrainState = {
  activeState: string;
  projectSpec?: unknown;
  blueprint?: ProjectBlueprint;
  consistencyScore?: number;
  domain?: string;
  transitions?: string[];
  metadata?: Record<string, unknown>;
};

export type StateAwareAgentResult<T> = {
  updatedState: Partial<BrainState>;
  nextStateProposal: string;
  consistencyScore: number;
  output: T;
};

export type ClarificationOutput = {
  questions: string[];
  confirmed: boolean;
  done: boolean;
  context: ClarificationContext;
};

const MAX_QUESTIONS = 3;
const MAX_ATTEMPTS = 3;

function stripCodeFences(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
}

function parseJsonObject(content: string): any {
  const cleaned = stripCodeFences(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('Malformed LLM output: no JSON object found');
  }
}

function normalizeQuestionList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS);
}

function filterAskedQuestions(questions: string[], askedQuestions: string[], clarificationAnswers: Record<string, string>): string[] {
  const askedSet = new Set(askedQuestions.map((q) => q.trim().toLowerCase()));
  const answeredSet = new Set(Object.keys(clarificationAnswers).map((q) => q.trim().toLowerCase()));
  return questions.filter((question) => {
    const normalized = question.trim().toLowerCase();
    return normalized.length > 0 && !askedSet.has(normalized) && !answeredSet.has(normalized);
  });
}

function normalizeText(value: unknown): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function calculateSemanticGap(requirements: any, projectSpec: any): number {
  const text = JSON.stringify({ requirements, projectSpec }).toLowerCase();
  const positive =
    (/\bpricing page|landing page|dashboard|admin panel|checkout|portfolio|blog|store|saas|ecommerce|marketing site|single page|multi page\b/.test(text) ? 0.2 : 0) +
    (/\breact|vite|frontend|backend|api|database|auth|postgres|express\b/.test(text) ? 0.2 : 0) +
    (/\btitle|pages|components|routes|layout|navigation\b/.test(text) ? 0.15 : 0);
  const negative =
    (/\bmaybe|some|various|several|etc|and\/or|whatever|something\b/.test(text) ? 0.15 : 0) +
    (/\btbd|todo|placeholder|unspecified|unknown\b/.test(text) ? 0.2 : 0) +
    (/\bnot sure|open to suggestions|need help deciding\b/.test(text) ? 0.15 : 0);
  return Math.max(0, Math.min(1, 0.45 + positive - negative));
}

function shouldAskMoreQuestions(requirements: any, projectSpec: any): boolean {
  const askedQuestions = Array.isArray(projectSpec?.askedQuestions) ? projectSpec.askedQuestions.length : 0;
  const clarificationAnswers = projectSpec?.clarificationAnswers && typeof projectSpec.clarificationAnswers === 'object'
    ? Object.keys(projectSpec.clarificationAnswers).length
    : 0;
  const semanticGap = calculateSemanticGap(requirements, projectSpec);
  if (askedQuestions === 0 && clarificationAnswers === 0 && semanticGap > 0.7) return true;
  return semanticGap < 0.55;
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = normalizeText(currentState);
  const normalizedNext = normalizeText(nextState);
  if (!normalizedNext) return 'clarification_required';
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

function buildClarificationPrompt(input: any, projectSpec: any): string {
  return `You are a senior requirements clarification agent.

Goal:
- Extract the missing product decisions needed to design and generate the app safely.
- Ask 2 to 3 blocking clarification questions at once when the request is incomplete or ambiguous.
- Ask fewer questions only if the requirements are already specific enough.
- Never repeat already asked or already answered questions.
- Focus on decisions that materially affect UI, data model, navigation, authentication, roles, CRUD flows, integrations, deployment behavior, and any file or API contracts implied by the canonical project spec.
- Use the canonical project spec as the source of truth when present.
- Ask questions only if they are necessary to remove ambiguity in the spec.
- Do not ask generic filler questions.
- If enough detail exists to proceed, return confirmed=true with an empty questions array.

Canonical project spec (if present):
${JSON.stringify(projectSpec, null, 2)}

Return ONLY valid JSON with this exact shape:
{
  "questions": ["string"],
  "confirmed": boolean
}

Rules:
- questions must be an array of 0 to 3 strings
- every question must be specific and answerable
- if questions.length > 0 then confirmed must be false
- if confirmed is true then questions must be []
- no markdown, no prose`;
}

export async function clarificationAgent(input: any): Promise<StateAwareAgentResult<ClarificationOutput>> {
  debug('clarificationAgent', { input });
  if (!input?.requirements) throw new Error('Input with requirements required');

  const clarificationAnswers: Record<string, string> = input.clarificationAnswers || {};
  const askedQuestions: string[] = Array.isArray(input.askedQuestions) ? input.askedQuestions : [];
  const activeState = String(input.activeState || input.globalState?.activeState || 'clarification');
  const projectSpec = input.projectSpec || null;
  const context: ClarificationContext = {
    clarificationAnswers,
    askedQuestions,
    modification: input.modification,
    lastQuestion: input.lastQuestion,
    lastAnswer: input.lastAnswer,
  };

  if (!['clarification', 'requirements'].includes(activeState)) {
    const output: ClarificationOutput = {
      questions: [],
      confirmed: false,
      done: false,
      context,
    };
    return {
      updatedState: {
        activeState,
        domain: 'clarification',
        consistencyScore: 0,
        transitions: [...(input.globalState?.transitions || []), `blocked:${activeState}`],
        metadata: { reason: 'gate_closed' },
      },
      nextStateProposal: transitionTo(activeState, 'clarification_required'),
      consistencyScore: 0,
      output,
    };
  }

  const { model, apiKey } = getModelConfigForTask('clarification');
  const llmProxy = new LLMProxyClient({ apiKey });
  const systemPrompt = buildClarificationPrompt(input, projectSpec);

  const userPrompt = JSON.stringify({
    requirements: input.requirements,
    projectSpec,
    clarificationAnswers,
    askedQuestions,
    modification: input.modification || null,
    lastQuestion: input.lastQuestion || null,
    lastAnswer: input.lastAnswer || null,
    questionBudget: MAX_QUESTIONS,
    askMoreQuestions: shouldAskMoreQuestions(input.requirements, projectSpec),
  });

  let lastError = 'Unknown clarification error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const completion = await llmProxy.chatCompletion(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model,
        0.4,
        0.9,
        1400
      );

      const raw = completion.choices?.[0]?.message?.content || '{}';
      debug('LLM_RAW_CONTENT_CLARIFICATION', { raw });

      const parsed = parseJsonObject(raw);
      const confirmed = Boolean(parsed?.confirmed);
      const questions = filterAskedQuestions(normalizeQuestionList(parsed?.questions), askedQuestions, clarificationAnswers);

      if (confirmed && questions.length > 0) {
        throw new Error('clarificationAgent: confirmed=true cannot include questions');
      }

      const semanticGap = calculateSemanticGap(input.requirements, projectSpec);
      const shouldContinue = shouldAskMoreQuestions(input.requirements, projectSpec);
      const resolvedQuestions = shouldContinue ? questions : [];
      const resolvedConfirmed = resolvedQuestions.length === 0;

      const output: ClarificationOutput = {
        questions: resolvedQuestions,
        confirmed: resolvedConfirmed,
        done: resolvedConfirmed,
        context,
      };

      const nextStateProposal = resolvedConfirmed ? transitionTo(activeState, 'system_design') : transitionTo(activeState, 'clarification_required');

      return {
        updatedState: {
          activeState: nextStateProposal,
          domain: 'clarification',
          consistencyScore: semanticGap,
          transitions: [...(input.globalState?.transitions || []), `clarification:${activeState}->${nextStateProposal}`],
          metadata: { lastQuestion: input.lastQuestion, semanticGap },
        },
        nextStateProposal,
        consistencyScore: semanticGap,
        output,
      };
    } catch (err) {
      lastError = (err as Error)?.message ?? String(err);
      logError('clarificationAgent:attempt-failed', { attempt, error: lastError });
      if (attempt < MAX_ATTEMPTS) {
        continue;
      }
    }
  }

  throw new Error(`Clarification generation failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`);
}
