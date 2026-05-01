"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingAgent = embeddingAgent;
// Embedding Agent using LLM Proxy
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
const logger_1 = require("../utils/logger");
async function embeddingAgent(text) {
    (0, logger_1.debug)('embeddingAgent', { textLength: text.length });
    try {
        const { apiKey } = (0, modelRouter_1.getModelConfigForTask)('embedding');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({ apiKey });
        // The new embedding method expects an array of texts and returns an array of arrays
        const result = await llmProxy.embedding([text], 746);
        (0, logger_1.debug)('embeddingAgent:result', { dimensions: result[0]?.length });
        return result[0];
    }
    catch (err) {
        (0, logger_1.error)('embeddingAgent', err);
        throw err;
    }
}
