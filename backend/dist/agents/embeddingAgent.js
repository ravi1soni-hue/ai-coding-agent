"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingAgent = embeddingAgent;
// Embedding Agent using LLM Proxy
const env_1 = require("../config/env");
const llmProxyClient_1 = require("./llmProxyClient");
const llmProxy = new llmProxyClient_1.LLMProxyClient({ apiKey: env_1.config.OPENAI_API_KEY });
async function embeddingAgent(text) {
    return llmProxy.embedding(text);
}
