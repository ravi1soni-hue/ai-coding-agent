"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrchestration = runOrchestration;
// LangGraph orchestration entry point
const requirementAnalysisAgent_1 = require("../agents/requirementAnalysisAgent");
const clarificationAgent_1 = require("../agents/clarificationAgent");
const confirmationGate_1 = require("../agents/confirmationGate");
const systemDesignAgent_1 = require("../agents/systemDesignAgent");
const codeGenerationAgent_1 = require("../agents/codeGenerationAgent");
const vectorStore_1 = require("../db/vectorStore");
const testFixAgent_1 = require("../agents/testFixAgent");
const deploymentAgent_1 = require("../agents/deploymentAgent");
const buildWorker_1 = require("../workers/buildWorker");
const auditLog_1 = require("../db/auditLog");
const projectFactory_1 = require("../factory/projectFactory");
const logger_1 = require("../utils/logger");
async function runOrchestration(ctx) {
    const user_id = ctx.user_message?.slice(0, 32) || 'unknown';
    const projectId = ctx.projectId || `orchestration-${Date.now().toString(36)}`;
    ctx.history = ctx.history || [];
    async function runStage(step, input, handler) {
        try {
            const result = await handler();
            await (0, auditLog_1.logOrchestrationStep)({ user_id, step, input, output: result });
            ctx.history.push({
                step,
                input,
                output: result,
                timestamp: new Date().toISOString(),
            });
            (0, logger_1.debug)('runOrchestration:step-done', { step, projectId, result });
            return result;
        }
        catch (err) {
            const message = String(err?.message || err);
            (0, logger_1.error)('runOrchestration', { step, error: message });
            throw new Error(`Orchestration stage "${step}" failed: ${message}`);
        }
    }
    // Step 1: Requirement Analysis
    ctx.requirements = await runStage('requirementAnalysis', ctx.user_message, async () => (0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: ctx.user_message }));
    // Step 2: Clarification
    ctx.clarifications = await runStage('clarification', ctx.requirements, async () => (0, clarificationAgent_1.clarificationAgent)(ctx.requirements));
    // Step 3: Confirmation Gate
    ctx.confirmation = await runStage('confirmation', ctx.clarifications, async () => (0, confirmationGate_1.confirmationGate)({
        confirmed: ctx.clarifications?.confirmed,
        clarifications: ctx.clarifications?.clarifications || ctx.clarifications?.questions,
        questions: ctx.clarifications?.questions,
    }));
    // Step 4: System Design
    ctx.systemDesign = await runStage('systemDesign', ctx.requirements, async () => (0, systemDesignAgent_1.systemDesignAgent)(ctx.requirements));
    // Step 5: Code Generation
    ctx.codeGen = await runStage('codeGeneration', ctx.systemDesign, async () => (0, codeGenerationAgent_1.codeGenerationAgent)({
        systemDesign: ctx.systemDesign,
        requirements: ctx.requirements,
        user_id,
    }));
    ctx.materializedRevision = await (0, projectFactory_1.materializeProjectWorkspace)({
        projectId,
        codeGen: ctx.codeGen,
    });
    ctx.history.push({
        step: 'codeGeneration',
        input: ctx.systemDesign,
        output: ctx.codeGen,
        timestamp: new Date().toISOString(),
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'codeGeneration', input: ctx.systemDesign, output: ctx.codeGen });
    // Store code patch embedding in Postgres for retrieval (if embedding available)
    if (ctx.codeGen && ctx.codeGen.embedding) {
        await (0, vectorStore_1.insertVector)({
            user_id,
            task: 'code_patch',
            embedding: ctx.codeGen.embedding,
            metadata: { patch: ctx.codeGen.patch, systemDesign: ctx.systemDesign },
        });
    }
    // Step 6: Test & Fix
    ctx.testResult = await runStage('testFix', ctx.codeGen, async () => (0, testFixAgent_1.testFixAgent)({
        buildFn: () => (0, buildWorker_1.runBuildWorker)({ workspaceDir: ctx.materializedRevision?.workspaceDir }),
        files: ctx.codeGen?.files,
        workspaceDir: ctx.materializedRevision?.workspaceDir,
    }));
    if (!ctx.testResult?.success) {
        throw new Error('Mandatory test/fix stage failed. Deployment is blocked until build/tests succeed. Review the build logs, correct any issues, and retry.');
    }
    if (!ctx.testResult.buildDir) {
        throw new Error('Mandatory test/fix stage completed without producing a frontend build artifact. Deployment cannot proceed.');
    }
    // Step 7: Deployment
    const revisionId = ctx.revisionId || ctx.materializedRevision?.revisionId || `rev-${Date.now().toString(36)}`;
    ctx.deployment = await runStage('deployment', ctx.testResult, async () => (0, deploymentAgent_1.deploymentAgent)({
        projectId,
        revisionId,
        buildDir: ctx.testResult.buildDir,
        backendDir: ctx.testResult.backendDir,
        frontendProjectName: `proj-${projectId.slice(0, 10)}`,
        backendService: `backend-${projectId.slice(0, 10)}`,
    }));
    return ctx;
}
