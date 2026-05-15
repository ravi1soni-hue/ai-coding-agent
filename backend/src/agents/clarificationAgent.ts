import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { debug, error as logError } from '../utils/logger';
import type { ProjectBlueprint } from './blueprintContract';
import { parseJsonResponse } from './llmUtils';
import { AgentState } from './agentStates';

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
const MAX_CLARIFICATION_ROUNDS_FULLSTACK = 5;
// Frontend projects can be just as complex as fullstack ones (e.g. rich portfolios,
// dashboards, e-commerce UIs). Allow the same ceiling and let semantic gap decide.
const MAX_CLARIFICATION_ROUNDS_FRONTEND = 4;


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
  // Positive signals: structural clarity — pages defined, sections named, purpose clear.
  // Deliberately avoids specific platform/tech names so any project type scores fairly.
  const positive =
    (Array.isArray(requirements?.pages) && requirements.pages.length > 0 ? 0.2 : 0) +
    (/\bpages?\b|\bsections?\b|\bcomponents?\b|\broutes?\b|\blayout\b|\bnavigation\b/.test(text) ? 0.15 : 0) +
    (/\bpurpose\b|\bfeatures?\b|\bgoal\b|\buser\b|\bcontent\b|\bdesign\b/.test(text) ? 0.15 : 0);
  // Negative signals: vagueness and explicit deferral markers.
  const negative =
    (/\bmaybe\b|\bvarious\b|\betc\b|\bwhatever\b/.test(text) ? 0.15 : 0) +
    (/\btbd\b|\btodo\b|\bunspecified\b|\bunknown\b/.test(text) ? 0.2 : 0) +
    (/\bnot sure\b|\bopen to suggestions\b|\bneed help deciding\b/.test(text) ? 0.15 : 0);
  return Math.max(0, Math.min(1, 0.45 + positive - negative));
}

function targetClarificationCount(semanticGap: number): number {
  // Desired total number of clarifying questions (across rounds).
  // User asked: "2–5 depending upon clarity".
  if (semanticGap >= 0.75) return 5;
  if (semanticGap >= 0.62) return 4;
  if (semanticGap >= 0.48) return 3;
  return 2;
}

function shouldAskMoreQuestions(
  requirements: any,
  projectSpec: any,
  askedQuestionsList: string[] = [],
  clarificationAnswersMap: Record<string, string> = {}
): boolean {
  const askedFromSpec = Array.isArray(projectSpec?.askedQuestions) ? projectSpec.askedQuestions.length : 0;

  // Total questions already asked (best-effort, since spec/state may disagree).
  const totalAsked = Math.max(askedFromSpec, askedQuestionsList.length);

  const isFrontendOnly = !requirements?.backend_required;
  const maxRounds = isFrontendOnly ? MAX_CLARIFICATION_ROUNDS_FRONTEND : MAX_CLARIFICATION_ROUNDS_FULLSTACK;
  if (totalAsked >= maxRounds) return false;

  const semanticGap = calculateSemanticGap(requirements, projectSpec);
  const targetCount = Math.min(targetClarificationCount(semanticGap), maxRounds);

  // If we haven't reached the target questions yet, keep asking.
  return totalAsked < targetCount;
}

function transitionTo(currentState: string, nextState: string): string {
  const normalizedCurrent = normalizeText(currentState);
  const normalizedNext = normalizeText(nextState);
  if (!normalizedNext) return AgentState.NEXT_CLARIFICATION;
  if (!normalizedCurrent) return normalizedNext;
  return normalizedNext;
}

