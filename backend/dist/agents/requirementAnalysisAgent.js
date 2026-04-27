"use strict";
// Requirement Analysis Agent
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirementAnalysisAgent = requirementAnalysisAgent;
const modelRouter_1 = require("./modelRouter");
const env_1 = require("../config/env");
const openai_1 = __importDefault(require("openai"));
const openai = new openai_1.default({ apiKey: env_1.config.OPENAI_API_KEY });
async function requirementAnalysisAgent(input) {
    const modelId = (0, modelRouter_1.getModelIdForTask)('core_reasoning');
    const systemPrompt = `Extract structured website requirements from the following user message. Respond ONLY in JSON with keys: website_type, pages, backend_required, auth_required, deployment_pref.`;
    const completion = await openai.chat.completions.create({
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input.user_message }
        ],
        response_format: { type: 'json_object' }
    });
    return JSON.parse(completion.choices[0].message.content || '{}');
}
