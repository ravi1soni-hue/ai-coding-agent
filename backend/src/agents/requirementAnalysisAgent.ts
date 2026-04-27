// Requirement Analysis Agent

import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export type RequirementAnalysisOutput = {
  website_type: 'business' | 'portfolio' | 'saas' | 'ecommerce';
  pages: string[];
  backend_required: boolean;
  auth_required: boolean;
  deployment_pref: string;
};

export async function requirementAnalysisAgent(input: { user_message: string }): Promise<RequirementAnalysisOutput> {
  const modelId = getModelIdForTask('core_reasoning');
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