function buildClarificationPrompt(input: any, projectSpec: any): string {
  return `You are a senior product requirements clarification agent.

## Fixed tech stack — do NOT ask about these, ever
The platform uses React + Vite (frontend), Node.js + TypeScript + Express (backend), and PostgreSQL (database). This is fixed infrastructure. Never ask the user about technology, database schema, data models, UI component names, library choices, or implementation approach. If a user volunteers these details in a prior answer, extract only the product intent — ignore the technical specifics.

## Goal
Ask only the product/functional questions needed to define WHAT to build, for WHOM, and with WHAT content or workflows. Match the question style to the app class — do not assume the request is a marketing/portfolio site.

Good questions — pick the ones that fit the app class:
- Audience & purpose: who uses this and what is the primary outcome they need?
- Content sites (portfolio, landing, blog, business): what work/content/offerings should be showcased? What is the main call to action? What tone or style?
- Apps with user accounts (SaaS, dashboards, CRM, admin, social): what user roles exist (e.g. admin vs. regular user) and what can each role do?
- Data-driven apps: what are the main entities the user manages (e.g. orders, customers, posts, projects, bookings) and what actions can they take on each (create, edit, filter, export, share)?
- Transactional apps (e-commerce, booking, marketplace): what does the purchase / booking / submission flow look like end to end?
- Communication apps (chat, social, support): who can message whom, and what is the unit of conversation (DM, group, thread, comment)?
- Pages / sections / navigation: what major screens or sections does the app need?
- Integrations: are there external services the user expects to connect (payments, email, calendar, file storage, OAuth providers)? Only ask if the request implies one.

Bad questions (never ask these):
- What database, ORM, or schema should be used?
- What UI components, design system, or libraries should be used?
- What tech stack, framework, or hosting do you prefer?
- What API structure or endpoints are needed?
- What specific UI elements should be used to display X?

## Rules
- Ask 1 to 3 questions only when a product decision is genuinely missing and blocks design.
- Never repeat already asked or answered questions.
- If enough product detail exists to proceed, return confirmed=true with an empty questions array.
- Do not ask generic filler questions.

Canonical project spec (if present):
${JSON.stringify(projectSpec, null, 2)}

Return ONLY valid JSON with this exact shape:
{
  "questions": ["string"],
  "confirmed": boolean
}

- questions must be an array of 0 to 3 strings
- every question must be about product/content, not implementation
- if questions.length > 0 then confirmed must be false
- if confirmed is true then questions must be []
- no markdown, no prose`;
}

export async function clarificationAgent(input: any): Promise<StateAwareAgentResult<ClarificationOutput>> {
  debug('clarificationAgent', { input });
  if (!input?.requirements) throw new Error('Input with requirements required');

  const clarificationAnswers: Record<string, string> = input.clarificationAnswers || {};
  const askedQuestions: string[] = Array.isArray(input.askedQuestions) ? input.askedQuestions : [];
  const activeState = String(input.activeState || input.globalState?.activeState || AgentState.CLARIFICATION);
  const projectSpec = input.projectSpec || null;
  const context: ClarificationContext = {
    clarificationAnswers,
    askedQuestions,
    modification: input.modification,
    lastQuestion: input.lastQuestion,
    lastAnswer: input.lastAnswer,
  };

  if (![AgentState.CLARIFICATION, AgentState.REQUIREMENTS].includes(activeState as any)) {
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
      nextStateProposal: transitionTo(activeState, AgentState.NEXT_CLARIFICATION),
      consistencyScore: 0,
      output,
    };
  }

  const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('clarification');
  const llmProxy = new LLMProxyClient({ apiKey, projectId: input.projectId, fallbacks });
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
    askMoreQuestions: shouldAskMoreQuestions(input.requirements, projectSpec, askedQuestions, clarificationAnswers),
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
        400
      );

      const raw = completion.choices?.[0]?.message?.content || '{}';
      debug('LLM_RAW_CONTENT_CLARIFICATION', { raw });

      const parsed = parseJsonResponse(raw);
      const confirmed = Boolean(parsed?.confirmed);
      const questions = filterAskedQuestions(normalizeQuestionList(parsed?.questions), askedQuestions, clarificationAnswers);

      if (confirmed && questions.length > 0) {
        throw new Error('clarificationAgent: confirmed=true cannot include questions');
      }

      const semanticGap = calculateSemanticGap(input.requirements, projectSpec);
      const shouldContinue = shouldAskMoreQuestions(input.requirements, projectSpec, askedQuestions, clarificationAnswers);

      // Hard guardrail: if we still believe we need clarifications and the LLM
      // neither confirmed nor produced questions, force a retry.
      // But if the LLM explicitly confirmed, trust it — the user gave enough detail.
      if (shouldContinue && questions.length === 0 && !confirmed) {
        throw new Error('clarificationAgent:shouldContinue=true but LLM returned no questions');
      }

      const resolvedQuestions = shouldContinue ? questions : [];
      const resolvedConfirmed = resolvedQuestions.length === 0;

      const output: ClarificationOutput = {
        questions: resolvedQuestions,
        confirmed: resolvedConfirmed,
        done: resolvedConfirmed,
        context,
      };

      const nextStateProposal = resolvedConfirmed ? transitionTo(activeState, AgentState.NEXT_SYSTEM_DESIGN) : transitionTo(activeState, AgentState.NEXT_CLARIFICATION);

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
