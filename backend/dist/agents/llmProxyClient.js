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
    shouldRetryStatus(status) {
        return status === 408 || status === 429 || status >= 500;
    }
    async sleep(ms) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
    buildModelCandidates(primaryModel) {
        const candidates = [
            primaryModel,
            env_1.config.GPT4O_MINI_MODEL,
            env_1.config.GPT4O_MODEL,
            env_1.config.GPT5_MINI_MODEL,
            env_1.config.GPT5_2_MODEL,
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
    formatHttpError(operation, status, statusText, detail) {
        const cleanDetail = String(detail || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (status >= 500) {
            return `LLM Proxy ${operation} is temporarily unavailable (${status} ${statusText || 'Server Error'}). Please try again.`;
        }
        if (!cleanDetail) {
            return `LLM Proxy ${operation} failed (${status} ${statusText || 'Request Error'}).`;
        }
        return `LLM Proxy ${operation} failed (${status}): ${cleanDetail.slice(0, 200)}`;
    }
    async chatCompletion(messages, model, temperature = 0.8, top_p = 0.9, max_tokens = 1000, timeoutMs) {
        const selectedModel = model || 'gpt-4o-mini';
        if (!this.apiKey || this.apiKey.trim().length < 3) {
            this.log('chatCompletion called without valid API key', { model: selectedModel, apiKeyLength: this.apiKey?.length || 0 });
            throw new Error(`LLM Proxy chatCompletion failed: No valid API key configured for model "${selectedModel}". Check your environment variables for API_KEY settings.`);
        }
        // Use provided timeout or reasonable defaults based on max_tokens
        const defaultTimeout = Math.max(90000, Math.min(300000, max_tokens * 30));
        const requestTimeoutMs = timeoutMs || defaultTimeout;
        const modelCandidates = this.buildModelCandidates(selectedModel);
        this.log('chatCompletion called', {
            model: selectedModel,
            modelCandidates,
            messageCount: messages.length,
            temperature,
            top_p,
            max_tokens,
            timeoutMs: requestTimeoutMs,
        });
        let lastError;
        for (let i = 0; i < modelCandidates.length; i += 1) {
            const modelCandidate = modelCandidates[i];
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
                    const requestPayload = { model: modelCandidate, messages, temperature, top_p, max_tokens };
                    this.log('chatCompletion making request', {
                        attempt: attempt + 1,
                        modelCandidate,
                        selectedModel,
                        chatUrl: this.chatUrl,
                        messageCount: messages.length,
                        apiKeyLength: this.apiKey?.length || 0,
                        timeoutMs: requestTimeoutMs,
                    });
                    const response = await fetch(this.chatUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-API-KEY': this.apiKey,
                        },
                        body: JSON.stringify(requestPayload),
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);
                    const raw = await response.text();
                    let data;
                    try {
                        data = JSON.parse(raw);
                    }
                    catch (parseErr) {
                        const snippet = raw.replace(/\s+/g, ' ').slice(0, 240);
                        const isHtml = raw.trim().toLowerCase().startsWith('<');
                        this.log('chatCompletion invalid JSON response', {
                            status: response.status,
                            statusText: response.statusText,
                            model: modelCandidate,
                            contentType: response.headers.get('content-type'),
                            isHtmlResponse: isHtml,
                            raw: raw.slice(0, 800),
                            snippet,
                            parseError: String(parseErr),
                            chatUrl: this.chatUrl,
                            apiKeyLength: this.apiKey?.length || 0,
                        });
                        if (!response.ok || isHtml) {
                            const urlHint = isHtml ? ` (Check LLM_PROXY_CHAT_URL: ${this.chatUrl})` : '';
                            const authHint = response.status === 401 || response.status === 403 ? ' (Authentication may have failed)' : '';
                            if (this.shouldRetryStatus(response.status) && attempt < 2) {
                                await this.sleep(750 * (attempt + 1));
                                continue;
                            }
                            throw new Error(`LLM Proxy chatCompletion returned HTML (${response.status} ${response.statusText})${authHint}${urlHint}. ${snippet}`);
                        }
                        throw new Error(`LLM Proxy returned invalid JSON response: ${snippet}`);
                    }
                    this.log('chatCompletion response', { status: response.status, model: modelCandidate, data });
                    if (!response.ok) {
                        this.log('chatCompletion error', { status: response.status, model: modelCandidate, data });
                        if (this.shouldRetryStatus(response.status) && attempt < 2) {
                            await this.sleep(750 * (attempt + 1));
                            continue;
                        }
                        throw new Error(this.formatHttpError('chatCompletion', response.status, response.statusText, data?.error?.message || data?.message || JSON.stringify(data).slice(0, 240)));
                    }
                    if (modelCandidate !== selectedModel) {
                        this.log('chatCompletion recovered with fallback model', { selectedModel, fallbackModel: modelCandidate });
                    }
                    return data;
                }
                catch (err) {
                    lastError = err;
                    const retryableNetworkErr = err?.name === 'AbortError' || /network|timeout|fetch failed/i.test(String(err?.message || ''));
                    if (retryableNetworkErr && attempt < 2) {
                        this.log('chatCompletion retrying same model after network error', { modelCandidate, attempt, reason: err?.message });
                        await this.sleep(750 * (attempt + 1));
                        continue;
                    }
                    if (this.isModelNotFoundError(err) && i < modelCandidates.length - 1) {
                        this.log('chatCompletion retrying with next model candidate', {
                            failedModel: modelCandidate,
                            nextModel: modelCandidates[i + 1],
                            reason: err?.message,
                        });
                        break;
                    }
                    this.log('chatCompletion FETCH ERROR', err);
                    throw err;
                }
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
