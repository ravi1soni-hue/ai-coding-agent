"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingAgent = embeddingAgent;
// Embedding Agent using LLM Proxy
const env_1 = require("../config/env");
const llmProxyClient_1 = require("./llmProxyClient");
const llmProxy = new llmProxyClient_1.LLMProxyClient({
    apiKey: env_1.config.OPENAI_API_KEY,
    chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/chat/completions',
    embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v3/text/embeddings',
});
async function embeddingAgent(text) {
    console.log('[embeddingAgent] called with:', text);
    try {
        // The new embedding method expects an array of texts and returns an array of arrays
        const result = await llmProxy.embedding([text], 746);
        console.log('[embeddingAgent] embedding result:', result);
        return result[0];
    }
    catch (err) {
        console.error('[embeddingAgent] error:', err);
        throw err;
    }
}
