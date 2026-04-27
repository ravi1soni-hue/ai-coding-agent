import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function codeGenerationAgent(input: any) {
  const modelId = getModelIdForTask('code_generation');
  const systemPrompt = `Given the system design, generate ONLY patch-based code updates (never full repo), and output repo URLs if needed. Respond ONLY in JSON: { patch: string, frontendRepo: string, backendRepo: string }`;
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
