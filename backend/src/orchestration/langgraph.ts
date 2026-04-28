// LangGraph orchestration entry point
import { requirementAnalysisAgent } from '../agents/requirementAnalysisAgent';
import { clarificationAgent } from '../agents/clarificationAgent';
import { confirmationGate } from '../agents/confirmationGate';
import { systemDesignAgent } from '../agents/systemDesignAgent';
import { codeGenerationAgent } from '../agents/codeGenerationAgent';
import { insertVector } from '../db/vectorStore';
import { testFixAgent } from '../agents/testFixAgent';
import { deploymentAgent } from '../agents/deploymentAgent';
import { runBuildWorker } from '../workers/buildWorker';
import { logOrchestrationStep } from '../db/auditLog';

export type OrchestrationContext = {
	user_message: string;
	requirements?: any;
	clarifications?: any;
	confirmation?: any;
	systemDesign?: any;
	codeGen?: any;
	testResult?: any;
	deployment?: any;
	history?: Array<{
	  step: string;
	  input: any;
	  output: any;
	  timestamp: string;
	}>;
};

export async function runOrchestration(ctx: OrchestrationContext) {
	const user_id = ctx.user_message?.slice(0, 32) || 'unknown';
	ctx.history = ctx.history || [];

	// Step 1: Requirement Analysis
	ctx.requirements = await requirementAnalysisAgent({ user_message: ctx.user_message });
	ctx.history.push({
	  step: 'requirementAnalysis',
	  input: ctx.user_message,
	  output: ctx.requirements,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'requirementAnalysis', input: ctx.user_message, output: ctx.requirements });

	// Step 2: Clarification
	ctx.clarifications = await clarificationAgent(ctx.requirements);
	ctx.history.push({
	  step: 'clarification',
	  input: ctx.requirements,
	  output: ctx.clarifications,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'clarification', input: ctx.requirements, output: ctx.clarifications });

	// Step 3: Confirmation Gate
	ctx.confirmation = await confirmationGate({
	  confirmed: ctx.clarifications?.confirmed,
	  clarifications: ctx.clarifications?.clarifications || ctx.clarifications?.questions,
	  questions: ctx.clarifications?.questions
	});
	ctx.history.push({
	  step: 'confirmation',
	  input: ctx.clarifications,
	  output: ctx.confirmation,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'confirmation', input: ctx.clarifications, output: ctx.confirmation });

	// Step 4: System Design
	ctx.systemDesign = await systemDesignAgent(ctx.requirements);
	ctx.history.push({
	  step: 'systemDesign',
	  input: ctx.requirements,
	  output: ctx.systemDesign,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'systemDesign', input: ctx.requirements, output: ctx.systemDesign });

	// Step 5: Code Generation
	ctx.codeGen = await codeGenerationAgent(ctx.systemDesign);
	ctx.history.push({
	  step: 'codeGeneration',
	  input: ctx.systemDesign,
	  output: ctx.codeGen,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'codeGeneration', input: ctx.systemDesign, output: ctx.codeGen });
	// Store code patch embedding in Postgres for retrieval (if embedding available)
	if (ctx.codeGen && ctx.codeGen.embedding) {
		await insertVector({
			user_id,
			task: 'code_patch',
			embedding: ctx.codeGen.embedding,
			metadata: { patch: ctx.codeGen.patch, systemDesign: ctx.systemDesign }
		});
	}

	// Step 6: Test & Fix
	ctx.testResult = await testFixAgent({ buildFn: () => runBuildWorker(ctx.codeGen) });
	ctx.history.push({
	  step: 'testFix',
	  input: ctx.codeGen,
	  output: ctx.testResult,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'testFix', input: ctx.codeGen, output: ctx.testResult });

	// Step 7: Deployment
	ctx.deployment = await deploymentAgent({ frontend: 'frontend', backend: 'backend' });
	ctx.history.push({
	  step: 'deployment',
	  input: ctx.testResult,
	  output: ctx.deployment,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'deployment', input: ctx.testResult, output: ctx.deployment });

	return ctx;
}