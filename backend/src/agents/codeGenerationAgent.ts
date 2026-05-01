
import { getModelConfigForTask } from './modelRouter';
import { searchVectors } from '../db/vectorStore';
import { LLMProxyClient } from './llmProxyClient';
import { embeddingAgent } from './embeddingAgent';
import { debug, error as logError } from '../utils/logger';

function stripMarkdownCodeBlocks(content: string): string {
  return content.replace(/```[a-zA-Z]*\s*|```/g, '').trim();
}

function extractBalancedJson(content: string): string | null {
  const text = content.trim();
  const startTokens = ['{', '['];

  for (let startIndex = 0; startIndex < text.length; startIndex++) {
    const firstChar = text[startIndex];
    if (!startTokens.includes(firstChar)) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(startIndex, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // continue searching for the next balanced JSON block
          }
        }
      }
    }
  }
  return null;
}

function parseJsonFromText(content: string): any {
  const cleaned = stripMarkdownCodeBlocks(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    const candidate = extractBalancedJson(cleaned);
    if (!candidate) {
      throw new Error('Malformed LLM output: No valid JSON object found');
    }
    return JSON.parse(candidate);
  }
}


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
  debug('codeGenerationAgent', { input });
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
    const systemPrompt = `You are a code generation agent. Given a system design and requirements, generate a complete, working frontend web application.\nAlways produce fully materialized files in the files array — every file needed to run the app (HTML, CSS, JS/JSX, config, package.json, etc.).\nDo NOT truncate or abbreviate any file content. Every file must be complete and runnable.\nAlso produce a unified diff patch string summarizing the changes.\n\nRESPOND WITH ONLY ONE JSON OBJECT.\nThe JSON object MUST contain exactly these top-level keys: patch, files.\nThe files value must be an array of objects with path and content strings.\nDo NOT include markdown fences, commentary, or any text outside the JSON object.\nIf you cannot comply, return a valid object with files: [] and patch: "".\n\nCRITICAL REQUIREMENT FOR REACT PROJECTS:\nIf the project uses React (i.e. package.json includes \"react\" as a dependency), you MUST include a \"public/index.html\" file in the files array.\nThis file is required by react-scripts (Create React App) to build successfully.\nThe public/index.html MUST contain a proper HTML5 structure with a <div id=\"root\"></div> element where React mounts.\nUse exactly this structure (customise the <title> as appropriate):\n<!DOCTYPE html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n    <title>App</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>\n\nCRITICAL: Package.json Management\n- Every library imported in code MUST be declared in package.json dependencies or devDependencies\n- If you generate code using react-router-dom, Redux, Axios, or any other third-party library, you MUST add it to package.json\n- Do NOT generate code that imports undeclared libraries\n- If code imports a library, it MUST be in package.json dependencies or devDependencies\n- Ensure package.json is valid JSON with proper formatting and all required fields (name, version, dependencies, scripts)\n\nIMPORTANT: Do not include lockfiles or package manager artifacts in the output.\n- Do NOT return package-lock.json, npm-shrinkwrap.json, yarn.lock, or node_modules.\n- Only return source files, configuration files, and the exact package.json required to run the app.\n\nImage Handling\n- Do NOT use external image URLs (e.g., https://example.com/image.png)\n- Use placeholder service URLs instead: https://via.placeholder.com/300x200 (for 300x200 images)\n- Format: https://via.placeholder.com/WIDTHxHEIGHT\n- Example: https://via.placeholder.com/400x300 for a 400x300 image\n- This ensures images work without external dependencies or CORS issues\n\nRespond ONLY in valid JSON with no markdown fences: { patch: string, files: Array<{ path: string; content: string }> }.`;

    const completion = await llmProxy.chatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userPrompt) }
    ], model, 0.0, 0.9, 6000, 180_000); // deterministic generation for structured JSON output
    debug('codeGenerationAgent:completion', { completion });
    let content = completion.choices?.[0]?.message?.content || '{}';
    debug('LLM_RAW_CONTENT_CODEGEN', { content });
    if (typeof content === 'string' && content.trim().startsWith('<')) {
      const snippet = content.replace(/\s+/g, ' ').slice(0, 1000);
      logError('codeGenerationAgent:html-response', { snippet });
      throw new Error(`Code generation proxy failure: received HTML response. ${snippet}`);
    }
    content = stripMarkdownCodeBlocks(content);
    let result = parseJsonFromText(content);

    if (Array.isArray(result)) {
      result = { files: result, patch: '' };
    }

    if (!result || typeof result !== 'object') {
      logError('codeGenerationAgent:no-json', { content });
      throw new Error('Malformed LLM output: No valid JSON object found');
    }

    if (!Array.isArray((result as any).files)) {
      logError('codeGenerationAgent:missing-files', { result });
      throw new Error('Malformed codeGenerationAgent output: missing files array');
    }

    const normalizedFiles = (result as any).files.map((file: any) => {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
        throw new Error('Malformed codeGenerationAgent output: every file item must include path and content strings');
      }
      return { path: file.path.replace(/^\/*/, ''), content: file.content };
    });

    const filteredFiles = normalizedFiles.filter((file: any) => {
      const banList = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'node_modules'];
      const normalizedPath = file.path.replace(/^\/*/, '');
      if (banList.some((ban) => normalizedPath === ban || normalizedPath.startsWith(`${ban}/`))) {
        logError('codeGenerationAgent:removed-artifact', { path: normalizedPath });
        return false;
      }
      return true;
    });

    const finalResult = {
      ...result,
      files: filteredFiles,
      patch: typeof (result as any).patch === 'string' ? (result as any).patch : String((result as any).patch || ''),
    };

    const hasPackageJson = finalResult.files.some(
      (file: any) => file.path === 'package.json' || file.path === '/package.json'
    );
    if (!hasPackageJson) {
      logError('codeGenerationAgent:missing-package-json', { result: finalResult });
      throw new Error('Malformed codeGenerationAgent output: missing required package.json file');
    }

    debug('codeGenerationAgent:result', { result: finalResult });
    return {
      ...finalResult,
      embedding: embedding || (result as any).embedding,
    };
  } catch (err) {
    logError('codeGenerationAgent', err);
    throw err;
  }
}
