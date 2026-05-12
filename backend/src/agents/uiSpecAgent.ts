/**
 * UI Specification Agent
 * Generates a detailed UI specification before code generation
 * Includes:
 * - Component interfaces (props)
 * - Data flow (which component fetches what)
 * - Layout structure (App.jsx composition)
 * - API contract (endpoints and response shapes)
 * - Component dependencies (for ordered generation)
 */

import { getModelConfigForTask } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { compileStructuredSpec, validateStructuredSpec, type StructuredSpec } from './structuredSpec';
import { debug, error as logError } from '../utils/logger';

export interface ComponentInterface {
  name: string;
  path: string;
  purpose: string;
  props: {
    [key: string]: {
      type: string;
      required: boolean;
      description: string;
    };
  };
  state?: string[];
  effects?: string[];
  dependencies: string[];
  renderLogic: string;
  // Canonical content values (e.g. item names, labels, numeric values, feature lists, CTA text).
  // Every LLM call that generates this component must use these exact values — no independent invention.
  contentData?: Record<string, unknown>;
}

export interface DataFlowNode {
  componentName: string;
  fetches?: {
    endpoint: string;
    method: string;
    dataKey: string;
    responsePath?: string;
  }[];
  passesTo: {
    [componentName: string]: string[];
  };
}

export interface APIContract {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  consumedBy: string[];
  requestShape?: string;
  responseShape: {
    [key: string]: string;
  };
  errorResponses?: string[];
}

export interface UISpec {
  appName: string;
  components: ComponentInterface[];
  dataFlow: DataFlowNode[];
  layoutStructure: {
    appRoot: string;
    compositionOrder: string[];
    stateManagement: string;
  };
  apiContract: APIContract[];
  generationOrder: string[];
  navigationStrategy: string;
  stateManagementStrategy: string;
}

export type BrainState = {
  activeState: string;
  projectSpec?: unknown;
  uiSpec?: unknown;
  consistencyScore?: number;
  domain?: string;
  transitions?: string[];
  metadata?: Record<string, unknown>;
};

export type StateAwareAgentResult<T> = {
  updatedState: Partial<BrainState>;
  nextStateProposal: string;
  consistencyScore: number;
  output: T;
};

async function callLLMWithRetry(
  llmProxy: LLMProxyClient,
  messages: Array<{ role: string; content: string }>,
  model: string,
  maxTokens: number,
  maxRetries = 2,
  label = 'llmCall'
): Promise<string> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await llmProxy.chatCompletion(messages, model, 0.3, 0.9, maxTokens, 120_000);
      const content: string = completion.choices?.[0]?.message?.content || '';
      if (/^[\s]*<!doctype|<html/i.test(content)) throw new Error(`${label}: LLM returned HTML error page`);
      if (!content.trim()) throw new Error(`${label}: LLM returned empty response`);
      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

function parseJsonFromResponse(content: string): any {
  const cleaned = content.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  let lastParseError: unknown;
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    lastParseError = e;
    // Try largest JSON object/array in the response (handles truncated markdown prose around JSON)
    const jsonMatch = cleaned.match(/\[[\s\S]*\]|{[\s\S]*}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        lastParseError = e2;
      }
    }
  }
  const parseMsg = lastParseError instanceof SyntaxError ? ` Parse error: ${lastParseError.message}.` : '';
  throw new Error(`No valid JSON found.${parseMsg} Snippet: ${content.replace(/\s+/g, ' ').slice(0, 200)}`);
}

function calculateComponentDependencies(
  components: ComponentInterface[],
  dataFlow: DataFlowNode[]
): { order: string[]; dependencies: Map<string, string[]> } {
  const depMap = new Map<string, string[]>();
  
  // Build dependency graph
  components.forEach(comp => {
    depMap.set(comp.name, [...comp.dependencies]);
  });

  // Add data flow dependencies
  dataFlow.forEach(flow => {
    const currentDeps = depMap.get(flow.componentName) || [];
    Object.keys(flow.passesTo).forEach(childComp => {
      if (!currentDeps.includes(childComp)) {
        currentDeps.push(childComp);
      }
    });
    depMap.set(flow.componentName, currentDeps);
  });

  // Topological sort: generate leaf components first
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(name: string, recursionStack: Set<string>): void {
    if (visited.has(name)) return;
    if (recursionStack.has(name)) return; // Cycle detection

    recursionStack.add(name);
    const deps = depMap.get(name) || [];
    deps.forEach(dep => {
      if (components.find(c => c.name === dep)) {
        visit(dep, recursionStack);
      }
    });
    recursionStack.delete(name);

    visited.add(name);
    order.push(name);
  }

  components.forEach(comp => {
    visit(comp.name, new Set());
  });

  return { order, dependencies: depMap };
}

