"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMProxyClient = void 0;
// LLM Proxy Client for Coforge
const axios_1 = __importDefault(require("axios"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const util = require('util');
class LLMProxyClient {
    constructor(options) {
        this.apiKey = options.apiKey;
        this.chatUrl = options.chatUrl || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions';
        this.embeddingUrl = options.embeddingUrl || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings';
        this.log('LLMProxyClient initialized', { apiKey: !!this.apiKey, chatUrl: this.chatUrl, embeddingUrl: this.embeddingUrl });
    }
    log(message, data) {
        // Use util.inspect for deep objects
        console.log(`[LLMProxyClient] ${message}${data ? ': ' + util.inspect(data, { depth: 5 }) : ''}`);
    }
    async chatCompletion(messages, model, temperature = 0.8, top_p = 0.9, max_tokens = 1000) {
        this.log('chatCompletion called', { model, messages, temperature, top_p, max_tokens });
        try {
            const response = await axios_1.default.post(this.chatUrl, {
                model,
                messages,
                temperature,
                top_p,
                max_tokens,
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': this.apiKey,
                },
            });
            this.log('chatCompletion response', { status: response.status, data: response.data });
            if (response.status !== 200) {
                this.log('chatCompletion error', { status: response.status, data: response.data });
                throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${JSON.stringify(response.data)}`);
            }
            return response.data;
        }
        catch (err) {
            this.log('chatCompletion exception', err);
            throw err;
        }
    }
    async embedding(texts, dimensions = 746) {
        this.log('embedding called', { texts, dimensions });
        try {
            const response = await axios_1.default.post(this.embeddingUrl, {
                texts,
                dimensions,
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': this.apiKey,
                },
            });
            this.log('embedding response', { status: response.status, data: response.data });
            if (response.status !== 200) {
                this.log('embedding error', { status: response.status, data: response.data });
                throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(response.data)}`);
            }
            return response.data.embeddings.map((e) => Array.isArray(e) ? e.map(Number) : [Number(e)]);
        }
        catch (err) {
            this.log('embedding exception', err);
            throw err;
        }
    }
}
exports.LLMProxyClient = LLMProxyClient;
