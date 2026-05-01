"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemDesignAgent = systemDesignAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
const logger_1 = require("../utils/logger");
async function systemDesignAgent(input) {
    (0, logger_1.debug)('systemDesignAgent', { input });
    try {
        if (!input)
            throw new Error('Input required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('core_reasoning');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({ apiKey });
        const systemPrompt = `Given the requirements, decide the full technical architecture.
  Respond ONLY in JSON with this shape: { frontend, backend, database, auth, hosting: { frontend, backend } }.
  If requirements.backend_required is false, set backend and database to null.
  If requirements.auth_required is false, set auth to null.
  Always include frontend and hosting fields.
  HARD RULE: Always use "vercel" for hosting.frontend and "railway" for hosting.backend (if backend exists).`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], model, 0.8, 0.9, 1000);
        (0, logger_1.debug)('systemDesignAgent:completion', { completion });
        let content = completion.choices?.[0]?.message?.content || '{}';
        (0, logger_1.debug)('LLM_RAW_CONTENT_SYSTEM_DESIGN', { content });
        // Always remove all Markdown code block markers (handles ```json, ``` etc.)
        content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
        // Now extract the first JSON object
        const jsonMatch = content.match(/{[\s\S]*}/);
        if (!jsonMatch) {
            (0, logger_1.error)('systemDesignAgent:no-json', { content });
            throw new Error('Malformed LLM output: No JSON object found');
        }
        let result;
        try {
            result = JSON.parse(jsonMatch[0]);
        }
        catch (e) {
            (0, logger_1.error)('systemDesignAgent:parse-error', { e, content: jsonMatch[0] });
            throw new Error('Malformed LLM output: ' + jsonMatch[0]);
        }
        if (!result || typeof result !== 'object' || !result.frontend) {
            throw new Error('Malformed systemDesignAgent output');
        }
        const backendRequired = Boolean(input?.backend_required);
        const authRequired = Boolean(input?.auth_required);
        // Normalize optional sections for frontend-only projects.
        if (!backendRequired) {
            if (typeof result.backend === 'undefined')
                result.backend = null;
            if (typeof result.database === 'undefined')
                result.database = null;
        }
        if (!authRequired && typeof result.auth === 'undefined') {
            result.auth = null;
        }
        if (backendRequired && !result.backend) {
            throw new Error('Malformed systemDesignAgent output');
        }
        if (authRequired && !result.auth) {
            throw new Error('Malformed systemDesignAgent output');
        }
        if (!result.hosting || typeof result.hosting !== 'object') {
            result.hosting = {
                frontend: 'vercel',
                backend: backendRequired ? 'railway' : null,
            };
        }
        (0, logger_1.debug)('systemDesignAgent:result', { result });
        return result;
    }
    catch (err) {
        (0, logger_1.error)('systemDesignAgent', err);
        throw err;
    }
}