function semanticUISpecScore(input: { systemDesign: unknown; requirements: unknown; projectSpec: unknown; uiSpec: UISpec }): number {
  const text = JSON.stringify(input).toLowerCase();
  const score =
    0.5 +
    (/\bproject_id\b/.test(text) ? 0.08 : 0) +
    (/\bapp\b/.test(text) ? 0.04 : 0) +
    (/\bcomponent\b/.test(text) ? 0.04 : 0) +
    (/\bapi\b|\bendpoint\b/.test(text) ? 0.08 : 0) +
    (/\bnavigation\b|\brouting\b/.test(text) ? 0.06 : 0) +
    (/\bplaceholder\b|\btodo\b|\btbd\b/.test(text) ? -0.2 : 0);
  return Math.max(0, Math.min(1, score));
}

export async function uiSpecAgent(input: any): Promise<StateAwareAgentResult<StructuredSpec>> {
  debug('uiSpecAgent', { input });
  try {
    if (!input || !input.systemDesign) {
      throw new Error('System design required as input');
    }
    if (!input.projectSpec) {
      throw new Error('Canonical projectSpec required for UI spec generation');
    }
    const projectSpec = input.projectSpec;
    const specRequirements = projectSpec?.requirements || {};
    if (input.requirements?.website_type && specRequirements.website_type && input.requirements.website_type !== specRequirements.website_type) {
      throw new Error('UI spec input does not match canonical projectSpec requirements');
    }
    if (Array.isArray(specRequirements.pages) && Array.isArray(input.requirements?.pages)) {
      const specPages = specRequirements.pages.map((page: string) => String(page).trim()).filter(Boolean);
      const inputPages = input.requirements.pages.map((page: string) => String(page).trim()).filter(Boolean);
      for (const page of specPages) {
        if (!inputPages.includes(page)) {
          throw new Error(`UI spec input is missing canonical page: ${page}`);
        }
      }
    }

    const { model, apiKey } = getModelConfigForTask('code_generation');
    const llmProxy = new LLMProxyClient({ apiKey, projectId: input.projectId });

    const systemDesign = input.systemDesign;
    const requirements = input.requirements || {};
    const canonicalRequirements = projectSpec.requirements || {};
    const modification = input.modification || null;
    // Self-heal feedback: hints from a previous downstream failure (e.g. blueprint
    // detected a missing component for a requested page). Surface verbatim in the
    // prompt so the LLM corrects the divergence rather than re-emitting the same
    // shape on retry.
    const previousIssues: string[] = Array.isArray(input.previousIssues)
      ? input.previousIssues.filter((s: unknown) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
      : [];
    const feedbackBlock = previousIssues.length > 0
      ? `\n\nFEEDBACK FROM A PREVIOUS ATTEMPT — your earlier output failed downstream consistency checks. Address each item; do not repeat the same mistakes:\n${previousIssues.map((m) => `- ${m}`).join('\n')}\n`
      : '';

    // Step 1: Generate component interfaces
    const componentInterfacePrompt = `You are a React component architect. Your job is to decompose the UI into small, focused, single-responsibility component files.

Canonical project spec (authoritative):
${JSON.stringify(projectSpec, null, 2)}

System Design:
${JSON.stringify(systemDesign, null, 2)}

Requirements:
${JSON.stringify(requirements, null, 2)}

Generate a JSON array with this exact shape (no markdown fences):
[
  {
    "name": "ComponentName",
    "path": "src/components/ComponentName.jsx",
    "purpose": "One sentence: what exactly this component renders",
    "props": {
      "propName": {
        "type": "string|number|boolean|object|array",
        "required": true|false,
        "description": "What this prop is for"
      }
    },
    "state": ["stateVarName1"],
    "effects": ["Description of side effect if any"],
    "dependencies": ["OtherComponentName"],
    "renderLogic": "Concrete description of JSX output — what the user sees",
    "contentData": {
      "key": "EXACT literal value that must appear verbatim in the rendered output (labels, numeric values, item names, CTA text, etc.)"
    }
  }
]

DECOMPOSITION RULES — these are absolute, non-negotiable:
1. ONE file = ONE UI responsibility. A component renders ONE thing (a navbar, a hero, a data table, a footer).
2. App.jsx is the ONLY file allowed to contain BrowserRouter, Routes, Route, or any routing logic. NO component file may import or use react-router routing primitives.
3. Every distinct page = its own component file (e.g. HomePage.jsx, DashboardPage.jsx).
4. Every major section (hero, feature list, testimonials, FAQ, footer, nav bar) = its own component file.
5. A component file must be ~80-150 lines of JSX. If you think it needs more, split it further.
6. NEVER combine multiple pages or sections into one component. NEVER name a component with a generic catch-all like "AppSection".
7. Items inside a list or grid (cards, rows, tiles) are inline JSX inside their container component — NOT separate component files, unless the same item type genuinely reappears in multiple unrelated places in the app.
8. Toggle buttons, tab switchers, and small interactive controls that only exist within one section are inline JSX within that section — NOT separate component files.
9. Navigation state (active page, current route) lives in App.jsx only. Child components receive the current page via props if needed.
10. COMPONENT BUDGET: target (number of distinct pages) + 2 to 3 shared layout pieces (e.g. NavBar, Footer). Do NOT create separate components for every interactive element inside a single section.
11. Name components after what they render: NavBar, HeroSection, ContactForm, Footer — never vague names like AppSection or MainComponent.
12. contentData MUST list every concrete value a user sees in this component: item names, labels, numeric values, CTA text. These are the canonical source of truth — downstream code generation copies them verbatim and must not invent different values.${feedbackBlock}`;

    const pageCount = Array.isArray(requirements.pages) ? requirements.pages.length : 4;
    const componentTokens = Math.min(8000, Math.max(4000, pageCount * 500));
    const componentInterfaceRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: componentInterfacePrompt }, { role: 'user', content: '' }],
      model,
      componentTokens,
      2,
      'componentInterfaces'
    );

    const componentInterfaces = parseJsonFromResponse(componentInterfaceRaw);
    if (!Array.isArray(componentInterfaces)) {
      throw new Error('Component interfaces must be an array');
    }

    const components: ComponentInterface[] = componentInterfaces.map((c: any, index: number) => ({
      name: c.name || `Component${index + 1}`,
      path: c.path || `src/components/Component${index + 1}.jsx`,
      purpose: c.purpose || 'Generated component',
      props: c.props || {},
      state: Array.isArray(c.state) ? c.state : [],
      effects: Array.isArray(c.effects) ? c.effects : [],
      dependencies: Array.isArray(c.dependencies) ? c.dependencies : [],
      renderLogic: c.renderLogic || 'Renders UI based on props and state',
      contentData: c.contentData && typeof c.contentData === 'object' && !Array.isArray(c.contentData) ? c.contentData : undefined,
    }));

    // Universal stability: ensure every requested requirements.pages entry
    // becomes an actual page component, even if the LLM omitted it.
    // This prevents later stages from “dropping” pages like pricing due to
    // missing components in the layout tree.
    const toPascalCase = (value: string): string =>
      String(value || '')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

    const requestedPages = Array.isArray(requirements?.pages) ? requirements.pages : [];
    const existingNames = new Set(components.map((c) => String(c.name)));
    const seededComponents: ComponentInterface[] = [];

    for (const page of requestedPages) {
      const pageStr = typeof page === 'string' ? page : String(page || '').trim();
      if (!pageStr) continue;
      const seededName = toPascalCase(pageStr);
      if (!seededName) continue;
      if (existingNames.has(seededName)) continue;

      seededComponents.push({
        name: seededName,
        path: `src/components/${seededName}.jsx`,
        purpose: `${pageStr} page`,
        props: {},
        state: [],
        effects: [],
        dependencies: [],
        renderLogic: `Render the ${pageStr} page according to the provided requirements.`,
      });

      existingNames.add(seededName);
    }

    if (seededComponents.length > 0) {
      components.push(...seededComponents);
    }

    debug('uiSpecAgent:componentInterfaces', { components });

    // Step 2: Generate data flow
    const dataFlowPrompt = `You are a React data architecture expert. Define the data flow between components using the canonical project spec as the source of truth.

Canonical project spec (authoritative, if present):
${JSON.stringify(projectSpec, null, 2)}

Components:
${JSON.stringify(components.map(c => ({ name: c.name, purpose: c.purpose, props: Object.keys(c.props) })), null, 2)}

System Design:
${JSON.stringify(systemDesign, null, 2)}

Requirements:
${JSON.stringify(requirements, null, 2)}

Generate a JSON object with this exact shape (no markdown fences):
{
  "nodes": [
    {
      "componentName": "ComponentName",
      "fetches": [
        {
          "endpoint": "/api/resource",
          "method": "GET",
          "dataKey": "items",
          "responsePath": "data.items"
        }
      ],
      "passesTo": {
        "ChildComponentName": ["propName1", "propName2"]
      }
    }
  ]
}

RULES:
- Include all components in nodes
- fetches array should only include endpoints this component actually calls
- passesTo maps component names to the specific props they receive
- Ensure data flows logically from parent to child
- No circular dependencies`;

    const dataFlowRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: dataFlowPrompt }, { role: 'user', content: '' }],
      model,
      3000,
      2,
      'dataFlow'
    );

    const dataFlowObj = parseJsonFromResponse(dataFlowRaw);
    const dataFlow: DataFlowNode[] = (dataFlowObj.nodes || []).map((n: any) => ({
      componentName: n.componentName || '',
      fetches: Array.isArray(n.fetches) ? n.fetches : [],
      passesTo: n.passesTo || {},
    }));

    debug('uiSpecAgent:dataFlow', { dataFlow });

    // Step 3: Generate API contract
    const apiContractPrompt = `You are a REST API contract expert. Define the exact API endpoints and shapes.

Data Flow:
${JSON.stringify(dataFlow, null, 2)}

System Design:
${JSON.stringify(systemDesign, null, 2)}

Requirements:
${JSON.stringify(requirements, null, 2)}

Generate a JSON array with this exact shape (no markdown fences):
[
  {
    "endpoint": "/api/resource",
    "method": "GET",
    "consumedBy": ["ComponentName1", "ComponentName2"],
    "requestShape": "Query params: ?filter=value&sort=field",
    "responseShape": {
      "id": "number",
      "name": "string",
      "created_at": "ISO 8601 timestamp"
    },
    "errorResponses": ["400 Bad Request", "401 Unauthorized", "500 Server Error"]
  }
]

RULES:
- Include only endpoints actually used in the data flow
- responseShape must match what components expect
- Method must be GET, POST, PUT, DELETE, or PATCH
- consumedBy must list actual component names that fetch from this endpoint
- Keep field names and types realistic for the domain`;

    const apiContractRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: apiContractPrompt }, { role: 'user', content: '' }],
      model,
      2500,
      2,
      'apiContract'
    );

    const apiContractArr = parseJsonFromResponse(apiContractRaw);
    const apiContract: APIContract[] = (Array.isArray(apiContractArr) ? apiContractArr : []).map((a: any) => ({
      endpoint: a.endpoint || '/api/resource',
      method: (a.method || 'GET').toUpperCase() as any,
      consumedBy: Array.isArray(a.consumedBy) ? a.consumedBy : [],
      requestShape: a.requestShape,
      responseShape: a.responseShape || {},
      errorResponses: Array.isArray(a.errorResponses) ? a.errorResponses : [],
    }));

    debug('uiSpecAgent:apiContract', { apiContract });

    // Step 4: Calculate component generation order
    const { order: generationOrder } = calculateComponentDependencies(components, dataFlow);

    // Step 5: Generate layout structure
    const layoutPrompt = `You are a React layout expert. Define how components are composed in App.jsx.

Components (in generation order):
${generationOrder.join(' -> ')}

Component Details:
${JSON.stringify(components, null, 2)}

System Design:
${JSON.stringify(systemDesign, null, 2)}

Generate a JSON object with this exact shape (no markdown fences):
{
  "appRoot": "Describes the main App component structure",
  "compositionOrder": ["ComponentName1", "ComponentName2"],
  "stateManagement": "Description of state management approach (props drilling, context, etc)",
  "navigationStrategy": "How navigation/routing is handled (if applicable)",
  "stateManagementStrategy": "How to manage shared state (useState, context, etc)"
}

RULES:
- compositionOrder must list all components in the order they are rendered in App.jsx
- App.jsx owns ALL routing (BrowserRouter, Routes, Route) and top-level state — components just receive props
- stateManagement: use "props drilling" for simple apps; "useState in App" for page switching; "React Context" only if genuinely needed
- navigationStrategy: describe concretely how App.jsx renders the right page/section (conditional render, react-router Routes, etc)
- appRoot: describe the actual JSX structure of App (e.g. "<NavBar/> + conditional page render based on activePage state")${feedbackBlock}`;

    const layoutRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: layoutPrompt }, { role: 'user', content: '' }],
      model,
      2000,
      2,
      'layoutStructure'
    );

    const layoutObj = parseJsonFromResponse(layoutRaw);

    // Compile final UI spec
    const componentNames = new Set(components.map((component) => component.name));
    const sanitizedGenerationOrder = generationOrder.filter((name) => componentNames.has(name));
    const ensuredGenerationOrder = sanitizedGenerationOrder.length > 0 ? sanitizedGenerationOrder : components.map((component) => component.name);
    const hasAppComponent = components.some((component) => component.name === 'App');
    if (!hasAppComponent) {
      components.unshift({
        name: 'App',
        path: 'src/App.jsx',
        purpose: 'Root application shell that composes all generated UI sections.',
        props: {},
        state: [],
        effects: [],
        dependencies: [],
        renderLogic: 'Renders the application shell and composes generated child components.',
      });
    }
    if (!componentNames.has('App')) {
      ensuredGenerationOrder.push('App');
    }

    const normalizedApiContract = apiContract.filter((entry) => {
      const endpoint = String(entry.endpoint || '').trim();
      return endpoint.startsWith('/api/');
    });

    const uiSpec: UISpec = {
      appName: String(systemDesign.frontend?.appName || requirements.appName || projectSpec?.userMessage || 'GeneratedApp').trim() || 'GeneratedApp',
      components,
      dataFlow,
      layoutStructure: {
        appRoot: String(layoutObj.appRoot || 'App component wrapping all sections'),
        compositionOrder: Array.isArray(layoutObj.compositionOrder)
          ? layoutObj.compositionOrder.filter((name: string) => componentNames.has(name))
          : components.map((component) => component.name),
        stateManagement: String(layoutObj.stateManagement || 'Props drilling for simplicity'),
      },
      apiContract: normalizedApiContract,
      generationOrder: ensuredGenerationOrder,
      navigationStrategy: String(layoutObj.navigationStrategy || 'Single page with conditional rendering'),
      stateManagementStrategy: String(layoutObj.stateManagementStrategy || 'useState for local state, props for passing data'),
    };
    const structuredSpec = compileStructuredSpec({
      uiSpec,
      systemDesign,
      requirements,
    });

    const consistencyScore = semanticUISpecScore({
      systemDesign,
      requirements,
      projectSpec,
      uiSpec,
    });

    debug('uiSpecAgent:final', { structuredSpec, consistencyScore });

    return {
      updatedState: {
        activeState: consistencyScore < 0.55 ? 'BLUEPRINT_REQUIRED' : 'UI_SPEC',
        domain: 'ui_spec',
        consistencyScore,
        transitions: [String(input.globalState?.activeState || 'system_design'), 'ui_spec'],
        metadata: { projectId: input.projectId },
      },
      nextStateProposal: consistencyScore < 0.55 ? 'BLUEPRINT_REQUIRED' : 'UI_SPEC',
      consistencyScore,
      output: structuredSpec,
    };
  } catch (err) {
    logError('uiSpecAgent', err);
    throw err;
  }
}
