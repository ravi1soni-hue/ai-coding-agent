"use strict";
// Requirement Analysis Agent
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirementAnalysisAgent = requirementAnalysisAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function requirementAnalysisAgent(input) {
    console.log('[requirementAnalysisAgent] called with:', input);
    try {
        if (!input?.user_message)
            throw new Error('user_message required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('core_reasoning');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        const systemPrompt = `Extract structured website requirements from the following user message. Respond ONLY in JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref.`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input.user_message }
        ], model, 0.8, 0.9, 1000);
        console.log('[requirementAnalysisAgent] LLM completion:', completion);
        const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
        if (!result.website_type || !Array.isArray(result.pages)) {
            throw new Error('Malformed requirementAnalysisAgent output');
        }
        console.log('[requirementAnalysisAgent] result:', result);
        return result;
    }
    catch (err) {
        console.error('[requirementAnalysisAgent] error:', err);
        throw err;
    }
}
