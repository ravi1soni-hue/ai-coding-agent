import type { OrchestrationFsmState, OrchestrationState, ProjectMemory, OrchestrationCommand } from '../contracts/orchestration';

export const OUTER_FSM_ORDER: OrchestrationFsmState[] = [
  'IDLE',
  'ANALYZING',
  'CLARIFYING',
  'DESIGNING',
  'CODING',
  'TESTING',
  'DEPLOYING',
  'FAILED',
  'COMPLETED',
];

export function outerIndex(state: OrchestrationFsmState): number {
  return OUTER_FSM_ORDER.indexOf(state);
}

export function getOuterFsmStateForStage(stage: OrchestrationState): OrchestrationFsmState {
  if (stage === 'failed') return 'FAILED';
  if (stage === 'done') return 'COMPLETED';

  if (stage === 'requirements') return 'ANALYZING';

  if (stage === 'clarification' || stage === 'confirmation' || stage === 'modification') return 'CLARIFYING';

  if (stage === 'system_design' || stage === 'ui_spec' || stage === 'blueprint') return 'DESIGNING';

  if (stage === 'execution_plan' || stage === 'code_generation') return 'CODING';

  if (stage === 'testing') return 'TESTING';

  if (stage === 'deployment') return 'DEPLOYING';

  return 'ANALYZING';
}

export function getOuterFsmStateForMemory(memory: ProjectMemory): OrchestrationFsmState {
  return getOuterFsmStateForStage(memory.currentState);
}

/**
 * Outer FSM should start from the persisted outer state when resuming,
 * but fall back to deriving from the internal stage.
 */
export function getStartingOuterFsmState(command: OrchestrationCommand, memory: ProjectMemory): OrchestrationFsmState {
  if (command.recoveryFsmState) return command.recoveryFsmState;
  return getOuterFsmStateForMemory(memory);
}

/**
 * Map outer FSM state to the internal stage that must be invoked first
 * to make progress for that outer state.
 *
 * Note: current orchestration uses stageWrap() only for some internal stages.
 * For example, execution_plan is constructed without stageWrap().
 */
export function firstInternalStageForOuterState(outer: OrchestrationFsmState): OrchestrationState {
  switch (outer) {
    case 'IDLE':
    case 'ANALYZING':
      return 'requirements';
    case 'CLARIFYING':
      return 'clarification';
    case 'DESIGNING':
      return 'system_design';
    case 'CODING':
      // execution_plan is not stage-wrapped today; code_generation is.
      return 'code_generation';
    case 'TESTING':
      return 'testing';
    case 'DEPLOYING':
      return 'deployment';
    case 'FAILED':
    case 'COMPLETED':
      // Terminal states; no internal stage expected.
      return 'done' as unknown as OrchestrationState;
    default:
      return 'requirements';
  }
}
