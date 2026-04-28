"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getModelConfigForTask = getModelConfigForTask;
// Model Router Utility
// Selects the correct model for each task based on your plan
const env_1 = require("../config/env");
function getModelConfigForTask(task) {
    switch (task) {
        case 'core_reasoning':
            return { model: env_1.config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini', apiKey: env_1.config.GPT4O_MINI_API_KEY };
        case 'code_generation':
            return { model: env_1.config.GPT5_MINI_MODEL_ID || 'gpt-5-mini', apiKey: env_1.config.GPT5_MINI_API_KEY };
        case 'agent_orchestration':
            return { model: env_1.config.GPT5_2_MODEL_ID || 'gpt-5-2', apiKey: env_1.config.GPT5_2_API_KEY };
        case 'clarification':
            return { model: env_1.config.GPT4O_MODEL_ID || 'gpt-4o', apiKey: env_1.config.GPT4O_API_KEY };
        case 'summary':
            return { model: env_1.config.GPT4O_MODEL_ID || 'gpt-4o', apiKey: env_1.config.GPT4O_API_KEY };
        case 'voice':
            return { model: env_1.config.GPT4O_MODEL_ID || 'gpt-4o', apiKey: env_1.config.GPT4O_API_KEY };
        case 'embedding':
            return { model: env_1.config.EMBEDDING_MODEL_ID || 'embedding-model', apiKey: env_1.config.EMBEDDING_API_KEY };
        default:
            return { model: env_1.config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini', apiKey: env_1.config.GPT4O_MINI_API_KEY };
    }
}
