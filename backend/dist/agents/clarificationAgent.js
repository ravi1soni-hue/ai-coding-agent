"use strict";
// Clarification Agent (stub)
Object.defineProperty(exports, "__esModule", { value: true });
exports.clarificationAgent = clarificationAgent;
const modelRouter_1 = require("./modelRouter");
const env_1 = require("../config/env");
const llmProxyClient_1 = require("./llmProxyClient");
const llmProxy = new llmProxyClient_1.LLMProxyClient({
    apiKey: env_1.config.OPENAI_API_KEY,
    chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
    embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
});
async function clarificationAgent(input) {
    try {
        if (!input)
            throw new Error('Input required');
        const modelId = (0, modelRouter_1.getModelIdForTask)('clarification');
        const systemPrompt = `Given the following structured requirements, ask ONLY blocking clarification questions (no scope expansion). Respond ONLY in JSON: { questions: string[], confirmed: boolean }.`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], modelId);
        const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
        if (!('questions' in result) || !('confirmed' in result)) {
            throw new Error('Malformed clarificationAgent output');
        }
        return result;
    }
    catch (err) {
        throw err;
    }
}
