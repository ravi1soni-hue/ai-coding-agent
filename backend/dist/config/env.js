"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.config = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
    REDIS_URL: process.env.REDIS_URL || '',
    POSTGRES_URL: process.env.POSTGRES_URL || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    RAILWAY_TOKEN: process.env.RAILWAY_TOKEN || '',
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID || '',
    RAILWAY_SERVICE_ID: process.env.RAILWAY_SERVICE_ID || '',
    RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID || '',
    RAILWAY_PUBLIC_URL: process.env.RAILWAY_PUBLIC_URL || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_SERVICE_URL || '',
    RAILWAY_GRAPHQL_URL: process.env.RAILWAY_GRAPHQL_URL || 'https://backboard.railway.app/graphql/v2',
    LLM_PROXY_CHAT_URL: process.env.LLM_PROXY_CHAT_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
    LLM_PROXY_EMBEDDING_URL: process.env.LLM_PROXY_EMBEDDING_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
    // Model aliases/slugs used as the request `model` value.
    GPT4O_MINI_MODEL: process.env.GPT4O_MINI_MODEL || '',
    GPT5_MINI_MODEL: process.env.GPT5_MINI_MODEL || '',
    GPT5_2_MODEL: process.env.GPT5_2_MODEL || '',
    GPT4O_MODEL: process.env.GPT4O_MODEL || '',
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || '',
    // Legacy variables named *_MODEL_ID are treated as API keys for backward compatibility.
    // This project's provider can issue per-model API keys that were historically stored in those fields.
    GPT4O_MINI_MODEL_ID: process.env.GPT4O_MINI_MODEL_ID || '',
    GPT4O_MINI_API_KEY: process.env.GPT4O_MINI_API_KEY || process.env.GPT4O_MINI_MODEL_ID || process.env.OPENAI_API_KEY || '',
    GPT5_MINI_MODEL_ID: process.env.GPT5_MINI_MODEL_ID || '',
    GPT5_MINI_API_KEY: process.env.GPT5_MINI_API_KEY || process.env.GPT5_MINI_MODEL_ID || process.env.OPENAI_API_KEY || '',
    GPT5_2_MODEL_ID: process.env.GPT5_2_MODEL_ID || '',
    GPT5_2_API_KEY: process.env.GPT5_2_API_KEY || process.env.GPT5_2_MODEL_ID || process.env.OPENAI_API_KEY || '',
    GPT4O_MODEL_ID: process.env.GPT4O_MODEL_ID || '',
    GPT4O_API_KEY: process.env.GPT4O_API_KEY || process.env.GPT4O_MODEL_ID || process.env.OPENAI_API_KEY || '',
    EMBEDDING_MODEL_ID: process.env.EMBEDDING_MODEL_ID || '',
    EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || process.env.EMBEDDING_MODEL_ID || process.env.OPENAI_API_KEY || '',
    VERCEL_ACCESS_TOKEN: process.env.VERCEL_ACCESS_TOKEN || '',
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || '',
};
