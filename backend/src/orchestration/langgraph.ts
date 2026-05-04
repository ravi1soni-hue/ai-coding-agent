// LangGraph orchestration entry point
import { requirementAnalysisAgent } from '../agents/requirementAnalysisAgent';
import { clarificationAgent } from '../agents/clarificationAgent';
import { confirmationGate } from '../agents/confirmationGate';
import { systemDesignAgent } from '../agents/systemDesignAgent';
import { uiSpecAgent } from '../agents/uiSpecAgent';
import { blueprintAgent } from '../agents/blueprintAgent';
import { codeGenerationAgent } from '../agents/codeGenerationAgent';
import { insertVector } from '../db/vectorStore';
import { testFixAgent } from '../agents/testFixAgent';
import { deploymentAgent } from '../agents/deploymentAgent';
import { runBuildWorker } from '../workers/buildWorker';
import { logOrchestrationStep } from '../db/auditLog';
import { materializeProjectWorkspace } from '../factory/projectFactory';
import { consolidateProjectSpec, validateProjectSpec } from '../agents/projectSpec';
import { debug, error } from '../utils/logger';

export type OrchestrationContext = {
	user_message: string;
	projectId?: string;
	revisionId?: string;
	requirements?: any;
	clarifications?: any;
	confirmation?: any;
	systemDesign?: any;
	uiSpec?: any;
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

function requiresBackendArchitecture(requirements: any): boolean {
  return Boolean(requirements?.backend_required || requirements?.auth_required);
}

export async function runOrchestration(ctx: OrchestrationContext) {
    const user_id = ctx.user_message?.slice(0, 32) || 'unknown';
    const projectId = ctx.projectId || `orchestration-${Date.now().toString(36)}`;
    ctx.history = ctx.history || [];

    async function runStage<T>(step: string, input: any, handler: () => Promise<T>) {
      try {
        const result = await handler();
        await logOrchestrationStep({ user_id, step, input, output: result });
        ctx.history!.push({
          step,
          input,
          output: result,
          timestamp: new Date().toISOString(),
        });
        debug('runOrchestration:step-done', { step, projectId, result });
        return result;
      } catch (err) {
        const message = String((err as any)?.message || err);
        error('runOrchestration', { step, error: message });
        throw new Error(`Orchestration stage "${step}" failed: ${message}`);
      }
    }

    // Step 1: Requirement Analysis
    ctx.requirements = await runStage('requirementAnalysis', ctx.user_message, async () =>
      requirementAnalysisAgent({ user_message: ctx.user_message })
    );

    // Step 2: Clarification
    ctx.clarifications = await runStage('clarification', ctx.requirements, async () =>
      clarificationAgent({
        requirements: ctx.requirements,
        projectSpec: ctx.projectSpec,
        clarificationAnswers: ctx.clarifications?.context?.clarificationAnswers || {},
        askedQuestions: ctx.clarifications?.context?.askedQuestions || [],
      })
    );

    // Build canonical projectSpec after clarification (partial — later stages not yet run)
    ctx.projectSpec = validateProjectSpec(
      consolidateProjectSpec({
        projectId,
        userMessage: ctx.user_message,
        requirements: ctx.requirements,
        clarifications: ctx.clarifications,
        clarificationAnswers: ctx.clarifications?.context?.clarificationAnswers || {},
        systemDesign: ctx.systemDesign,
        uiSpec: ctx.uiSpec,
        blueprint: ctx.blueprint,
      }),
      { partial: true }
    );

    // Step 3: Confirmation Gate
    ctx.confirmation = await runStage('confirmation', ctx.clarifications, async () =>
      confirmationGate({
        confirmed: ctx.clarifications?.confirmed,
        clarifications: ctx.clarifications?.questions,
        questions: ctx.clarifications?.questions,
      })
    );

    // Step 4: System Design
    if (requiresBackendArchitecture(ctx.requirements)) {
      ctx.systemDesign = await runStage('systemDesign', ctx.projectSpec, async () =>
        systemDesignAgent({ requirements: ctx.requirements, projectSpec: ctx.projectSpec })
      );
    } else {
      ctx.systemDesign = {
        frontend: {
          framework: 'react-vite',
          pages: Array.isArray(ctx.requirements?.pages) ? ctx.requirements.pages : [],
          components: [],
          styling: 'css',
        },
        backend: null,
        database: null,
        auth: null,
        hosting: {
          frontend: 'vercel',
          backend: null,
        },
      };
      await logOrchestrationStep({ user_id, step: 'systemDesign', input: ctx.requirements, output: ctx.systemDesign });
      ctx.history.push({
        step: 'systemDesign',
        input: ctx.requirements,
        output: ctx.systemDesign,
        timestamp: new Date().toISOString(),
      });
    }

    // Step 5: UI Spec
    ctx.uiSpec = await runStage('uiSpec', ctx.projectSpec, async () =>
      uiSpecAgent({
        requirements: ctx.requirements,
        systemDesign: ctx.systemDesign,
        projectSpec: ctx.projectSpec,
      })
    );

    // Step 6: Blueprint
    ctx.blueprint = await runStage('blueprint', ctx.projectSpec, async () =>
      blueprintAgent({
        requirements: ctx.requirements,
        systemDesign: ctx.systemDesign,
        uiSpec: ctx.uiSpec,
        projectSpec: ctx.projectSpec,
        projectId,
      })
    );

    // Step 7: Code Generation
    ctx.codeGen = await runStage('codeGeneration', ctx.blueprint, async () =>
      codeGenerationAgent({
        systemDesign: ctx.systemDesign,
        uiSpec: ctx.uiSpec,
        blueprint: ctx.blueprint,
        requirements: ctx.requirements,
        projectSpec: ctx.projectSpec,
        user_id,
      })
    );
    ctx.materializedRevision = await materializeProjectWorkspace({
      projectId,
      codeGen: ctx.codeGen,
    });
    ctx.history.push({
      step: 'codeGeneration',
      input: ctx.systemDesign,
      output: ctx.codeGen,
      timestamp: new Date().toISOString(),
    });
    await logOrchestrationStep({ user_id, step: 'codeGeneration', input: ctx.systemDesign, output: ctx.codeGen });
    // Store code patch embedding in Postgres for retrieval (if embedding available)
    if (ctx.codeGen && ctx.codeGen.embedding) {
      await insertVector({
        user_id,
        task: 'code_patch',
        embedding: ctx.codeGen.embedding,
        metadata: { patch: ctx.codeGen.patch, systemDesign: ctx.systemDesign },
      });
    }

    // Step 8: Test & Fix
    ctx.testResult = await runStage('testFix', ctx.codeGen, async () =>
      testFixAgent({
        buildFn: () => runBuildWorker({ workspaceDir: ctx.materializedRevision?.workspaceDir }),
        fixFn: async (logs: string) => {
          const repair = await codeGenerationAgent({
            systemDesign: ctx.systemDesign,
            uiSpec: ctx.uiSpec,
            requirements: ctx.requirements,
            modification: `Fix the build errors below and regenerate complete files:\n${String(logs).slice(-4000)}`,
            projectSpec: ctx.projectSpec,
            user_id,
            projectId,
          });
          ctx.codeGen = repair;
          ctx.materializedRevision = await materializeProjectWorkspace({
            projectId,
            codeGen: repair,
          });
          ctx.history!.push({
            step: 'codeGeneration',
            input: ctx.systemDesign,
            output: repair,
            timestamp: new Date().toISOString(),
          });
          await logOrchestrationStep({ user_id, step: 'codeGeneration', input: ctx.systemDesign, output: repair });
        },
        files: ctx.codeGen?.files,
        workspaceDir: ctx.materializedRevision?.workspaceDir,
      })
    );

    if (!ctx.testResult?.success) {
      throw new Error(
        'Mandatory test/fix stage failed. Deployment is blocked until build/tests succeed. Review the build logs, correct any issues, and retry.'
      );
    }
    if (!ctx.testResult.buildDir) {
      throw new Error(
        'Mandatory test/fix stage completed without producing a frontend build artifact. Deployment cannot proceed.'
      );
    }

    // Step 9: Deployment
    const revisionId = ctx.revisionId || ctx.materializedRevision?.revisionId || `rev-${Date.now().toString(36)}`;
    ctx.deployment = await runStage('deployment', ctx.testResult, async () =>
      deploymentAgent({
        projectId,
        revisionId,
        buildDir: ctx.testResult.buildDir,
        backendDir: ctx.testResult.backendDir,
        frontendProjectName: `proj-${projectId.slice(0, 10)}`,
        backendService: `backend-${projectId.slice(0, 10)}`,
      })
    );
    return ctx;
}
