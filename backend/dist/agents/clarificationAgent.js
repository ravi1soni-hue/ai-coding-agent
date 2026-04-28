"use strict";
// Clarification Agent (stub)
Object.defineProperty(exports, "__esModule", { value: true });
exports.clarificationAgent = clarificationAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function clarificationAgent(input) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('[clarificationAgent] called with:', input);
    }
    try {
        if (!input)
            throw new Error('Input required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('clarification');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        const systemPrompt = `Given the following structured requirements, ask ONLY blocking clarification questions (no scope expansion). Respond ONLY in JSON: { questions: string[], confirmed: boolean }.`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], 'gpt-5-chat', 0.8, 0.9, 1000);
        if (process.env.NODE_ENV !== 'production') {
            console.log('[clarificationAgent] LLM completion:', completion);
        }
        let content = completion.choices?.[0]?.message?.content || '{}';
        // Remove all Markdown code block markers and trim
        content = content.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1').replace(/^```[a-zA-Z]*|```$/gm, '').trim();
        // Remove any leading/trailing quotes or whitespace
        content = content.replace(/^['"`\s]+|['"`\s]+$/g, '');
        let result;
        try {
            result = JSON.parse(content);
        }
        catch (e) {
            console.error('[clarificationAgent] JSON parse error:', e, { content });
            throw new Error('Malformed LLM output: ' + content);
        }
        if (!('questions' in result) || !('confirmed' in result)) {
            throw new Error('Malformed clarificationAgent output');
        }
        if (process.env.NODE_ENV !== 'production') {
            console.log('[clarificationAgent] result:', result);
        }
        return result;
    }
    catch (err) {
        console.error('[clarificationAgent] error:', err);
        throw err;
    }
}
