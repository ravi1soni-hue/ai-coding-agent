// Model Router Utility
// Selects the correct model for each task based on your plan
import { config } from '../config/env';

export type TaskType =
  | 'core_reasoning'
  | 'code_generation'
  | 'agent_orchestration'
  | 'clarification'
  | 'summary'
  | 'voice'
  | 'embedding';

function pickConfiguredModel(...candidates: Array<string | undefined>): string {
  for (const value of candidates) {
    if (value && value.trim()) return value.trim();
  }
  return 'gpt-4o-mini';
}

function pickConfiguredApiKey(...candidates: Array<string | undefined>): string {
  for (const value of candidates) {
    if (value && value.trim() && value.trim().length >= 3) return value.trim();
  }
  // Return a fallback - LLM proxy will handle invalid keys gracefully
  // This prevents early failure and allows retry logic to work
  return process.env.OPENAI_API_KEY || '';
}

export function getModelConfigForTask(task: TaskType): { model: string; apiKey: string } {
  switch (task) {
    case 'core_reasoning':
      return {
        model: pickConfiguredModel(config.GPT4O_MINI_MODEL, config.GPT4O_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT4O_MINI_API_KEY, config.GPT4O_API_KEY, config.OPENAI_API_KEY),
      };
    case 'code_generation':
      return {
        // Prioritize gpt-4o for code generation (more reliable than gpt-5-mini)
        // Falls back: gpt-4o-mini if gpt-4o unavailable
        model: pickConfiguredModel(config.GPT4O_MODEL, config.GPT4O_MINI_MODEL, config.GPT5_MINI_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT4O_API_KEY, config.GPT4O_MINI_API_KEY, config.GPT5_MINI_API_KEY, config.OPENAI_API_KEY),
      };
    case 'agent_orchestration':
      return {
        model: pickConfiguredModel(config.GPT5_2_MODEL, config.GPT5_MINI_MODEL, config.GPT4O_MODEL, config.GPT4O_MINI_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT5_2_API_KEY, config.GPT5_MINI_API_KEY, config.GPT4O_API_KEY, config.GPT4O_MINI_API_KEY, config.OPENAI_API_KEY),
      };
    case 'clarification':
      return {
        model: pickConfiguredModel(config.GPT4O_MODEL, config.GPT4O_MINI_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT4O_API_KEY, config.GPT4O_MINI_API_KEY, config.OPENAI_API_KEY),
      };
    case 'summary':
      return {
        model: pickConfiguredModel(config.GPT4O_MODEL, config.GPT4O_MINI_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT4O_API_KEY, config.GPT4O_MINI_API_KEY, config.OPENAI_API_KEY),
      };
    case 'voice':
      return {
        model: pickConfiguredModel(config.GPT4O_MODEL, config.GPT4O_MINI_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT4O_API_KEY, config.GPT4O_MINI_API_KEY, config.OPENAI_API_KEY),
      };
    case 'embedding':
      return {
        model: pickConfiguredModel(config.EMBEDDING_MODEL),
        apiKey: pickConfiguredApiKey(config.EMBEDDING_API_KEY, config.OPENAI_API_KEY),
      };
    default:
      return {
        model: pickConfiguredModel(config.GPT4O_MINI_MODEL, config.GPT4O_MODEL),
        apiKey: pickConfiguredApiKey(config.GPT4O_MINI_API_KEY, config.GPT4O_API_KEY, config.OPENAI_API_KEY),
      };
  }
}
