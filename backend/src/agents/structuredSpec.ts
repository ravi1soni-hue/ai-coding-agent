import path from 'path';

export type StructuredComponentProp = {
  name: string;
  type: string;
  required: boolean;
  source?: 'state' | 'api' | 'prop' | 'computed';
  description?: string;
};

export type StructuredComponentDefinition = {
  name: string;
  filePath: string;
  purpose: string;
  props: StructuredComponentProp[];
  stateKeys: string[];
  children: string[];
  imports: string[];
  exportsDefault: true;
};

export type StructuredStateDefinition = {
  name: string;
  owner: string;
  type: 'local' | 'context' | 'server';
  shape: Record<string, unknown>;
  source?: string;
};

export type StructuredLayoutNode = {
  name: string;
  type: 'app' | 'route' | 'page' | 'section' | 'component' | 'fragment';
  component: string;
  props?: Record<string, unknown>;
  children: StructuredLayoutNode[];
};

export type StructuredApiContract = {
  name: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  purpose: string;
  backendRequired: boolean;
  routeFile: string;
  tableName?: string;
  queryNotes?: string;
};

export type StructuredFilePlanEntry = {
  path: string;
  kind: 'entry' | 'component' | 'route' | 'style' | 'config' | 'schema' | 'utility';
  purpose: string;
  dependsOn: string[];
  owner?: string;
};

export type StructuredSpec = {
  componentSchema: StructuredComponentDefinition[];
  stateModel: StructuredStateDefinition[];
  layoutTree: StructuredLayoutNode;
  apiContracts: StructuredApiContract[];
  filePlan: StructuredFilePlanEntry[];
  backend_required: boolean;
  version: number;
};

const FILE_PATH_RE = /^(package\.json|index\.html|vite\.config\.js|src\/|backend\/)/;
const COMPONENT_PATH_RE = /^src\/components\/.+\.jsx$/;
const ROUTE_PATH_RE = /^backend\/src\/routes\/.+\.ts$/;

function normalizePathValue(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function isValidFilePath(filePath: string): boolean {
  const normalized = normalizePathValue(filePath);
  return !normalized.includes('..') && !path.isAbsolute(normalized) && FILE_PATH_RE.test(normalized);
}

function collectLayoutNames(node: StructuredLayoutNode, acc = new Set<string>()): Set<string> {
  acc.add(node.component);
  for (const child of node.children) collectLayoutNames(child, acc);
  return acc;
}

function collectLayoutEdges(node: StructuredLayoutNode, acc = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const current = acc.get(node.component) || new Set<string>();
  for (const child of node.children) current.add(child.component);
  acc.set(node.component, current);
  for (const child of node.children) collectLayoutEdges(child, acc);
  return acc;
}

function hasCircularDependencies(filePlan: StructuredFilePlanEntry[]): boolean {
  const graph = new Map<string, string[]>();
  for (const entry of filePlan) graph.set(entry.path, entry.dependsOn.map(normalizePathValue));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): boolean => {
    if (visited.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const dep of graph.get(node) || []) {
      if (graph.has(dep) && visit(dep)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  return Array.from(graph.keys()).some(visit);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizePathValue).filter(Boolean)));
}

function inferComponentFilePath(name: string): string {
  if (name === 'App') return 'src/App.jsx';
  return `src/components/${name}.jsx`;
}

function normalizeLayoutNode(raw: unknown, label: string): StructuredLayoutNode {
  const obj = assertObject(raw, label);
  const name = assertString(obj.name, `${label}.name`);
  const component = assertString(obj.component, `${label}.component`);
  const type = assertString(obj.type ?? 'component', `${label}.type`) as StructuredLayoutNode['type'];
  const props = obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props) ? (obj.props as Record<string, unknown>) : {};
  const children = assertArray(obj.children ?? [], `${label}.children`).map((child, index) =>
    normalizeLayoutNode(child, `${label}.children[${index}]`)
  );
  return { name, component, type, props, children };
}

