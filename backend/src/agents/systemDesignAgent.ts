import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export async function systemDesignAgent(input: any) {
  try {
    if (!input) throw new Error('Input required');
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
    const result = JSON.parse(completion.choices[0].message.content || '{}');
    if (!result.frontend || !result.backend) {
      throw new Error('Malformed systemDesignAgent output');
    }
    return result;
  } catch (err) {
    return { frontend: '', backend: '', database: '', auth: '', hosting: {}, error: (err as any)?.message || String(err) };
  }
}
