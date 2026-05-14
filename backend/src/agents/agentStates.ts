/**
 * Canonical state-name constants shared by every agent and the orchestrator.
 *
 * All state strings must come from here — never inline literals — so that the
 * orchestrator's exact-match routing never breaks due to case inconsistencies.
 */
export const AgentState = {
  // Pipeline stages (lowercase — these are the "current stage" identifiers)
  REQUIREMENTS:          'requirements',
  CLARIFICATION:         'clarification',
  SYSTEM_DESIGN:         'system_design',
  UI_SPEC:               'ui_spec',
  BLUEPRINT:             'blueprint',
  EXECUTION_PLAN:        'execution_plan',
  CODE_GENERATION:       'code_generation',
  TEST_FIX:              'test_fix',
  DEPLOYMENT:            'deployment',

  // Transition targets (what nextStateProposal can be set to)
  NEXT_CLARIFICATION:    'CLARIFICATION_REQUIRED',
  NEXT_SYSTEM_DESIGN:    'SYSTEM_DESIGN',
  NEXT_UI_SPEC:          'UI_SPEC',
  NEXT_BLUEPRINT:        'BLUEPRINT_REQUIRED',
  NEXT_EXECUTION_PLAN:   'EXECUTION_PLAN',
  NEXT_CODE_GENERATION:  'CODE_GENERATION',
  NEXT_DEPLOYMENT:       'DEPLOYMENT',
  NEXT_DONE:             'DONE',
} as const;

export type AgentStateName = typeof AgentState[keyof typeof AgentState];
