// Model Router — maps each agent task to the correct model + API key priority.
// Priority order matches the multi-agent spec exactly.
import { config } from '../config/env';

export type TaskType =
  | 'requirement_analysis'  // RequirementAnalysisAgent: KIMI_K2 > CLAUDE4 > GPT5_MINI
  | 'clarification'         // ClarificationAgent:        GPT4O_MINI > GEMINI_FLASH
  | 'system_design'         // SystemDesignAgent:         CLAUDE4 > GPT5_2 > KIMI_K2
  | 'ui_spec'               // UiSpecAgent:               GPT5_2 > CLAUDE4 > GPT4O
  | 'code_generation'       // CodeGenerationAgent:       GPT5_2 > GROK3 > GPT5_MINI > DEEPSEEK_R1
  | 'test_generation'       // TestGenerationAgent:       GPT5_MINI > DEEPSEEK_R1
  | 'code_review'           // CodeReviewAgent (RESERVED — chain defined, no agent file yet): CLAUDE4 > GPT5_2
  | 'embedding'             // EmbeddingAgent:            EMBEDDING
  | 'orchestration';        // Orchestrator:              GPT5_2 > KIMI_K2

export interface ModelConfig {
  model: string;
  apiKey: string;
}

/** Build a deduped, non-empty list of {model, apiKey} pairs from parallel arrays. */
function buildChain(models: Array<string | undefined>, keys: Array<string | undefined>): ModelConfig[] {
  const seen = new Set<string>();
  const chain: ModelConfig[] = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i]?.trim();
    const apiKey = keys[i]?.trim();
    if (!model || !apiKey || apiKey.length < 3) continue;
    if (seen.has(model)) continue;
    seen.add(model);
    chain.push({ model, apiKey });
  }
  return chain;
}

/**
 * Returns the full ordered priority chain of {model, apiKey} pairs for a task.
 * Each entry has its own correct API key — safe to iterate in sequence as fallbacks.
 * Empty entries (unconfigured env vars) are automatically skipped.
 */
export function getModelPriorityChain(task: TaskType): ModelConfig[] {
  switch (task) {
    case 'requirement_analysis':
      return buildChain(
        [config.KIMI_K2_MODEL,    config.CLAUDE4_MODEL,    config.GPT5_MINI_MODEL],
        [config.KIMI_K2_API_KEY,  config.CLAUDE4_API_KEY,  config.GPT5_MINI_API_KEY],
      );

    case 'clarification':
      return buildChain(
        [config.GPT4O_MINI_MODEL,    config.GEMINI_FLASH_MODEL],
        [config.GPT4O_MINI_API_KEY,  config.GEMINI_FLASH_API_KEY],
      );

    case 'system_design':
      return buildChain(
        [config.CLAUDE4_MODEL,    config.GPT5_2_MODEL,    config.KIMI_K2_MODEL],
        [config.CLAUDE4_API_KEY,  config.GPT5_2_API_KEY,  config.KIMI_K2_API_KEY],
      );

    case 'ui_spec':
      return buildChain(
        [config.GPT5_2_MODEL,    config.CLAUDE4_MODEL,    config.GPT4O_MODEL],
        [config.GPT5_2_API_KEY,  config.CLAUDE4_API_KEY,  config.GPT4O_API_KEY],
      );

    case 'code_generation':
      return buildChain(
        [config.GPT5_2_MODEL,    config.GROK3_MODEL,    config.GPT5_MINI_MODEL,    config.DEEPSEEK_R1_MODEL],
        [config.GPT5_2_API_KEY,  config.GROK3_API_KEY,  config.GPT5_MINI_API_KEY,  config.DEEPSEEK_R1_API_KEY],
      );

    case 'test_generation':
      return buildChain(
        [config.GPT5_MINI_MODEL,    config.DEEPSEEK_R1_MODEL],
        [config.GPT5_MINI_API_KEY,  config.DEEPSEEK_R1_API_KEY],
      );

    case 'code_review':
      return buildChain(
        [config.CLAUDE4_MODEL,    config.GPT5_2_MODEL],
        [config.CLAUDE4_API_KEY,  config.GPT5_2_API_KEY],
      );

    case 'orchestration':
      return buildChain(
        [config.GPT5_2_MODEL,    config.KIMI_K2_MODEL],
        [config.GPT5_2_API_KEY,  config.KIMI_K2_API_KEY],
      );

    case 'embedding':
      return buildChain(
        [config.EMBEDDING_MODEL],
        [config.EMBEDDING_API_KEY],
      );

    default:
      return buildChain(
        [config.GPT4O_MINI_MODEL,    config.GPT4O_MODEL],
        [config.GPT4O_MINI_API_KEY,  config.GPT4O_API_KEY],
      );
  }
}

/**
 * Returns the primary (highest priority) {model, apiKey} for a task.
 * Use getModelPriorityChain() when you need the full fallback list.
 */
export function getModelConfigForTask(task: TaskType): ModelConfig {
  const chain = getModelPriorityChain(task);
  if (chain.length > 0) return chain[0];
  // Last-resort default when nothing is configured
  return { model: 'gpt-4o-mini', apiKey: '' };
}
