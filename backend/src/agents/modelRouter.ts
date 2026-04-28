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

export function getModelConfigForTask(task: TaskType): { model: string; apiKey: string } {
  switch (task) {
    case 'core_reasoning':
      return { model: config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini', apiKey: config.GPT4O_MINI_API_KEY };
    case 'code_generation':
      return { model: config.GPT5_MINI_MODEL_ID || 'gpt-5-mini', apiKey: config.GPT5_MINI_API_KEY };
    case 'agent_orchestration':
      return { model: config.GPT5_2_MODEL_ID || 'gpt-5-2', apiKey: config.GPT5_2_API_KEY };
    case 'clarification':
      return { model: config.GPT4O_MODEL_ID || 'gpt-4o', apiKey: config.GPT4O_API_KEY };
    case 'summary':
      return { model: config.GPT4O_MODEL_ID || 'gpt-4o', apiKey: config.GPT4O_API_KEY };
    case 'voice':
      return { model: config.GPT4O_MODEL_ID || 'gpt-4o', apiKey: config.GPT4O_API_KEY };
    case 'embedding':
      return { model: config.EMBEDDING_MODEL_ID || 'embedding-model', apiKey: config.EMBEDDING_API_KEY };
    default:
      return { model: config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini', apiKey: config.GPT4O_MINI_API_KEY };
  }
}
