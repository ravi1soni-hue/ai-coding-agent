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

function resolveModel(preferred: string, fallbackAlias: string): string {
  if (preferred && preferred.trim()) return preferred.trim();
  return fallbackAlias;
}

export function getModelConfigForTask(task: TaskType): { model: string; apiKey: string } {
  switch (task) {
    case 'core_reasoning':
      return {
        model: resolveModel(config.GPT4O_MINI_MODEL, 'gpt-4o-mini'),
        apiKey: config.GPT4O_MINI_API_KEY,
      };
    case 'code_generation':
      return {
        model: resolveModel(config.GPT5_MINI_MODEL, 'gpt-5-mini'),
        apiKey: config.GPT5_MINI_API_KEY,
      };
    case 'agent_orchestration':
      return {
        model: resolveModel(config.GPT5_2_MODEL, 'gpt-5-2'),
        apiKey: config.GPT5_2_API_KEY,
      };
    case 'clarification':
      return {
        model: resolveModel(config.GPT4O_MODEL, 'gpt-4o'),
        apiKey: config.GPT4O_API_KEY,
      };
    case 'summary':
      return {
        model: resolveModel(config.GPT4O_MODEL, 'gpt-4o'),
        apiKey: config.GPT4O_API_KEY,
      };
    case 'voice':
      return {
        model: resolveModel(config.GPT4O_MODEL, 'gpt-4o'),
        apiKey: config.GPT4O_API_KEY,
      };
    case 'embedding':
      return {
        model: resolveModel(config.EMBEDDING_MODEL, 'embedding-model'),
        apiKey: config.EMBEDDING_API_KEY,
      };
    default:
      return {
        model: resolveModel(config.GPT4O_MINI_MODEL, 'gpt-4o-mini'),
        apiKey: config.GPT4O_MINI_API_KEY,
      };
  }
}
