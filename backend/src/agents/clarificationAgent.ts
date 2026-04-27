// Clarification Agent (stub)

import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function clarificationAgent(input: any) {
  const modelId = getModelIdForTask('clarification');
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
