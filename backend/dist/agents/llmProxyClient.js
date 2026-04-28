"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMProxyClient = void 0;
// LLM Proxy Client for Coforge
const axios_1 = __importDefault(require("axios"));
class LLMProxyClient {
    constructor(options) {
        this.apiKey = options.apiKey;
        this.url = options.url || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings';
    }
    async chatCompletion(messages, model) {
        // This is a placeholder. You may need to adjust the payload and endpoint for chat completion if your proxy supports it.
        const response = await axios_1.default.post(this.url.replace('embeddings', 'chat/completions'), {
            model,
            messages,
            response_format: { type: 'json_object' },
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': this.apiKey,
            },
        });
        if (response.status !== 200) {
            throw new Error(`LLM Proxy failed: ${response.status} ${JSON.stringify(response.data)}`);
        }
        return response.data;
    }
    async embedding(text) {
        const response = await axios_1.default.post(this.url, {
            texts: [text],
            dimensions: 736,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': this.apiKey,
            },
        });
        if (response.status !== 200) {
            throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(response.data)}`);
        }
        return response.data.embeddings.map(Number);
    }
}
exports.LLMProxyClient = LLMProxyClient;
