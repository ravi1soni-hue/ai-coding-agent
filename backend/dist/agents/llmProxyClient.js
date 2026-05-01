"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMProxyClient = void 0;
// LLM Proxy Client for Coforge
// Use fetch instead of axios for LLM proxy calls
// eslint-disable-next-line @typescript-eslint/no-var-requires
const util = require('util');
const env_1 = require("../config/env");
class LLMProxyClient {
    constructor(options) {
        this.apiKey = options.apiKey;
        this.chatUrl = options.chatUrl || env_1.config.LLM_PROXY_CHAT_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions';
        this.embeddingUrl = options.embeddingUrl || env_1.config.LLM_PROXY_EMBEDDING_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings';
        this.log('LLMProxyClient initialized', { apiKey: !!this.apiKey, chatUrl: this.chatUrl, embeddingUrl: this.embeddingUrl });
    }
    log(message, data) {
        // Use util.inspect for deep objects
        console.log(`[LLMProxyClient] ${message}${data ? ': ' + util.inspect(data, { depth: 5 }) : ''}`);
    }
    buildModelCandidates(primaryModel) {
        const candidates = [
            primaryModel,
            env_1.config.GPT4O_MINI_MODEL,
            env_1.config.GPT4O_MODEL,
            env_1.config.GPT5_MINI_MODEL,
            env_1.config.GPT5_2_MODEL,
            'gpt-4o-mini',
            'gpt-4o',
            'gpt-5-mini',
            'gpt-5-2',
        ].filter((m) => typeof m === 'string' && m.trim().length > 0);
        const seen = new Set();
        return candidates.filter((m) => {
            if (seen.has(m))
                return false;
            seen.add(m);
            return true;
        });
    }
    isModelNotFoundError(err) {
        const message = String(err?.message || '').toLowerCase();
        return message.includes('404') && message.includes('model not found');
    }
    async chatCompletion(messages, model, temperature = 0.8, top_p = 0.9, max_tokens = 1000) {
        const selectedModel = model || env_1.config.GPT4O_MINI_MODEL || 'gpt-4o-mini';
        const modelCandidates = this.buildModelCandidates(selectedModel);
        this.log('chatCompletion called', {
            model: selectedModel,
            modelCandidates,
            messages,
            temperature,
            top_p,
            max_tokens,
        });
        let lastError;
        for (let i = 0; i < modelCandidates.length; i += 1) {
            const modelCandidate = modelCandidates[i];
            try {
                const response = await fetch(this.chatUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-API-KEY': this.apiKey,
                    },
                    body: JSON.stringify({ model: modelCandidate, messages, temperature, top_p, max_tokens }),
                });
                const raw = await response.text();
                let data;
                try {
                    data = JSON.parse(raw);
                }
                catch (parseErr) {
                    const snippet = raw.replace(/\s+/g, ' ').slice(0, 1000);
                    this.log('chatCompletion invalid JSON response', {
                        status: response.status,
                        model: modelCandidate,
                        contentType: response.headers.get('content-type'),
                        raw: raw.slice(0, 1200),
                        snippet,
                        parseError: String(parseErr),
                    });
                    if (!response.ok) {
                        throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${snippet}`);
                    }
                    throw new Error(`LLM Proxy returned invalid JSON response: ${snippet}`);
                }
                this.log('chatCompletion response', { status: response.status, model: modelCandidate, data });
                if (!response.ok) {
                    this.log('chatCompletion error', { status: response.status, model: modelCandidate, data });
                    throw new Error(`LLM Proxy chatCompletion failed: ${response.status} ${JSON.stringify(data)}`);
                }
                if (modelCandidate !== selectedModel) {
                    this.log('chatCompletion recovered with fallback model', { selectedModel, fallbackModel: modelCandidate });
                }
                return data;
            }
            catch (err) {
                lastError = err;
                if (!this.isModelNotFoundError(err) || i === modelCandidates.length - 1) {
                    this.log('chatCompletion FETCH ERROR', err);
                    throw err;
                }
                this.log('chatCompletion retrying with next model candidate', {
                    failedModel: modelCandidate,
                    nextModel: modelCandidates[i + 1],
                    reason: err?.message,
                });
            }
        }
        // Defensive fallback, loop should have already returned or thrown.
        throw lastError || new Error('LLM Proxy chatCompletion failed without an explicit error.');
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
