// LangGraph orchestration entry point
import { requirementAnalysisAgent } from '../agents/requirementAnalysisAgent';
import { clarificationAgent } from '../agents/clarificationAgent';
import { confirmationGate } from '../agents/confirmationGate';
import { systemDesignAgent } from '../agents/systemDesignAgent';
import { codeGenerationAgent } from '../agents/codeGenerationAgent';
import { testFixAgent } from '../agents/testFixAgent';
import { deploymentAgent } from '../agents/deploymentAgent';
import { runBuildWorker } from '../workers/buildWorker';

export type OrchestrationContext = {
	user_message: string;
	requirements?: any;
	clarifications?: any;
	confirmation?: any;
	systemDesign?: any;
	codeGen?: any;
	testResult?: any;
	deployment?: any;
};

export async function runOrchestration(ctx: OrchestrationContext) {
	// Step 1: Requirement Analysis
	ctx.requirements = await requirementAnalysisAgent({ user_message: ctx.user_message });

	// Step 2: Clarification
	ctx.clarifications = await clarificationAgent(ctx.requirements);

	// Step 3: Confirmation Gate
	ctx.confirmation = await confirmationGate(ctx.clarifications);

	// Step 4: System Design
	ctx.systemDesign = await systemDesignAgent(ctx.requirements);

	// Step 5: Code Generation
	ctx.codeGen = await codeGenerationAgent(ctx.systemDesign);

	// Step 6: Test & Fix
	ctx.testResult = await testFixAgent({ buildFn: () => runBuildWorker(ctx.codeGen) });

	// Step 7: Deployment
	ctx.deployment = await deploymentAgent({ frontend: 'frontend', backend: 'backend' });

	return ctx;
}