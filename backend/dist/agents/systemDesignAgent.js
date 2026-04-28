"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemDesignAgent = systemDesignAgent;
const modelRouter_1 = require("./modelRouter");
const env_1 = require("../config/env");
const llmProxyClient_1 = require("./llmProxyClient");
const llmProxy = new llmProxyClient_1.LLMProxyClient({ apiKey: env_1.config.OPENAI_API_KEY });
async function systemDesignAgent(input) {
    try {
        if (!input)
            throw new Error('Input required');
        const modelId = (0, modelRouter_1.getModelIdForTask)('core_reasoning');
        const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
        const completion = await llmProxy.chatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ], modelId);
        const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
        if (!result.frontend || !result.backend) {
            throw new Error('Malformed systemDesignAgent output');
        }
        return result;
    }
    catch (err) {
        throw err;
    }
}
