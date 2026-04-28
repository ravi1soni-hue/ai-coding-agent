"use strict";
// Requirement Analysis Agent
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirementAnalysisAgent = requirementAnalysisAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function requirementAnalysisAgent(input) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('[requirementAnalysisAgent] called with:', input);
    }
    try {
        if (!input?.user_message)
            throw new Error('user_message required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('core_reasoning');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        const systemPrompt = `Extract structured website requirements from the following user message. Respond ONLY in JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref.`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input.user_message }
        ], 'gpt-5-chat', 0.8, 0.9, 1000);
        if (process.env.NODE_ENV !== 'production') {
            console.log('[requirementAnalysisAgent] LLM completion:', completion);
        }
        let content = completion.choices?.[0]?.message?.content || '{}';
        // Log the raw LLM content with a fixed tag for debugging
        console.log('[LLM_RAW_CONTENT_REQUIREMENT_ANALYSIS]', content);
        // Remove all Markdown code block markers and trim
        content = content.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1').replace(/^```[a-zA-Z]*|```$/gm, '').trim();
        // Remove any leading/trailing quotes or whitespace
        content = content.replace(/^['"`\s]+|['"`\s]+$/g, '');
        let result;
        try {
            result = JSON.parse(content);
        }
        catch (e) {
            console.error('[requirementAnalysisAgent] JSON parse error:', e, { content });
            throw new Error('Malformed LLM output: ' + content);
        }
        if (!result.website_type || !Array.isArray(result.pages)) {
            throw new Error('Malformed requirementAnalysisAgent output');
        }
        if (process.env.NODE_ENV !== 'production') {
            console.log('[requirementAnalysisAgent] result:', result);
        }
        return result;
    }
    catch (err) {
        console.error('[requirementAnalysisAgent] error:', err);
        throw err;
    }
}
