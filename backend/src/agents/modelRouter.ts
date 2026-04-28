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

export function getModelIdForTask(task: TaskType): string {
  switch (task) {
    case 'core_reasoning':
      return config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini';
    case 'code_generation':
      return config.GPT5_MINI_MODEL_ID || 'gpt-5-mini';
    case 'agent_orchestration':
      return config.GPT5_2_MODEL_ID || 'gpt-5-2';
    case 'clarification':
      return config.GPT4O_MODEL_ID || 'gpt-4o';
    case 'summary':
      return config.GPT4O_MODEL_ID || 'gpt-4o';
    case 'voice':
      return config.GPT4O_MODEL_ID || 'gpt-4o';
    case 'embedding':
      return config.EMBEDDING_MODEL_ID || 'embedding-model';
    default:
      return config.GPT4O_MINI_MODEL_ID || 'gpt-4o-mini';
  }
}
