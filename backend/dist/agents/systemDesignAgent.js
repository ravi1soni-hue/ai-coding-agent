"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemDesignAgent = systemDesignAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function systemDesignAgent(input) {
    console.log('[systemDesignAgent] called with:', input);
    try {
        if (!input)
            throw new Error('Input required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('core_reasoning');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], model, 0.8, 0.9, 1000);
        console.log('[systemDesignAgent] LLM completion:', completion);
        const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
        if (!result.frontend || !result.backend) {
            throw new Error('Malformed systemDesignAgent output');
        }
        console.log('[systemDesignAgent] result:', result);
        return result;
    }
    catch (err) {
        console.error('[systemDesignAgent] error:', err);
        throw err;
    }
}
