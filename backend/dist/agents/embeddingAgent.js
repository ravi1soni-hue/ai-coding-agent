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
const EMBEDDING_MODEL_NAME = env_1.config.EMBEDDING_MODEL_ID || 'text-embeddings';
async function embeddingAgent(text) {
    return llmProxy.embedding(text, EMBEDDING_MODEL_NAME);
}
