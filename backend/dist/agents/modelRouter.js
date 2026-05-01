"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getModelConfigForTask = getModelConfigForTask;
// Model Router Utility
// Selects the correct model for each task based on your plan
const env_1 = require("../config/env");
function resolveModel(preferred, fallbackAlias) {
    if (preferred && preferred.trim())
        return preferred.trim();
    return fallbackAlias;
}
function getModelConfigForTask(task) {
    switch (task) {
        case 'core_reasoning':
            return {
                model: resolveModel(env_1.config.GPT4O_MINI_MODEL, 'gpt-4o-mini'),
                apiKey: env_1.config.GPT4O_MINI_API_KEY,
            };
        case 'code_generation':
            return {
                model: resolveModel(env_1.config.GPT5_MINI_MODEL, 'gpt-5-mini'),
                apiKey: env_1.config.GPT5_MINI_API_KEY,
            };
        case 'agent_orchestration':
            return {
                model: resolveModel(env_1.config.GPT5_2_MODEL, 'gpt-5-2'),
                apiKey: env_1.config.GPT5_2_API_KEY,
            };
        case 'clarification':
            return {
                model: resolveModel(env_1.config.GPT4O_MODEL, 'gpt-4o'),
                apiKey: env_1.config.GPT4O_API_KEY,
            };
        case 'summary':
            return {
                model: resolveModel(env_1.config.GPT4O_MODEL, 'gpt-4o'),
                apiKey: env_1.config.GPT4O_API_KEY,
            };
        case 'voice':
            return {
                model: resolveModel(env_1.config.GPT4O_MODEL, 'gpt-4o'),
                apiKey: env_1.config.GPT4O_API_KEY,
            };
        case 'embedding':
            return {
                model: resolveModel(env_1.config.EMBEDDING_MODEL, 'embedding-model'),
                apiKey: env_1.config.EMBEDDING_API_KEY,
            };
        default:
            return {
                model: resolveModel(env_1.config.GPT4O_MINI_MODEL, 'gpt-4o-mini'),
                apiKey: env_1.config.GPT4O_MINI_API_KEY,
            };
    }
}
