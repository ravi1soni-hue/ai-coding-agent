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
    GPT4O_MINI_MODEL_ID: process.env.GPT4O_MINI_MODEL_ID || '',
    GPT5_MINI_MODEL_ID: process.env.GPT5_MINI_MODEL_ID || '',
    GPT5_2_MODEL_ID: process.env.GPT5_2_MODEL_ID || '',
    GPT4O_MODEL_ID: process.env.GPT4O_MODEL_ID || '',
    EMBEDDING_MODEL_ID: process.env.EMBEDDING_MODEL_ID || '',
};
