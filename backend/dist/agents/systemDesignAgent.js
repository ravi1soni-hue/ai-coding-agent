"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemDesignAgent = systemDesignAgent;
const modelRouter_1 = require("./modelRouter");
const env_1 = require("../config/env");
const openai_1 = __importDefault(require("openai"));
const openai = new openai_1.default({ apiKey: env_1.config.OPENAI_API_KEY });
async function systemDesignAgent(input) {
    const modelId = (0, modelRouter_1.getModelIdForTask)('core_reasoning');
    const systemPrompt = `Given the requirements, decide the full technical architecture. Respond ONLY in JSON: { frontend, backend, database, auth, hosting: { frontend, backend } }`;
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
