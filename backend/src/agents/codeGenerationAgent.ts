
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';

/**
 * Patch-based code generation agent for continuous evolution.
 * Accepts current state, requirements, and modification request.
 * Generates only the necessary code changes (patches).
 * input: {
 *   systemDesign: object, // current system design
 *   requirements: object, // current requirements
 *   modification?: string, // user modification request
 *   context?: any, // additional context (e.g., previous patches)
 *   embedding?: any // for RAG
 * }
 * returns: { patch: string, files?: Array<{ path: string; content: string }>, frontendRepo?: string, backendRepo?: string }
 */
export async function codeGenerationAgent(input: any) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[codeGenerationAgent] called with:', input);
  }
  try {
    if (!input) throw new Error('Input required');
    const { model, apiKey } = getModelConfigForTask('code_generation');
    const llmProxy = new LLMProxyClient({ apiKey });
    let retrievedPatches = [];
    let embedding = input.embedding;
    if (!Array.isArray(embedding)) {
      try {
        const basis = JSON.stringify({
          systemDesign: input.systemDesign,
          requirements: input.requirements,
          modification: input.modification,
        });
        const embedded = await embeddingAgent(basis);
        if (Array.isArray(embedded) && embedded.length > 0) {
          embedding = embedded;
        }
      } catch {
        embedding = undefined;
      }
    }
    // If embedding is available in input, retrieve similar code patches for RAG
    if (embedding && Array.isArray(embedding)) {
      try {
        const similar = await searchVectors({
          user_id: input.user_id || 'unknown',
          task: 'code_patch',
          embedding,
          topK: 3
        });
        retrievedPatches = similar.map(row => row.metadata?.patch).filter(Boolean);
      } catch (e) {
        // Ignore retrieval errors, fallback to no context
      }
    }
    // Compose prompt for patch-based or modification-based codegen
    let userPrompt = {
      systemDesign: input.systemDesign,
      requirements: input.requirements,
      modification: input.modification,
      context: input.context,
      retrievedPatches
    };
    const systemPrompt = `You are a code generation agent for a continuous-evolution system.
Given the current system design, requirements, and (if present) a user modification request, generate ONLY the minimal patch-based code updates needed (never full repo).
If modification is present, generate a patch to apply the change to the existing codebase.
  If you can provide fully materialized files safely, include files as [{ path, content }].
  Respond ONLY in JSON: { patch: string, files?: Array<{ path: string; content: string }>, frontendRepo?: string, backendRepo?: string }.`;

    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPrompt) }
    ], model, 0.8, 0.9, 1000);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[codeGenerationAgent] LLM completion:', completion);
    }
    let content = completion.choices?.[0]?.message?.content || '{}';
    // Log the raw LLM content for debugging
    if (process.env.NODE_ENV !== 'production') {
      console.log('[LLM_RAW_CONTENT_CODEGEN]', content);
    }
    // Always remove all Markdown code block markers (handles ```json, ``` etc.)
    content = content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
    // Now extract the first JSON object
    const jsonMatch = content.match(/{[\s\S]*}/);
    if (!jsonMatch) {
      console.error('[codeGenerationAgent] No JSON object found in LLM output:', { content });
      throw new Error('Malformed LLM output: No JSON object found');
    }
    let result;
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[codeGenerationAgent] JSON parse error:', e, { content: jsonMatch[0] });
      throw new Error('Malformed LLM output: ' + jsonMatch[0]);
    }
    if (!('patch' in result)) {
      throw new Error('Malformed codeGenerationAgent output');
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[codeGenerationAgent] result:', result);
    }
    return {
      ...result,
      embedding: embedding || result.embedding,
    };
  } catch (err) {
    console.error('[codeGenerationAgent] error:', err);
    throw err;
  }
}
