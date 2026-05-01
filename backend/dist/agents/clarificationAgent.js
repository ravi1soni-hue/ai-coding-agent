"use strict";
// Clarification Agent
Object.defineProperty(exports, "__esModule", { value: true });
exports.clarificationAgent = clarificationAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
/**
 * Step-by-step clarification agent: only one question at a time, context-aware, supports iterative modifications.
 * input: {
 *   requirements: object, // structured requirements
 *   clarificationAnswers?: Record<string, string>, // previous answers
 *   askedQuestions?: string[], // previously asked clarification questions
 *   lastQuestion?: string, // last question asked
 *   lastAnswer?: string, // last answer given
 *   modification?: string // if user is requesting a modification
 * }
 * returns: { question: string | null, confirmed: boolean, done: boolean, context: any }
 */
async function clarificationAgent(input) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('[clarificationAgent] called with:', input);
    }
    try {
        if (!input || !input.requirements)
            throw new Error('Input with requirements required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('clarification');
        const clarificationAnswers = input.clarificationAnswers || {};
        const askedQuestions = Array.isArray(input.askedQuestions) ? input.askedQuestions : [];
        const modification = input.modification;
        const lastQuestion = input.lastQuestion;
        const lastAnswer = input.lastAnswer;
        // Compose context for LLM
        let userPrompt = {
            requirements: input.requirements,
            clarificationAnswers,
            askedQuestions,
            modification,
            lastQuestion,
            lastAnswer
        };
        const systemPrompt = `You are a requirements clarification agent.
Ask ONLY one blocking clarification question at a time (no scope expansion, no lists).
Never repeat a question that is already present in askedQuestions or already answered in clarificationAnswers.
If all clarifications are resolved, set confirmed=true and question=null.
If user requests a modification, ask for only the next blocking clarification needed for that modification.
Respond ONLY in JSON: { question: string | null, confirmed: boolean }.`;
        const llmProxy = new llmProxyClient_1.LLMProxyClient({ apiKey });
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(userPrompt) }
        ], model, 0.8, 0.9, 1000);
        if (process.env.NODE_ENV !== 'production') {
            console.log('[clarificationAgent] LLM completion:', completion);
        }
        let content = completion.choices?.[0]?.message?.content || '{}';
        // Log the raw LLM content for debugging
        if (process.env.NODE_ENV !== 'production') {
            console.log('[LLM_RAW_CONTENT_CLARIFICATION]', content);
        }
        // Always remove all Markdown code block markers (handles ```json, ``` etc.)
        content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
        // Now extract the first JSON object
        const jsonMatch = content.match(/{[\s\S]*}/);
        if (!jsonMatch) {
            console.error('[clarificationAgent] No JSON object found in LLM output:', { content });
            throw new Error('Malformed LLM output: No JSON object found');
        }
        let result;
        try {
            result = JSON.parse(jsonMatch[0]);
        }
        catch (e) {
            console.error('[clarificationAgent] JSON parse error:', e, { content: jsonMatch[0] });
            throw new Error('Malformed LLM output: ' + jsonMatch[0]);
        }
        // Defensive: always return a single question or null, never a list
        if (!('question' in result) || !('confirmed' in result)) {
            throw new Error('Malformed clarificationAgent output');
        }
        // If question is null and confirmed, we're done
        return {
            question: result.question || null,
            confirmed: !!result.confirmed,
            done: !!result.confirmed && !result.question,
            context: {
                clarificationAnswers,
                askedQuestions,
                modification,
                lastQuestion,
                lastAnswer
            }
        };
    }
    catch (err) {
        console.error('[clarificationAgent] error:', err);
        throw err;
    }
}
