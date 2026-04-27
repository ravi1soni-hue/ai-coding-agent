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
    case 'code_generation':
      return config.GPT5_2_MODEL_ID;
    case 'agent_orchestration':
    case 'clarification':
    case 'summary':
      return config.GPT4O_MINI_MODEL_ID;
    case 'voice':
      return config.GPT4O_MODEL_ID;
    case 'embedding':
      return config.EMBEDDING_MODEL_ID;
    default:
      return config.GPT4O_MINI_MODEL_ID;
  }
}
