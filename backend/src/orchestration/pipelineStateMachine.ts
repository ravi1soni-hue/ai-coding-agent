export const PIPELINE_STAGES = [
  'init',
  'requirementAnalysis',
  'clarification',
  'clarification_wait',
  'clarification_wait_modification',
  'confirmation',
  'confirmation_wait',
  'systemDesign',
  'uiSpec',
  'uiSpec_modification',
  'blueprint',
  'codeGen',
  'codeGen_modification',
  'testFix',
  'testFix_modification',
  'deploy',
  'deploy_modification',
  'done',
  'done_modification',
  'failed',
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

export type ErrorRepairLevel = 1 | 2 | 3;

export type RecoveryRoute = {
  level: ErrorRepairLevel;
  targetStage: PipelineStage;
  reason: string;
};

export const STAGE_ALIASES: Record<string, PipelineStage> = {
  // Orchestrator (OrchestrationState) aliases
  requirements: 'requirementAnalysis',
  system_design: 'systemDesign',
  ui_spec: 'uiSpec',
  code_generation: 'codeGen',
  testing: 'testFix',
  deployment: 'deploy',

  // Legacy/general aliases
  codeGeneration: 'codeGen',
  code_gen: 'codeGen',
  codegen: 'codeGen',
  systemDesign: 'systemDesign',
  uiSpec: 'uiSpec',
  testFix: 'testFix',
  test_fix: 'testFix',
  start: 'init',
  complete: 'done',
  failed: 'failed',
  done: 'done',
};

export function normalizePipelineStage(stage: string | undefined | null): PipelineStage {
  const raw = String(stage || 'init').trim();
  if (PIPELINE_STAGES.includes(raw as PipelineStage)) {
    return raw as PipelineStage;
  }
  return STAGE_ALIASES[raw] || 'init';
}

export function stageIndex(stage: string | undefined | null): number {
  const normalized = normalizePipelineStage(stage);
  return PIPELINE_STAGES.indexOf(normalized);
}

export function atOrAfterStage(activeStage: string | undefined | null, targetStage: PipelineStage): boolean {
  return stageIndex(activeStage) >= stageIndex(targetStage);
}

export function nextStage(stage: PipelineStage): PipelineStage {
  const index = PIPELINE_STAGES.indexOf(stage);
  return PIPELINE_STAGES[Math.min(index + 1, PIPELINE_STAGES.length - 1)];
}

export function isModificationStage(stage: string | undefined | null): boolean {
  return /_modification$/.test(normalizePipelineStage(stage));
}

export function isWaitStage(stage: string | undefined | null): boolean {
  return /_wait$/.test(normalizePipelineStage(stage));
}

export function stageGroup(stage: string | undefined | null): 'analysis' | 'design' | 'generation' | 'delivery' | 'terminal' {
  const normalized = normalizePipelineStage(stage);
  if (['init', 'requirementAnalysis', 'clarification', 'clarification_wait', 'clarification_wait_modification', 'confirmation', 'confirmation_wait'].includes(normalized)) {
    return 'analysis';
  }
  if (['systemDesign', 'uiSpec', 'uiSpec_modification', 'blueprint'].includes(normalized)) {
    return 'design';
  }
  if (['codeGen', 'codeGen_modification', 'testFix', 'testFix_modification'].includes(normalized)) {
    return 'generation';
  }
  if (['deploy', 'deploy_modification'].includes(normalized)) {
    return 'delivery';
  }
  return 'terminal';
}

export function resolveRecoveryTarget(level: ErrorRepairLevel): PipelineStage {
  if (level === 1) return 'codeGen';
  if (level === 2) return 'blueprint';
  return 'systemDesign';
}

export function isValidTransition(from: PipelineStage, to: PipelineStage): boolean {
  const transitions: Record<PipelineStage, PipelineStage[]> = {
    init: ['requirementAnalysis'],
    requirementAnalysis: ['clarification', 'confirmation', 'systemDesign', 'failed'],
    clarification: ['clarification_wait'],
    clarification_wait: ['requirementAnalysis', 'confirmation', 'systemDesign', 'failed'],
    clarification_wait_modification: ['requirementAnalysis', 'confirmation', 'systemDesign', 'failed'],
    confirmation: ['confirmation_wait'],
    confirmation_wait: ['systemDesign', 'failed'],
    systemDesign: ['uiSpec', 'failed'],
    uiSpec: ['blueprint', 'failed'],
    uiSpec_modification: ['blueprint', 'failed'],
    blueprint: ['codeGen', 'failed'],
    codeGen: ['testFix', 'deploy', 'failed'],
    codeGen_modification: ['testFix', 'deploy', 'failed'],
    testFix: ['deploy', 'failed'],
    testFix_modification: ['deploy', 'failed'],
    deploy: ['done', 'failed'],
    deploy_modification: ['done', 'failed'],
    done: [],
    done_modification: [],
    failed: [],
  };
  return transitions[from]?.includes(to) ?? false;
}

export function resolveRecoveryRoute(stage: string | undefined | null, level: ErrorRepairLevel): RecoveryRoute {
  const normalized = normalizePipelineStage(stage);

  if (level === 1) {
    return {
      level,
      targetStage: normalized === 'deploy' || normalized === 'deploy_modification' ? 'testFix' : 'codeGen',
      reason: 'syntax_or_missing_file',
    };
  }

  if (level === 2) {
    return {
      level,
      targetStage: normalized === 'uiSpec' || normalized === 'uiSpec_modification' ? 'uiSpec' : 'blueprint',
      reason: 'structural_or_dependency',
    };
  }

  return {
    level,
    targetStage: 'clarification',
    reason: 'requirement_mismatch',
  };
}
