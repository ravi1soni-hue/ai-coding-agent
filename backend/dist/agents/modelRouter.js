"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getModelIdForTask = getModelIdForTask;
// Model Router Utility
// Selects the correct model for each task based on your plan
const env_1 = require("../config/env");
function getModelIdForTask(task) {
    switch (task) {
        case 'core_reasoning':
            return env_1.config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini';
        case 'code_generation':
            return env_1.config.GPT5_MINI_MODEL_ID || 'gpt-5-mini';
        case 'agent_orchestration':
            return env_1.config.GPT5_2_MODEL_ID || 'gpt-5-2';
        case 'clarification':
            return env_1.config.GPT4O_MODEL_ID || 'gpt-4o';
        case 'summary':
            return env_1.config.GPT4O_MODEL_ID || 'gpt-4o';
        case 'voice':
            return env_1.config.GPT4O_MODEL_ID || 'gpt-4o';
        case 'embedding':
            return env_1.config.EMBEDDING_MODEL_ID || 'embedding-model';
        default:
            return env_1.config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini';
    }
}
