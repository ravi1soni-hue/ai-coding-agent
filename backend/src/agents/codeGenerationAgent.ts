
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
    // Image Handling Strategy:
    // - LLM is instructed to use placeholder service URLs (https://via.placeholder.com/WIDTHxHEIGHT)
    // - This avoids external image dependencies and CORS issues
    // - Placeholder service is reliable and requires no authentication
    // - In production, users can replace placeholder URLs with real image URLs
    const systemPrompt = `You are a code generation agent. Given a system design and requirements, generate a complete, working frontend web application.
Always produce fully materialized files in the files array — every file needed to run the app (HTML, CSS, JS/JSX, config, package.json, etc.).
Do NOT truncate or abbreviate any file content. Every file must be complete and runnable.
Also produce a unified diff patch string summarizing the changes.

CRITICAL REQUIREMENT FOR REACT PROJECTS:
If the project uses React (i.e. package.json includes "react" as a dependency), you MUST include a "public/index.html" file in the files array.
This file is required by react-scripts (Create React App) to build successfully.
The public/index.html MUST contain a proper HTML5 structure with a <div id="root"></div> element where React mounts.
Use exactly this structure (customise the <title> as appropriate):
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>

CRITICAL: Package.json Management
- Every library imported in code MUST be declared in package.json dependencies or devDependencies
- If you generate code using react-router-dom, Redux, Axios, or any other third-party library, you MUST add it to package.json
- Do NOT generate code that imports undeclared libraries
- If code imports a library, it MUST be in package.json dependencies or devDependencies
- Ensure package.json is valid JSON with proper formatting and all required fields (name, version, dependencies, scripts)

Image Handling
- Do NOT use external image URLs (e.g., https://example.com/image.png)
- Use placeholder service URLs instead: https://via.placeholder.com/300x200 (for 300x200 images)
- Format: https://via.placeholder.com/WIDTHxHEIGHT
- Example: https://via.placeholder.com/400x300 for a 400x300 image
- This ensures images work without external dependencies or CORS issues

Respond ONLY in valid JSON with no markdown fences: { patch: string, files: Array<{ path: string; content: string }> }.`;

    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPrompt) }
    ], model, 0.7, 0.95, 6000, 180_000); // 6000 tokens, 180s timeout
    if (process.env.NODE_ENV !== 'production') {
      console.log('[codeGenerationAgent] LLM completion:', completion);
    }
    let content = completion.choices?.[0]?.message?.content || '{}';
    // Log the raw LLM content for debugging
    if (process.env.NODE_ENV !== 'production') {
      console.log('[LLM_RAW_CONTENT_CODEGEN]', content);
    }
    if (typeof content === 'string' && content.trim().startsWith('<')) {
      const snippet = content.replace(/\s+/g, ' ').slice(0, 1000);
      console.error('[codeGenerationAgent] Received HTML instead of JSON from LLM proxy', { snippet });
      throw new Error(`Code generation proxy failure: received HTML response. ${snippet}`);
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
