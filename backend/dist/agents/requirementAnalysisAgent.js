"use strict";
// Requirement Analysis Agent
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirementAnalysisAgent = requirementAnalysisAgent;
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
const logger_1 = require("../utils/logger");
async function requirementAnalysisAgent(input) {
    (0, logger_1.debug)('requirementAnalysisAgent', { input });
    try {
        if (!input?.user_message)
            throw new Error('user_message required');
        const { model, apiKey } = (0, modelRouter_1.getModelConfigForTask)('core_reasoning');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({ apiKey });
        const systemPrompt = `You are an expert requirements analyst. The user may ask for any type of website, web application, or related feature. Your job is to convert that request into a robust website requirements object.
- If the user message is broad or vague, infer a reasonable website_type and pages set.
- If the user asks for a feature that is better suited to a web application, still map it to a web-based product.
- If the request is ambiguous, do not fail silently; choose a safe default and add a short note explaining your assumption.
Respond ONLY with valid JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref, notes.
Do NOT include any Markdown code block markers (no triple backticks or 'json'), just return raw JSON.`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input.user_message }
        ], model, 0.8, 0.9, 1000);
        (0, logger_1.debug)('requirementAnalysisAgent:completion', { completion });
        let content = completion.choices?.[0]?.message?.content || '{}';
        (0, logger_1.debug)('LLM_RAW_CONTENT_REQUIREMENT_ANALYSIS', { content });
        // Always remove all Markdown code block markers (handles ```json, ``` etc.)
        content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
        // Now extract the first JSON object
        const jsonMatch = content.match(/{[\s\S]*}/);
        if (!jsonMatch) {
            (0, logger_1.error)('requirementAnalysisAgent:no-json', { content });
            throw new Error('Malformed LLM output: No JSON object found');
        }
        let result;
        try {
            result = JSON.parse(jsonMatch[0]);
        }
        catch (e) {
            (0, logger_1.error)('requirementAnalysisAgent:parse-error', { e, content: jsonMatch[0] });
            throw new Error('Malformed LLM output: ' + jsonMatch[0]);
        }
        if (!result.website_type || !Array.isArray(result.pages)) {
            throw new Error('Malformed requirementAnalysisAgent output');
        }
        (0, logger_1.debug)('requirementAnalysisAgent:result', { result });
        return result;
    }
    catch (err) {
        (0, logger_1.error)('requirementAnalysisAgent', err);
        throw err;
    }
}
