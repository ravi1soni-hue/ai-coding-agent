import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function systemDesignAgent(input: any) {
  const modelId = getModelIdForTask('core_reasoning');
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
