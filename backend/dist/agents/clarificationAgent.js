"use strict";
// Clarification Agent (stub)
Object.defineProperty(exports, "__esModule", { value: true });
exports.clarificationAgent = clarificationAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function clarificationAgent(input) {
    console.log('[clarificationAgent] called with:', input);
    try {
        if (!input)
            throw new Error('Input required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('clarification');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        const systemPrompt = `Given the following structured requirements, ask ONLY blocking clarification questions (no scope expansion). Respond ONLY in JSON: { questions: string[], confirmed: boolean }.`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], model, 0.8, 0.9, 1000);
        console.log('[clarificationAgent] LLM completion:', completion);
        const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
        if (!('questions' in result) || !('confirmed' in result)) {
            throw new Error('Malformed clarificationAgent output');
        }
        console.log('[clarificationAgent] result:', result);
        return result;
    }
    catch (err) {
        console.error('[clarificationAgent] error:', err);
        throw err;
    }
}
