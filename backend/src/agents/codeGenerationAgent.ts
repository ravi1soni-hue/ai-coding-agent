
import { getModelIdForTask } from './modelRouter';
import { config } from '../config/env';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';

const llmProxy = new LLMProxyClient({ apiKey: config.OPENAI_API_KEY });

export async function codeGenerationAgent(input: any) {
  try {
    if (!input) throw new Error('Input required');
    const modelId = getModelIdForTask('code_generation');
    let retrievedPatches = [];
    // If embedding is available in input, retrieve similar code patches for RAG
    if (input.embedding && Array.isArray(input.embedding)) {
      try {
        // Use embeddingAgent to get embedding if needed (example: input.text)
        // const embedding = await embeddingAgent(input.text);
        const similar = await searchVectors({
          user_id: input.user_id || 'unknown',
          task: 'code_patch',
          embedding: input.embedding,
          topK: 3
        });
        retrievedPatches = similar.map(row => row.metadata?.patch).filter(Boolean);
      } catch (e) {
        // Ignore retrieval errors, fallback to no context
      }
    }
    const systemPrompt = `Given the system design, generate ONLY patch-based code updates (never full repo), and output repo URLs if needed. Respond ONLY in JSON: { patch: string, frontendRepo: string, backendRepo: string }`;
    const userPrompt = JSON.stringify({ ...input, retrievedPatches });
    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], modelId);
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!('patch' in result)) {
      throw new Error('Malformed codeGenerationAgent output');
    }
    return result;
  } catch (err) {
    throw err;
  }
}
