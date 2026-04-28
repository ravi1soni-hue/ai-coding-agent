"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemDesignAgent = systemDesignAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function systemDesignAgent(input) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('[systemDesignAgent] called with:', input);
    }
    try {
        if (!input)
            throw new Error('Input required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('core_reasoning');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], 'gpt-5-chat', 0.8, 0.9, 1000);
        if (process.env.NODE_ENV !== 'production') {
            console.log('[systemDesignAgent] LLM completion:', completion);
        }
        let content = completion.choices?.[0]?.message?.content || '{}';
        // Always remove all Markdown code block markers (handles ```json, ``` etc.)
        content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
        // Now extract the first JSON object
        const jsonMatch = content.match(/{[\s\S]*}/);
        if (!jsonMatch) {
            console.error('[systemDesignAgent] No JSON object found in LLM output:', { content });
            throw new Error('Malformed LLM output: No JSON object found');
        }
        let result;
        try {
            result = JSON.parse(jsonMatch[0]);
        }
        catch (e) {
            console.error('[systemDesignAgent] JSON parse error:', e, { content: jsonMatch[0] });
            throw new Error('Malformed LLM output: ' + jsonMatch[0]);
        }
        if (!result.frontend || !result.backend) {
            throw new Error('Malformed systemDesignAgent output');
        }
        if (process.env.NODE_ENV !== 'production') {
            console.log('[systemDesignAgent] result:', result);
        }
        return result;
    }
    catch (err) {
        console.error('[systemDesignAgent] error:', err);
        throw err;
    }
}
