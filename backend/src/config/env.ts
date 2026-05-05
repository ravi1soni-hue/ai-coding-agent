import dotenv from 'dotenv';
dotenv.config();

export const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  REDIS_URL: process.env.REDIS_URL || '',
  POSTGRES_URL: process.env.POSTGRES_URL || '',
  DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  API_BASE_URL: process.env.API_BASE_URL || process.env.RAILWAY_PUBLIC_URL || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_SERVICE_URL || 'http://localhost:3000',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  RAILWAY_TOKEN: process.env.RAILWAY_TOKEN || '',
  RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID || '',
  RAILWAY_SERVICE_ID: process.env.RAILWAY_SERVICE_ID || '',
  RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID || '',
  RAILWAY_PUBLIC_URL: process.env.RAILWAY_PUBLIC_URL || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_SERVICE_URL || '',
  RAILWAY_GRAPHQL_URL: process.env.RAILWAY_GRAPHQL_URL || 'https://backboard.railway.app/graphql/v2',
  LLM_PROXY_CHAT_URL: process.env.LLM_PROXY_CHAT_URL || '',
  LLM_PROXY_EMBEDDING_URL: process.env.LLM_PROXY_EMBEDDING_URL || '',
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
  WS_ALLOWED_ORIGINS: process.env.WS_ALLOWED_ORIGINS || '',
  LIMITS: {
    maxRetriesPerStage: parseInt(process.env.MAX_RETRIES_PER_STAGE || '2', 10),
    maxLlmCallsPerProject: parseInt(process.env.MAX_LLM_CALLS_PER_PROJECT || '20', 10),
    maxBuildAttempts: parseInt(process.env.MAX_BUILD_ATTEMPTS || '2', 10),
  },
};
