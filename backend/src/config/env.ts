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
  LLM_PROXY_CHAT_URL: process.env.LLM_PROXY_CHAT_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
  LLM_PROXY_EMBEDDING_URL: process.env.LLM_PROXY_EMBEDDING_URL || 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',

  // ── Model names (sent as `model` in API request) ──────────────────────────
  GPT5_2_MODEL: process.env.GPT5_2_MODEL || '',
  GPT5_MINI_MODEL: process.env.GPT5_MINI_MODEL || '',
  GPT4O_MODEL: process.env.GPT4O_MODEL || '',
  GPT4O_MINI_MODEL: process.env.GPT4O_MINI_MODEL || '',
  CLAUDE4_MODEL: process.env.CLAUDE4_MODEL || '',
  KIMI_K2_MODEL: process.env.KIMI_K2_MODEL || '',
  GROK3_MODEL: process.env.GROK3_MODEL || '',
  DEEPSEEK_R1_MODEL: process.env.DEEPSEEK_R1_MODEL || '',
  GEMINI_FLASH_MODEL: process.env.GEMINI_FLASH_MODEL || '',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || '',

  // ── Per-model API keys issued by the LLM proxy ───────────────────────────
  GPT5_2_API_KEY: process.env.GPT5_2_API_KEY || '',
  GPT5_MINI_API_KEY: process.env.GPT5_MINI_API_KEY || '',
  GPT4O_API_KEY: process.env.GPT4O_API_KEY || '',
  GPT4O_MINI_API_KEY: process.env.GPT4O_MINI_API_KEY || '',
  CLAUDE4_API_KEY: process.env.CLAUDE4_API_KEY || '',
  KIMI_K2_API_KEY: process.env.KIMI_K2_API_KEY || '',
  GROK3_API_KEY: process.env.GROK3_API_KEY || '',
  DEEPSEEK_R1_API_KEY: process.env.DEEPSEEK_R1_API_KEY || '',
  GEMINI_FLASH_API_KEY: process.env.GEMINI_FLASH_API_KEY || '',
  EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || '',

  VERCEL_ACCESS_TOKEN: process.env.VERCEL_ACCESS_TOKEN || '',
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID || '',
  WS_ALLOWED_ORIGINS: process.env.WS_ALLOWED_ORIGINS || '',
  LIMITS: {
    maxRetriesPerStage: parseInt(process.env.MAX_RETRIES_PER_STAGE || '2', 10),
    maxBuildAttempts: parseInt(process.env.MAX_BUILD_ATTEMPTS || '2', 10),
    maxTokensPerProject: parseInt(process.env.MAX_TOKENS_PER_PROJECT || '1000000', 10),
    maxOrchestrationMs: parseInt(process.env.MAX_ORCHESTRATION_MS || '1200000', 10), // 20 minutes
  },
};

// Configuration validation
function validateConfig() {
  const errors: string[] = [];

  if (isNaN(config.PORT) || config.PORT <= 0 || config.PORT > 65535) {
    errors.push('PORT must be a valid number between 1 and 65535');
  }

  if (config.NODE_ENV === 'production' && !config.DATABASE_URL) {
    errors.push('DATABASE_URL is required in production');
  }

  if (config.NODE_ENV === 'production') {
    if (!config.RAILWAY_TOKEN) {
      errors.push('RAILWAY_TOKEN is required in production');
    }
    if (!config.VERCEL_ACCESS_TOKEN) {
      errors.push('VERCEL_ACCESS_TOKEN is required in production');
    }
    // Require at least one usable model API key in production
    const hasAnyModelKey = [
      config.GPT5_2_API_KEY, config.GPT5_MINI_API_KEY,
      config.GPT4O_API_KEY, config.GPT4O_MINI_API_KEY,
      config.CLAUDE4_API_KEY, config.KIMI_K2_API_KEY,
    ].some((k) => k.trim().length > 0);
    if (!hasAnyModelKey) {
      errors.push('At least one model API key is required in production (e.g. GPT5_2_API_KEY, CLAUDE4_API_KEY)');
    }
  }

  try {
    new URL(config.LLM_PROXY_CHAT_URL);
    new URL(config.LLM_PROXY_EMBEDDING_URL);
  } catch {
    errors.push('LLM_PROXY_CHAT_URL and LLM_PROXY_EMBEDDING_URL must be valid URLs');
  }

  if (config.LIMITS.maxRetriesPerStage < 0) {
    errors.push('MAX_RETRIES_PER_STAGE must be non-negative');
  }
  if (config.LIMITS.maxBuildAttempts < 1) {
    errors.push('MAX_BUILD_ATTEMPTS must be at least 1');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

validateConfig();
