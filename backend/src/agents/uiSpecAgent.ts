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

import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { compileStructuredSpec, type StructuredSpec } from './structuredSpec';
import { debug, error as logError } from '../utils/logger';
import { parseJsonResponse, scaledTokenBudget } from './llmUtils';
import { AgentState } from './agentStates';

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

    const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('ui_spec');
    const llmProxy = new LLMProxyClient({ apiKey, projectId: input.projectId, fallbacks });

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
1. ONE file = ONE UI responsibility. A component renders ONE thing — examples span any app type: navbar, hero, data table, kanban column, settings panel, checkout summary, dashboard chart, message thread, calendar grid, file upload zone, footer.
2. App.jsx is the ONLY file allowed to contain BrowserRouter, Routes, Route, or any routing logic. NO component file may import or use react-router routing primitives.
3. Every distinct page = its own component file (e.g. HomePage.jsx, DashboardPage.jsx, AdminPanel.jsx, CheckoutPage.jsx).
4. Every major section gets its own component file. Examples by app class: marketing (hero, features, testimonials, FAQ, footer, navbar); SaaS/dashboard (sidebar, topbar, stats summary, data table, detail drawer); e-commerce (product list, product card, cart, checkout, order summary); CRM/admin (record list, record form, filters bar, bulk actions toolbar); social (post composer, feed, thread, profile header); marketplace (search filters, listing card, booking widget). Match the actual app — do NOT assume a marketing site.
5. A component file should be ~80-200 lines of JSX. If a single component would exceed ~250 lines, split it — but always within the component budget in rule 10. Splitting must not exceed the budget; collapse onto inline JSX or compose siblings instead.
6. NEVER combine multiple pages or sections into one component. NEVER name a component with a generic catch-all like "AppSection".
7. Items inside a list or grid (cards, rows, tiles) are inline JSX inside their container component — NOT separate component files, unless the same item type genuinely reappears in multiple unrelated places in the app.
8. Toggle buttons, tab switchers, and small interactive controls that only exist within one section are inline JSX within that section — NOT separate component files.
9. Navigation state (active page, current route) lives in App.jsx only. Child components receive the current page via props if needed.
10. COMPONENT BUDGET — scales with actual scope, not just page count. The budget is: pages × 4, plus 1 per backend resource (CRUD entity / API route group), plus 2 shared (NavBar, Footer). Hard floor of 5 components, hard ceiling of 28. This accommodates: simple landing (5–8), portfolio (6–10), dashboard/SaaS (12–18), CRM/admin/e-commerce (16–24), full social/marketplace app (20–28). Inline sub-features (search inputs, filter chips, loading states, empty states, cards, modals) inside their parent section component — do NOT give each one its own file.
11. Name components after what they render: NavBar, HeroSection, ContactForm, ProductCard, OrderTable, ChatThread, AdminUsersPanel, BookingCalendar — never vague names like AppSection or MainComponent. NEVER name a component AppRouter, AppRoutes, RouterView, or any name ending in Router or Routes — routing lives exclusively in App.jsx, not in a component.
12. contentData MUST list every concrete value a user sees in this component: item names, labels, numeric values, CTA text. These are the canonical source of truth — downstream code generation copies them verbatim and must not invent different values.
13. NEVER add a prop named RouteView, routes, routeComponent, or any routing-related prop to a component's props interface. Components are not routers. If a component needs to know the current page, pass a simple string prop like currentPage.${feedbackBlock}`;

    const pageCount = Array.isArray(requirements.pages) ? requirements.pages.length : 4;
    const componentTokens = scaledTokenBudget(pageCount, 1200, 8000, 20000).initial;
    const componentInterfaceRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: componentInterfacePrompt }, { role: 'user', content: '' }],
      model,
      componentTokens,
      2,
      'componentInterfaces'
    );

    const componentInterfaces = parseJsonResponse(componentInterfaceRaw);
    if (!Array.isArray(componentInterfaces)) {
      throw new Error('Component interfaces must be an array');
    }

    const components: ComponentInterface[] = (componentInterfaces as any[]).map((c: any, index: number) => ({
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

    const dataFlowTokens = scaledTokenBudget(pageCount, 600, 4000, 12000).initial;
    const dataFlowRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: dataFlowPrompt }, { role: 'user', content: '' }],
      model,
      dataFlowTokens,
      2,
      'dataFlow'
    );

    const dataFlowObj = parseJsonResponse(dataFlowRaw);
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

    const apiContractTokens = scaledTokenBudget(pageCount, 400, 3000, 8000).initial;
    const apiContractRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: apiContractPrompt }, { role: 'user', content: '' }],
      model,
      apiContractTokens,
      2,
      'apiContract'
    );

    const apiContractArr = parseJsonResponse(apiContractRaw);
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

    const layoutTokens = scaledTokenBudget(pageCount, 400, 2500, 6000).initial;
    const layoutRaw = await callLLMWithRetry(
      llmProxy,
      [{ role: 'system', content: layoutPrompt }, { role: 'user', content: '' }],
      model,
      layoutTokens,
      2,
      'layoutStructure'
    );

    const layoutObj = parseJsonResponse(layoutRaw);

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

    // High consistency → advance to BLUEPRINT. Low consistency → stay/retry UI_SPEC.
    const advance = consistencyScore >= 0.55;
    const proposal = advance ? AgentState.NEXT_BLUEPRINT : AgentState.NEXT_UI_SPEC;
    return {
      updatedState: {
        activeState: proposal,
        domain: 'ui_spec',
        consistencyScore,
        transitions: [String(input.globalState?.activeState || AgentState.SYSTEM_DESIGN), AgentState.UI_SPEC],
        metadata: { projectId: input.projectId },
      },
      nextStateProposal: proposal,
      consistencyScore,
      output: structuredSpec,
    };
  } catch (err) {
    logError('uiSpecAgent', err);
    throw err;
  }
}
