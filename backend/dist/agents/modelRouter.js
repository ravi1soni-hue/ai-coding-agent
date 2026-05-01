"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getModelConfigForTask = getModelConfigForTask;
// Model Router Utility
// Selects the correct model for each task based on your plan
const env_1 = require("../config/env");
function pickConfiguredModel(...candidates) {
    for (const value of candidates) {
        if (value && value.trim())
            return value.trim();
    }
    return 'gpt-4o-mini';
}
function pickConfiguredApiKey(...candidates) {
    for (const value of candidates) {
        if (value && value.trim() && value.trim().length >= 3)
            return value.trim();
    }
    // Return a fallback - LLM proxy will handle invalid keys gracefully
    // This prevents early failure and allows retry logic to work
    return process.env.OPENAI_API_KEY || '';
}
function getModelConfigForTask(task) {
    switch (task) {
        case 'core_reasoning':
            return {
                model: pickConfiguredModel(env_1.config.GPT4O_MINI_MODEL, env_1.config.GPT4O_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT4O_MINI_API_KEY, env_1.config.GPT4O_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        case 'code_generation':
            return {
                // Prioritize gpt-4o for code generation (more reliable than gpt-5-mini)
                // Falls back: gpt-4o-mini if gpt-4o unavailable
                model: pickConfiguredModel(env_1.config.GPT4O_MODEL, env_1.config.GPT4O_MINI_MODEL, env_1.config.GPT5_MINI_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT4O_API_KEY, env_1.config.GPT4O_MINI_API_KEY, env_1.config.GPT5_MINI_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        case 'agent_orchestration':
            return {
                model: pickConfiguredModel(env_1.config.GPT5_2_MODEL, env_1.config.GPT5_MINI_MODEL, env_1.config.GPT4O_MODEL, env_1.config.GPT4O_MINI_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT5_2_API_KEY, env_1.config.GPT5_MINI_API_KEY, env_1.config.GPT4O_API_KEY, env_1.config.GPT4O_MINI_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        case 'clarification':
            return {
                model: pickConfiguredModel(env_1.config.GPT4O_MODEL, env_1.config.GPT4O_MINI_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT4O_API_KEY, env_1.config.GPT4O_MINI_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        case 'summary':
            return {
                model: pickConfiguredModel(env_1.config.GPT4O_MODEL, env_1.config.GPT4O_MINI_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT4O_API_KEY, env_1.config.GPT4O_MINI_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        case 'voice':
            return {
                model: pickConfiguredModel(env_1.config.GPT4O_MODEL, env_1.config.GPT4O_MINI_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT4O_API_KEY, env_1.config.GPT4O_MINI_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        case 'embedding':
            return {
                model: pickConfiguredModel(env_1.config.EMBEDDING_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.EMBEDDING_API_KEY, env_1.config.OPENAI_API_KEY),
            };
        default:
            return {
                model: pickConfiguredModel(env_1.config.GPT4O_MINI_MODEL, env_1.config.GPT4O_MODEL),
                apiKey: pickConfiguredApiKey(env_1.config.GPT4O_MINI_API_KEY, env_1.config.GPT4O_API_KEY, env_1.config.OPENAI_API_KEY),
            };
    }
}
