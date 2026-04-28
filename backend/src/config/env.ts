import dotenv from 'dotenv';
dotenv.config();

export const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  REDIS_URL: process.env.REDIS_URL || '',
  POSTGRES_URL: process.env.POSTGRES_URL || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  RAILWAY_TOKEN: process.env.RAILWAY_TOKEN || '',
  GPT4O_MINI_MODEL_ID: process.env.GPT4O_MINI_MODEL_ID || '',
  GPT4O_MINI_API_KEY: process.env.GPT4O_MINI_API_KEY || process.env.OPENAI_API_KEY || '',
  GPT5_MINI_MODEL_ID: process.env.GPT5_MINI_MODEL_ID || '',
  GPT5_MINI_API_KEY: process.env.GPT5_MINI_API_KEY || process.env.OPENAI_API_KEY || '',
  GPT5_2_MODEL_ID: process.env.GPT5_2_MODEL_ID || '',
  GPT5_2_API_KEY: process.env.GPT5_2_API_KEY || process.env.OPENAI_API_KEY || '',
  GPT4O_MODEL_ID: process.env.GPT4O_MODEL_ID || '',
  GPT4O_API_KEY: process.env.GPT4O_API_KEY || process.env.OPENAI_API_KEY || '',
  EMBEDDING_MODEL_ID: process.env.EMBEDDING_MODEL_ID || '',
  EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
};
