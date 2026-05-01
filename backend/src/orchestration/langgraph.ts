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
import path from 'path';
import { materializeProjectWorkspace } from '../factory/projectFactory';

export type OrchestrationContext = {
	user_message: string;
	projectId?: string;
	revisionId?: string;
	requirements?: any;
	clarifications?: any;
	confirmation?: any;
	systemDesign?: any;
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
	const user_id = ctx.user_message?.slice(0, 32) || 'unknown';
	const projectId = ctx.projectId || `orchestration-${Date.now().toString(36)}`;
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
	ctx.codeGen = await codeGenerationAgent({
	  systemDesign: ctx.systemDesign,
	  requirements: ctx.requirements,
	  user_id,
	});
	ctx.materializedRevision = await materializeProjectWorkspace({
	  projectId,
	  codeGen: ctx.codeGen,
	});
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
	ctx.testResult = await testFixAgent({
	  buildFn: () => runBuildWorker({ workspaceDir: ctx.materializedRevision?.workspaceDir }),
	});
	ctx.history.push({
	  step: 'testFix',
	  input: ctx.codeGen,
	  output: ctx.testResult,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'testFix', input: ctx.codeGen, output: ctx.testResult });

	// Step 7: Deployment
	const revisionId = ctx.revisionId || ctx.materializedRevision?.revisionId || `rev-${Date.now().toString(36)}`;
	if (!ctx.testResult?.buildDir) {
	  throw new Error('Build failed and no fallback available. Generated project must have a valid dist/ directory. Ensure frontend files were generated correctly and build succeeds.');
	}
	ctx.deployment = await deploymentAgent({
	  projectId,
	  revisionId,
	  buildDir: ctx.testResult.buildDir,
	  backendDir: ctx.testResult?.backendDir,
	  frontendProjectName: `proj-${projectId.slice(0, 10)}`,
	  backendService: `backend-${projectId.slice(0, 10)}`,
	});
	ctx.history.push({
	  step: 'deployment',
	  input: ctx.testResult,
	  output: ctx.deployment,
	  timestamp: new Date().toISOString()
	});
	await logOrchestrationStep({ user_id, step: 'deployment', input: ctx.testResult, output: ctx.deployment });

	return ctx;
}