export function validateStructuredSpec(raw: unknown): StructuredSpec {
  const spec = assertObject(raw, 'structuredSpec');

  const componentSchema = assertArray(spec.componentSchema, 'componentSchema').map((component, index) => {
    const obj = assertObject(component, `componentSchema[${index}]`);
    const name = assertString(obj.name, `componentSchema[${index}].name`);
    const filePath = normalizePathValue(assertString(obj.filePath, `componentSchema[${index}].filePath`));
    if (!COMPONENT_PATH_RE.test(filePath) && filePath !== 'src/App.jsx') {
      throw new Error(`componentSchema[${index}].filePath must be a src/components/*.jsx file or src/App.jsx`);
    }
    const props = assertArray(obj.props ?? [], `componentSchema[${index}].props`).map((prop, propIndex) => {
      const propObj = assertObject(prop, `componentSchema[${index}].props[${propIndex}]`);
      return {
        name: assertString(propObj.name, `componentSchema[${index}].props[${propIndex}].name`),
        type: assertString(propObj.type, `componentSchema[${index}].props[${propIndex}].type`),
        required: assertBoolean(propObj.required, `componentSchema[${index}].props[${propIndex}].required`),
        source: typeof propObj.source === 'string' ? (propObj.source as StructuredComponentProp['source']) : undefined,
        description: typeof propObj.description === 'string' ? propObj.description : undefined,
      };
    });
    const stateKeys = assertArray(obj.stateKeys ?? [], `componentSchema[${index}].stateKeys`).map((value, i) =>
      assertString(value, `componentSchema[${index}].stateKeys[${i}]`)
    );
    const children = assertArray(obj.children ?? [], `componentSchema[${index}].children`).map((value, i) =>
      assertString(value, `componentSchema[${index}].children[${i}]`)
    );
    const imports = assertArray(obj.imports ?? [], `componentSchema[${index}].imports`).map((value, i) =>
      assertString(value, `componentSchema[${index}].imports[${i}]`)
    );
    return {
      name,
      filePath,
      purpose: assertString(obj.purpose, `componentSchema[${index}].purpose`),
      props,
      stateKeys,
      children,
      imports,
      exportsDefault: true as const,
    };
  });

  const componentNames = new Set(componentSchema.map((component) => component.name));
  if (componentNames.size !== componentSchema.length) throw new Error('componentSchema contains duplicate component names');

  const layoutTree = normalizeLayoutNode(spec.layoutTree, 'layoutTree');
  const layoutNames = collectLayoutNames(layoutTree);

  const stateModel = assertArray(spec.stateModel, 'stateModel').map((state, index) => {
    const obj = assertObject(state, `stateModel[${index}]`);
    const owner = assertString(obj.owner, `stateModel[${index}].owner`);
    if (!componentNames.has(owner) && owner !== 'App') throw new Error(`stateModel[${index}].owner must reference a component in componentSchema`);
    return {
      name: assertString(obj.name, `stateModel[${index}].name`),
      owner,
      type: assertString(obj.type, `stateModel[${index}].type`) as StructuredStateDefinition['type'],
      shape: assertObject(obj.shape, `stateModel[${index}].shape`),
      source: typeof obj.source === 'string' ? obj.source : undefined,
    };
  });

  const apiContracts = assertArray(spec.apiContracts, 'apiContracts').map((api, index) => {
    const obj = assertObject(api, `apiContracts[${index}]`);
    const routeFile = normalizePathValue(assertString(obj.routeFile, `apiContracts[${index}].routeFile`));
    return {
      name: assertString(obj.name, `apiContracts[${index}].name`),
      path: normalizePathValue(assertString(obj.path, `apiContracts[${index}].path`)),
      method: assertString(obj.method, `apiContracts[${index}].method`) as StructuredApiContract['method'],
      purpose: assertString(obj.purpose, `apiContracts[${index}].purpose`),
      backendRequired: assertBoolean(obj.backendRequired, `apiContracts[${index}].backendRequired`),
      routeFile,
      tableName: typeof obj.tableName === 'string' ? obj.tableName : undefined,
      queryNotes: typeof obj.queryNotes === 'string' ? obj.queryNotes : undefined,
    };
  });

  const filePlan = assertArray(spec.filePlan, 'filePlan').map((file, index) => {
    const obj = assertObject(file, `filePlan[${index}]`);
    const pathValue = normalizePathValue(assertString(obj.path, `filePlan[${index}].path`));
    if (!isValidFilePath(pathValue)) throw new Error(`filePlan[${index}].path is invalid: ${pathValue}`);
    return {
      path: pathValue,
      kind: assertString(obj.kind, `filePlan[${index}].kind`) as StructuredFilePlanEntry['kind'],
      purpose: assertString(obj.purpose, `filePlan[${index}].purpose`),
      dependsOn: unique(assertArray(obj.dependsOn ?? [], `filePlan[${index}].dependsOn`).map((dep, i) => assertString(dep, `filePlan[${index}].dependsOn[${i}]`))),
      owner: typeof obj.owner === 'string' ? obj.owner : undefined,
    };
  });

  const filePaths = new Set<string>();
  for (const entry of filePlan) {
    if (filePaths.has(entry.path)) throw new Error(`filePlan contains duplicate path ${entry.path}`);
    filePaths.add(entry.path);
  }

  for (const component of componentSchema) {
    if (!filePaths.has(component.filePath)) throw new Error(`component ${component.name} is missing a filePlan entry`);
  }

  const missingLayoutComponents = Array.from(layoutNames).filter((name) => name !== 'App' && !componentNames.has(name));
  if (missingLayoutComponents.length > 0) {
    throw new Error(`layoutTree references unknown components: ${missingLayoutComponents.join(', ')}`);
  }

  // Auto-add any components the LLM omitted from the layout tree as direct children of App.
  // Throwing here would make the spec fragile against LLM non-determinism across separate calls.
  const allLayoutNodes = new Set<string>(layoutNames);
  const unreachableComponents = componentSchema.filter((component) => !allLayoutNodes.has(component.name));
  if (unreachableComponents.length > 0) {
    for (const component of unreachableComponents) {
      layoutTree.children.push({
        name: component.name,
        type: 'component',
        component: component.name,
        props: {},
        children: [],
      });
    }
  }

  for (const state of stateModel) {
    if (state.owner !== 'App' && !componentNames.has(state.owner)) throw new Error(`state ${state.name} has invalid owner ${state.owner}`);
  }

  const backendRequired = Boolean(spec.backend_required);
  if (backendRequired) {
    for (const api of apiContracts) {
      if (!api.routeFile || !ROUTE_PATH_RE.test(api.routeFile)) {
        throw new Error(`api contract ${api.name} must map to a backend route file`);
      }
      if (!filePaths.has(api.routeFile)) throw new Error(`api contract ${api.name} route file is missing from filePlan: ${api.routeFile}`);
    }
  }

  if (hasCircularDependencies(filePlan)) throw new Error('filePlan contains circular dependencies');

  const edgeMap = collectLayoutEdges(layoutTree);
  for (const [parent, children] of edgeMap.entries()) {
    if (!parent.trim()) throw new Error('layoutTree contains an unnamed parent node');
    for (const child of children) {
      if (!componentNames.has(child) && child !== 'App') throw new Error(`layoutTree contains orphan node ${child}`);
    }
  }

  for (const entry of filePlan) {
    for (const dep of entry.dependsOn) {
      if (!isValidFilePath(dep)) throw new Error(`invalid file dependency ${dep} referenced by ${entry.path}`);
    }
  }

  return {
    componentSchema,
    stateModel,
    layoutTree,
    apiContracts,
    filePlan,
    backend_required: backendRequired,
    version: Number(spec.version ?? 1),
  };
}

