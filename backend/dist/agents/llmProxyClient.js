"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMProxyClient = void 0;
// LLM Proxy Client for Coforge
// Use fetch instead of axios for LLM proxy calls
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
    async chatCompletion(messages, _model, temperature = 0.8, top_p = 0.9, max_tokens = 1000) {
        // Force model to 'gpt-5-chat' for compatibility with working project
        const model = 'gpt-5-chat';
        this.log('chatCompletion called', { model, messages, temperature, top_p, max_tokens });
        try {
            const response = await fetch(this.chatUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': this.apiKey,
                },
                body: JSON.stringify({ model, messages, temperature, top_p, max_tokens }),
            });
            const data = await response.json();
            this.log('chatCompletion response', { status: response.status, data });
            if (!response.ok) {
                this.log('chatCompletion error', { status: response.status, data });
                throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${JSON.stringify(data)}`);
            }
            return data;
        }
        catch (err) {
            this.log('chatCompletion FETCH ERROR', err);
            throw err;
        }
    }
    async embedding(texts, dimensions = 746) {
        this.log('embedding called', { texts, dimensions });
        try {
            const response = await fetch(this.embeddingUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': this.apiKey,
                },
                body: JSON.stringify({ texts, dimensions }),
            });
            const data = await response.json();
            this.log('embedding response', { status: response.status, data });
            if (!response.ok) {
                this.log('embedding error', { status: response.status, data });
                throw new Error(`LLM Proxy embedding failed: ${response.status} ${JSON.stringify(data)}`);
            }
            return data.embeddings.map((e) => Array.isArray(e) ? e.map(Number) : [Number(e)]);
        }
        catch (err) {
            this.log('embedding exception', err);
            throw err;
        }
    }
}
exports.LLMProxyClient = LLMProxyClient;
