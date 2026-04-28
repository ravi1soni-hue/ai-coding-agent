
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';

export async function codeGenerationAgent(input: any) {
  console.log('[codeGenerationAgent] called with:', input);
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('code_generation');
    const llmProxy = new LLMProxyClient({
      apiKey,
      chatUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/chat/completions',
      embeddingUrl: 'https://quasarmarket.coforge.com/qag/llmrouter-api/v2/text/embeddings',
    });
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
    ], model, 0.8, 0.9, 1000);
    console.log('[codeGenerationAgent] LLM completion:', completion);
    const result = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
    if (!('patch' in result)) {
      throw new Error('Malformed codeGenerationAgent output');
    }
    console.log('[codeGenerationAgent] result:', result);
    return result;
  } catch (err) {
    console.error('[codeGenerationAgent] error:', err);
    throw err;
  }
}
