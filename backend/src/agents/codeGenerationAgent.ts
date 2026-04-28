
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';

export async function codeGenerationAgent(input: any) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[codeGenerationAgent] called with:', input);
  }
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
    ], 'gpt-5-chat', 0.8, 0.9, 1000);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[codeGenerationAgent] LLM completion:', completion);
    }
    let content = completion.choices?.[0]?.message?.content || '{}';
    // Strip Markdown code block markers (```json, ```, etc.)
    content = content.replace(/```[a-zA-Z]*\s*|\n?```/g, '').trim();
    // Extract first JSON object if there's extra text
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in LLM response');
    }
    const result = JSON.parse(jsonMatch[0]);
    if (!('patch' in result)) {
      throw new Error('Malformed codeGenerationAgent output');
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[codeGenerationAgent] result:', result);
    }
    return result;
  } catch (err) {
    console.error('[codeGenerationAgent] error:', err);
    throw err;
  }
}