function toPascalCase(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function deriveComponentName(source: string): string {
  if (!source || source === 'App') return 'App';
  const base = source.replace(/^src\/components\//, '').replace(/\.jsx$/, '');
  return toPascalCase(base);
}

function inferPropsForComponent(name: string, systemDesign: unknown, requirements: unknown): StructuredComponentProp[] {
  const props: StructuredComponentProp[] = [];
  const reqText = JSON.stringify(requirements ?? {}).toLowerCase();
  const designText = JSON.stringify(systemDesign ?? {}).toLowerCase();

  if (name !== 'App' && (/form|input|editor|modal|dialog/.test(name.toLowerCase()) || /form|input|editable/.test(reqText))) {
    props.push({
      name: 'value',
      type: 'string',
      required: false,
      source: 'state',
      description: 'Current controlled value',
    });
  }

  if (/list|table|cards|grid/.test(name.toLowerCase()) || /list|table|cards|grid/.test(reqText) || /list|table|cards|grid/.test(designText)) {
    props.push({
      name: 'items',
      type: 'array',
      required: true,
      source: 'api',
      description: 'Collection rendered by this component',
    });
  }

  return props;
}

function defaultLayoutFromComponents(components: StructuredComponentDefinition[]): StructuredLayoutNode {
  const childNodes = components
    .filter((component) => component.name !== 'App')
    .map((component) => ({
      name: component.name,
      type: 'component' as const,
      component: component.name,
      props: {},
      children: [],
    }));

  return {
    name: 'App',
    type: 'app',
    component: 'App',
    props: {},
    children: childNodes,
  };
}

export function compileStructuredSpec(input: {
  uiSpec: unknown;
  systemDesign: unknown;
  requirements: unknown;
}): StructuredSpec {
  const uiSpec = assertObject(input.uiSpec, 'uiSpec');
  const systemDesign = assertObject(input.systemDesign, 'systemDesign');
  const requirements = assertObject(input.requirements, 'requirements');

  const backendRequired = Boolean(
    requirements.backend_required ||
      requirements.auth_required ||
      systemDesign.backend ||
      (uiSpec as Record<string, unknown>).backend_required
  );

  const rawComponents = assertArray(uiSpec.components ?? [], 'uiSpec.components');
  const componentSchema: StructuredComponentDefinition[] = rawComponents.map((component, index) => {
    const obj = assertObject(component, `uiSpec.components[${index}]`);
    const name = toPascalCase(assertString(obj.name, `uiSpec.components[${index}].name`));
    const pathValue = normalizePathValue(assertString(obj.path ?? inferComponentFilePath(name), `uiSpec.components[${index}].path`));
    const purpose = assertString(obj.purpose ?? `${name} component`, `uiSpec.components[${index}].purpose`);
    const children = assertArray(obj.dependencies ?? [], `uiSpec.components[${index}].dependencies`).map((value, childIndex) =>
      deriveComponentName(assertString(value, `uiSpec.components[${index}].dependencies[${childIndex}]`))
    );
    const stateKeys = assertArray(obj.state ?? [], `uiSpec.components[${index}].state`).map((value, stateIndex) =>
      assertString(value, `uiSpec.components[${index}].state[${stateIndex}]`)
    );
    const propEntries = obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props) ? Object.entries(obj.props as Record<string, unknown>) : [];
    const props: StructuredComponentProp[] = propEntries.map(([propName, value]) => {
      const propObj = assertObject(value, `uiSpec.components[${index}].props.${propName}`);
      return {
        name: propName,
        type: assertString(propObj.type ?? 'string', `uiSpec.components[${index}].props.${propName}.type`),
        required: Boolean(propObj.required),
        source: typeof propObj.source === 'string' ? (propObj.source as StructuredComponentProp['source']) : undefined,
        description: typeof propObj.description === 'string' ? propObj.description : undefined,
      };
    });

    return {
      name,
      filePath: pathValue === 'src/App.jsx' ? 'src/App.jsx' : pathValue,
      purpose,
      props: props.length > 0 ? props : inferPropsForComponent(name, systemDesign, requirements),
      stateKeys,
      children,
      imports: children.map((child) => child),
      exportsDefault: true,
    };
  });

  if (!componentSchema.some((component) => component.name === 'App')) {
    componentSchema.unshift({
      name: 'App',
      filePath: 'src/App.jsx',
      purpose: 'Root application shell that composes all generated UI sections.',
      props: [],
      stateKeys: [],
      children: componentSchema.filter((component) => component.name !== 'App').map((component) => component.name),
      imports: componentSchema.filter((component) => component.name !== 'App').map((component) => component.name),
      exportsDefault: true,
    });
  }

  const layoutStructure = uiSpec.layoutStructure && typeof uiSpec.layoutStructure === 'object' ? (uiSpec.layoutStructure as Record<string, unknown>) : {};
  const compositionOrder = Array.isArray(layoutStructure.compositionOrder) ? layoutStructure.compositionOrder : [];
  const layoutTree = compositionOrder.length > 0
    ? {
        name: 'App',
        type: 'app' as const,
        component: 'App',
        props: {},
        children: compositionOrder
          .map((name: unknown) => toPascalCase(String(name)))
          .filter((name: string) => componentSchema.some((component) => component.name === name))
          .map((name: string) => ({
            name,
            type: 'component' as const,
            component: name,
            props: {},
            children: [],
          })),
      }
    : defaultLayoutFromComponents(componentSchema);

  const apiContracts: StructuredApiContract[] = [];
  const apiEntries = Array.isArray(uiSpec.apiContract) ? uiSpec.apiContract : [];
  for (let index = 0; index < apiEntries.length; index += 1) {
    const api = assertObject(apiEntries[index], `uiSpec.apiContract[${index}]`);
    const endpoint = normalizePathValue(assertString(api.endpoint ?? api.path ?? `/api/resource-${index + 1}`, `uiSpec.apiContract[${index}].endpoint`));
    const name = toPascalCase(String(api.name ?? endpoint.replace(/^\/api\//, '')));
    const routeSlug = endpoint.replace(/^\/api\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `resource-${index + 1}`;
    apiContracts.push({
      name,
      path: endpoint,
      method: assertString(api.method ?? 'GET', `uiSpec.apiContract[${index}].method`) as StructuredApiContract['method'],
      purpose: assertString(api.requestShape || api.responseShape ? 'API contract' : 'API', `uiSpec.apiContract[${index}].purpose`),
      backendRequired,
      routeFile: `backend/src/routes/${routeSlug}.ts`,
      tableName: 'items',
      queryNotes: 'Deterministic project-scoped route',
    });
  }

  const filePlan: StructuredFilePlanEntry[] = [
    { path: 'package.json', kind: 'config', purpose: 'Frontend package manifest', dependsOn: [] },
    { path: 'index.html', kind: 'entry', purpose: 'Frontend HTML entry', dependsOn: ['package.json'] },
    { path: 'vite.config.js', kind: 'config', purpose: 'Vite configuration', dependsOn: ['package.json'] },
    { path: 'src/main.jsx', kind: 'entry', purpose: 'React bootstrap', dependsOn: ['src/App.jsx', 'src/index.css'] },
    { path: 'src/App.jsx', kind: 'entry', purpose: 'Application composition root', dependsOn: componentSchema.map((component) => component.filePath) },
    { path: 'src/index.css', kind: 'style', purpose: 'Global stylesheet', dependsOn: ['src/App.jsx'] },
    ...componentSchema.map((component) => ({
      path: component.filePath,
      kind: 'component' as const,
      purpose: component.purpose,
      dependsOn: unique(component.children.map((child) => inferComponentFilePath(child))),
      owner: component.name,
    })),
  ];

  if (backendRequired) {
    filePlan.push(
      { path: 'backend/package.json', kind: 'config', purpose: 'Backend package manifest', dependsOn: [] },
      { path: 'backend/src/index.ts', kind: 'entry', purpose: 'Backend server entry', dependsOn: ['backend/src/db/database.ts', ...apiContracts.map((contract) => contract.routeFile)] },
      { path: 'backend/src/db/database.ts', kind: 'utility', purpose: 'Database access', dependsOn: [] },
      { path: 'backend/db/init.sql', kind: 'schema', purpose: 'Database schema', dependsOn: [] },
      ...apiContracts.map((contract) => ({
        path: contract.routeFile,
        kind: 'route' as const,
        purpose: contract.purpose,
        dependsOn: ['backend/src/db/database.ts'],
        owner: contract.name,
      }))
    );
  }

  return validateStructuredSpec({
    componentSchema,
    stateModel: Array.isArray(uiSpec.stateModel) ? uiSpec.stateModel : [],
    layoutTree,
    apiContracts,
    filePlan,
    backend_required: backendRequired,
    version: 1,
  });
}
