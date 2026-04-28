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
async function runOrchestration(ctx) {
    const user_id = ctx.user_message?.slice(0, 32) || 'unknown';
    ctx.history = ctx.history || [];
    // Step 1: Requirement Analysis
    ctx.requirements = await (0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: ctx.user_message });
    ctx.history.push({
        step: 'requirementAnalysis',
        input: ctx.user_message,
        output: ctx.requirements,
        timestamp: new Date().toISOString()
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'requirementAnalysis', input: ctx.user_message, output: ctx.requirements });
    // Step 2: Clarification
    ctx.clarifications = await (0, clarificationAgent_1.clarificationAgent)(ctx.requirements);
    ctx.history.push({
        step: 'clarification',
        input: ctx.requirements,
        output: ctx.clarifications,
        timestamp: new Date().toISOString()
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'clarification', input: ctx.requirements, output: ctx.clarifications });
    // Step 3: Confirmation Gate
    ctx.confirmation = await (0, confirmationGate_1.confirmationGate)({
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
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'confirmation', input: ctx.clarifications, output: ctx.confirmation });
    // Step 4: System Design
    ctx.systemDesign = await (0, systemDesignAgent_1.systemDesignAgent)(ctx.requirements);
    ctx.history.push({
        step: 'systemDesign',
        input: ctx.requirements,
        output: ctx.systemDesign,
        timestamp: new Date().toISOString()
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'systemDesign', input: ctx.requirements, output: ctx.systemDesign });
    // Step 5: Code Generation
    ctx.codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)(ctx.systemDesign);
    ctx.history.push({
        step: 'codeGeneration',
        input: ctx.systemDesign,
        output: ctx.codeGen,
        timestamp: new Date().toISOString()
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'codeGeneration', input: ctx.systemDesign, output: ctx.codeGen });
    // Store code patch embedding in Postgres for retrieval (if embedding available)
    if (ctx.codeGen && ctx.codeGen.embedding) {
        await (0, vectorStore_1.insertVector)({
            user_id,
            task: 'code_patch',
            embedding: ctx.codeGen.embedding,
            metadata: { patch: ctx.codeGen.patch, systemDesign: ctx.systemDesign }
        });
    }
    // Step 6: Test & Fix
    ctx.testResult = await (0, testFixAgent_1.testFixAgent)({ buildFn: () => (0, buildWorker_1.runBuildWorker)(ctx.codeGen) });
    ctx.history.push({
        step: 'testFix',
        input: ctx.codeGen,
        output: ctx.testResult,
        timestamp: new Date().toISOString()
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'testFix', input: ctx.codeGen, output: ctx.testResult });
    // Step 7: Deployment
    ctx.deployment = await (0, deploymentAgent_1.deploymentAgent)({ frontend: 'frontend', backend: 'backend' });
    ctx.history.push({
        step: 'deployment',
        input: ctx.testResult,
        output: ctx.deployment,
        timestamp: new Date().toISOString()
    });
    await (0, auditLog_1.logOrchestrationStep)({ user_id, step: 'deployment', input: ctx.testResult, output: ctx.deployment });
    return ctx;
}
