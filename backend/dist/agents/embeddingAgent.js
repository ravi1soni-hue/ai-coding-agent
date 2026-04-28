"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingAgent = embeddingAgent;
// Embedding Agent using LLM Proxy
const modelRouter_1 = require("./modelRouter");
const llmProxyClient_1 = require("./llmProxyClient");
async function embeddingAgent(text) {
    if (process.env.NODE_ENV !== 'production') {
        console.log('[embeddingAgent] called with:', text);
    }
    try {
        const { apiKey } = (0, modelRouter_1.getModelConfigForTask)('embedding');
        const llmProxy = new llmProxyClient_1.LLMProxyClient({
            apiKey,
            chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
            embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
        });
        // The new embedding method expects an array of texts and returns an array of arrays
        const result = await llmProxy.embedding([text], 746);
        if (process.env.NODE_ENV !== 'production') {
            console.log('[embeddingAgent] embedding result:', result);
        }
        return result[0];
    }
    catch (err) {
        console.error('[embeddingAgent] error:', err);
        throw err;
    }
}
