"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrchestration = runOrchestration;
// LangGraph orchestration entry point
const requirementAnalysisAgent_1 = require("../agents/requirementAnalysisAgent");
const clarificationAgent_1 = require("../agents/clarificationAgent");
const confirmationGate_1 = require("../agents/confirmationGate");
const systemDesignAgent_1 = require("../agents/systemDesignAgent");
const codeGenerationAgent_1 = require("../agents/codeGenerationAgent");
const testFixAgent_1 = require("../agents/testFixAgent");
const deploymentAgent_1 = require("../agents/deploymentAgent");
const buildWorker_1 = require("../workers/buildWorker");
async function runOrchestration(ctx) {
    // Step 1: Requirement Analysis
    ctx.requirements = await (0, requirementAnalysisAgent_1.requirementAnalysisAgent)({ user_message: ctx.user_message });
    // Step 2: Clarification
    ctx.clarifications = await (0, clarificationAgent_1.clarificationAgent)(ctx.requirements);
    // Step 3: Confirmation Gate
    ctx.confirmation = await (0, confirmationGate_1.confirmationGate)(ctx.clarifications);
    // Step 4: System Design
    ctx.systemDesign = await (0, systemDesignAgent_1.systemDesignAgent)(ctx.requirements);
    // Step 5: Code Generation
    ctx.codeGen = await (0, codeGenerationAgent_1.codeGenerationAgent)(ctx.systemDesign);
    // Step 6: Test & Fix
    ctx.testResult = await (0, testFixAgent_1.testFixAgent)({ buildFn: () => (0, buildWorker_1.runBuildWorker)(ctx.codeGen) });
    // Step 7: Deployment
    ctx.deployment = await (0, deploymentAgent_1.deploymentAgent)({ frontend: 'frontend', backend: 'backend' });
    return ctx;
}
