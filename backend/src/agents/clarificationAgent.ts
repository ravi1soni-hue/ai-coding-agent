import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';

export type ClarificationContext = {
  clarificationAnswers: Record<string, string>;
  askedQuestions: string[];
  modification?: string;
  lastQuestion?: string;
  lastAnswer?: string;
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

function shouldAskMoreQuestions(requirements: any, projectSpec: any): boolean {
  const text = JSON.stringify({ requirements, projectSpec }).toLowerCase();

  // Ask more questions when the request is specific enough to support follow-up
  // product decisions, but still lacks a fully consolidated spec.
  const ambiguitySignals = [
    /\b(maybe|some|various|several|etc|and\/or|whatever|something)\b/,
    /\b(soon|later|flexible|optional|possibly|ideally)\b/,
    /\b(tbd|todo|placeholder|unspecified|unknown)\b/,
    /\b(what should|which should|how many|how much|which style|what kind)\b/,
    /\b(need help deciding|open to suggestions|not sure)\b/,
  ];

  const hasStrongDirectionalSignals =
    /\b(pricing page|landing page|dashboard|admin panel|checkout|portfolio|blog|store|saas|ecommerce|marketing site|single page|multi page)\b/.test(text) ||
    /\b(monthly|yearly|toggle|accordion|cards|table|faq|cta|theme|dark mode|light mode|responsive)\b/.test(text) ||
    /\b(react|vite|frontend|backend|api|database|auth|postg(res|re)|express)\b/.test(text);

  const askedQuestions = Array.isArray(projectSpec?.askedQuestions) ? projectSpec.askedQuestions.length : 0;
  const clarificationAnswers = projectSpec?.clarificationAnswers && typeof projectSpec.clarificationAnswers === 'object'
    ? Object.keys(projectSpec.clarificationAnswers).length
    : 0;

  if (hasStrongDirectionalSignals && askedQuestions === 0 && clarificationAnswers === 0) {
    return true;
  }

  return ambiguitySignals.some((pattern) => pattern.test(text));
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

export async function clarificationAgent(input: any): Promise<ClarificationOutput> {
  debug('clarificationAgent', { input });
  if (!input?.requirements) throw new Error('Input with requirements required');

  const { model, apiKey } = getModelConfigForTask('clarification');
  const llmProxy = new LLMProxyClient({ apiKey });

  const clarificationAnswers: Record<string, string> = input.clarificationAnswers || {};
  const askedQuestions: string[] = Array.isArray(input.askedQuestions) ? input.askedQuestions : [];
  const projectSpec = input.projectSpec || null;
  const context: ClarificationContext = {
    clarificationAnswers,
    askedQuestions,
    modification: input.modification,
    lastQuestion: input.lastQuestion,
    lastAnswer: input.lastAnswer,
  };

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

      const shouldContinue = shouldAskMoreQuestions(input.requirements, projectSpec);
      const resolvedQuestions = shouldContinue ? questions : [];
      const resolvedConfirmed = resolvedQuestions.length === 0;

      return {
        questions: resolvedQuestions,
        confirmed: resolvedConfirmed,
        done: resolvedConfirmed,
        context,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logError('clarificationAgent:attempt-failed', { attempt, error: lastError });
      if (attempt < MAX_ATTEMPTS) {
        continue;
      }
    }
  }

  throw new Error(`Clarification generation failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError}`);
}
