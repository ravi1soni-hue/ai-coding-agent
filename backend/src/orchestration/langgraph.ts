import { runAIOrchestration } from '../ai/orchestrator/orchestrator';

export type OrchestrationContext = {
	user_message: string;
	projectId?: string;
	revisionId?: string;
	requirements?: any;
	clarifications?: any;
	confirmation?: any;
	systemDesign?: any;
  uiSpec?: any;
  structuredSpec?: any;
  blueprint?: any;
	projectSpec?: any;
	codeGen?: any;
	testResult?: any;
	deployment?: any;
	materializedRevision?: any;
	history?: Array<{
	  step: string;
	  input: any;
	  output: any;
	  timestamp: string;
	}>;
};

export async function runOrchestration(ctx: OrchestrationContext) {
  const result = await runAIOrchestration({
    projectId: ctx.projectId || `orchestration-${Date.now().toString(36)}`,
    sessionId: ctx.projectId || `orchestration-${Date.now().toString(36)}`,
    userMessage: ctx.user_message,
    modification: undefined,
    clarificationAnswers: ctx.clarifications?.context?.clarificationAnswers || {},
    step: undefined,
  });

  return {
    ...ctx,
    projectId: result.projectId,
    requirements: result.memory.requirements,
    clarifications: result.memory.clarifications,
    systemDesign: result.memory.systemDesign,
    uiSpec: result.memory.uiSpec?.structuredSpec,
    structuredSpec: result.memory.uiSpec?.structuredSpec,
    blueprint: result.memory.blueprint?.blueprint,
    projectSpec: result.memory,
    codeGen: result.memory.code,
    testResult: result.memory.tests,
    deployment: result.memory.deployment,
    materializedRevision: undefined,
    history: result.memory.history.map((event) => ({
      step: event.stage,
      input: event.payload,
      output: event.payload,
      timestamp: event.createdAt,
    })),
  };
}
