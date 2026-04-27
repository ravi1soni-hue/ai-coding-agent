"use strict";
// Clarification Agent (stub)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clarificationAgent = clarificationAgent;
const modelRouter_1 = require("./modelRouter");
const env_1 = require("../config/env");
const openai_1 = __importDefault(require("openai"));
const openai = new openai_1.default({ apiKey: env_1.config.OPENAI_API_KEY });
async function clarificationAgent(input) {
    const modelId = (0, modelRouter_1.getModelIdForTask)('clarification');
    const systemPrompt = `Given the following structured requirements, ask ONLY blocking clarification questions (no scope expansion). Respond ONLY in JSON: { questions: string[], confirmed: boolean }.`;
    const completion = await openai.chat.completions.create({
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(input) }
        ],
        response_format: { type: 'json_object' }
    });
    return JSON.parse(completion.choices[0].message.content || '{}');
}
