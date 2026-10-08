/**
 * Graphs: finding them in a snapshot, reading an algorithm's state off the
 * program's own variables, and laying them out.
 *
 * A graph can live in the program in a few shapes:
 *
 *   adjacency   graph = {"A": ["B", "C"], ...}       (found automatically)
 *               graph = {"A": {"B": 4}, ...}         weighted
 *               graph = {"A": [("B", 4)], ...}       weighted pairs
 *               adj = [[1, 2], [0], [0]]             by index (needs a hint)
 *   matrix      m = [[0, 1], [1, 0]]                 (needs a hint)
 *   edgelist    edges = [(0, 1), (1, 2)]             (needs a hint)
 *   objects     class Node: neighbors = [Node, ...]  (found automatically,
 *               class Trie: children = {"a": Trie}    also n-ary trees, tries)
 *
 * Everything here is pure: data in, data out. Drawing is render/graphView.ts.
 * Node keys are normalized so that a dict key and a list item that mean the
 * same node compare equal: "s:A" for strings, "n:3" for numbers, and the heap
 * id for object nodes.
 */
import { fieldsOf } from "./linked";
import type { GraphHint, GraphOption, HeapObject, Step, Trace, Value } from "./types";

export type Scope = [string, Value][];

export interface GraphEdge {
  from: string;
  to: string;
  /** A weight, or the key an object graph's dict link is stored under. */
  label?: string;
}

export interface GraphData {
  /** Stable across steps: "obj:<id>" for a container, "class:<Type>" for objects. */
  id: string;
  /** What it's called: the variable ("graph", "self.adj") or the class. */
  name: string;
  kind: "adjacency" | "matrix" | "edgelist" | "objects";
  /** The heap object the graph is drawn in place of. */
  hostId: string;
  /** Node key -> label, in a stable order. */
  nodes: Map<string, string>;
  edges: GraphEdge[];
  directed: boolean;
  /** Heap ids drawn as part of the graph: inner lists, or node objects and their neighbor lists. */
  members: Set<string>;
  objectNodes: boolean;
  layout: "auto" | "circle" | "layered" | "force";
  /** Names a hint asked to draw on the graph. */
  names: string[];
  /** Object graphs: true boolean fields per node (is_end, visited...). */
  flags: Map<string, string[]>;
}

const MAX_AUTO_NODES = 40;
const MAX_NODES = 60;

// ---------------------------------------------------------------------------
// Node keys
// ---------------------------------------------------------------------------

const NUMERIC = /^-?\d+(\.\d+)?$/;

function unquote(repr: string): string {
  const q = repr[0];
  if (repr.length >= 2 && (q === "'" || q === '"') && repr[repr.length - 1] === q) {
    return repr.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  return repr;
}

/** The node a primitive names, or null if it can't name one (bools, None...). */
export function primNodeKey(value: Value): string | null {
  if (value.kind !== "prim") return null;
  switch (value.type) {
    case "int":
    case "float":
    case "number": {
      const n = Number(value.repr);
      return Number.isFinite(n) ? `n:${n}` : null;
    }
    case "str":
      return `s:${unquote(value.repr)}`;
    // JavaScript object keys are always strings, so `graph[1]` and a key
    // "1" are the same node: numeric-looking strings count as numbers.
    case "string":
    case "key": {
      const text = value.type === "key" ? value.repr : unquote(value.repr);
      return NUMERIC.test(text) ? `n:${Number(text)}` : `s:${text}`;
    }
    default:
      return null;
  }
}

const labelOf = (key: string) => key.slice(2);

function primText(value: Value | undefined): string | undefined {
  if (!value || value.kind !== "prim") return undefined;
  return value.type === "str" || value.type === "string" ? unquote(value.repr) : value.repr;
}

const isNullish = (v: Value) => v.kind === "prim" && /^(None|null|undefined)$/.test(v.repr);
const isBool = (v: Value) => v.kind === "prim" && (v.type === "bool" || v.type === "boolean");
const isTrue = (v: Value) => isBool(v) && /^(True|true)$/.test((v as { repr: string }).repr);
const isSeq = (o: HeapObject | undefined): o is Extract<HeapObject, { kind: "list" | "tuple" | "set" }> =>
  o?.kind === "list" || o?.kind === "tuple" || o?.kind === "set";

// ---------------------------------------------------------------------------
// Finding graphs
// ---------------------------------------------------------------------------

/**
 * Every variable by name, inner scopes winning, plus one level into
 * instances (`self.adj`, `this.visited`).
 */
export function namedValues(scopes: Scope[], heap: Record<string, HeapObject>): Map<string, Value> {
  const named = new Map<string, Value>();
  for (const scope of scopes) for (const [name, value] of scope) named.set(name, value);
  for (const [name, value] of [...named]) {
    if (value.kind !== "ref") continue;
    const obj = heap[value.id];
    if (obj?.kind !== "object") continue;
    for (const [field, inner] of obj.fields) {
      const dotted = `${name}.${field}`;
      if (!named.has(dotted)) named.set(dotted, inner);
    }
  }
  return named;
}

const lastSegment = (name: string) => name.slice(name.lastIndexOf(".") + 1);

interface Built {
  nodes: Map<string, string>;
  edges: GraphEdge[];
  members: Set<string>;
}

/** A dict's value as a list of neighbors, or null if it isn't one. */
function neighborsOf(value: Value, heap: Record<string, HeapObject>, members: Set<string>): { to: string; label?: string }[] | null {
  if (value.kind !== "ref") return isNullish(value) ? [] : null;
  const inner = heap[value.id];
  if (isSeq(inner)) {
    const out: { to: string; label?: string }[] = [];
    for (const item of inner.items) {
      const key = primNodeKey(item);
      if (key) {
        out.push({ to: key });
        continue;
      }
      // (neighbor, weight) pairs
      const pair = item.kind === "ref" ? heap[item.id] : undefined;
      if ((pair?.kind !== "list" && pair?.kind !== "tuple") || pair.items.length < 2 || pair.items.length > 3) return null;
      const to = primNodeKey(pair.items[0]);
      if (!to) return null;
      members.add(pair.id);
      out.push({ to, label: primText(pair.items[1]) });
    }
    members.add(inner.id);
    return out;
  }
  if (inner?.kind === "dict") {
    const out: { to: string; label?: string }[] = [];
    for (const [k, v] of inner.entries) {
      const to = primNodeKey(k);
      if (!to || v.kind !== "prim") return null;
      out.push({ to, label: primText(v) });
    }
    members.add(inner.id);
    return out;
  }
  return null;
}

function fromDict(obj: Extract<HeapObject, { kind: "dict" }>, heap: Record<string, HeapObject>, strict: boolean): Built | null {
  const nodes = new Map<string, string>();
  const edges: GraphEdge[] = [];
  const members = new Set<string>();
  for (const [k] of obj.entries) {
    const key = primNodeKey(k);
    if (!key) return null;
    nodes.set(key, labelOf(key));
  }
  let known = 0;
  for (const [k, v] of obj.entries) {
    const from = primNodeKey(k)!;
    const neighbors = neighborsOf(v, heap, members);
    if (!neighbors) return null;
    for (const { to, label } of neighbors) {
      edges.push(label === undefined ? { from, to } : { from, to, label });
      if (nodes.has(to)) known++;
    }
  }
  // Automatically, a dict only counts when most neighbors are its own keys,
  // so {"fruit": ["apple"]} isn't mistaken for a graph.
  if (strict && (nodes.size < 2 || !edges.length || known * 2 < edges.length || nodes.size > MAX_AUTO_NODES)) return null;
  for (const edge of edges) if (!nodes.has(edge.to)) nodes.set(edge.to, labelOf(edge.to));
  return { nodes, edges, members };
}

function fromList(
  obj: Extract<HeapObject, { kind: "list" | "tuple" | "set" }>,
  heap: Record<string, HeapObject>,
  options: GraphOption[],
): (Built & { kind: GraphData["kind"] }) | null {
  const rows: Extract<HeapObject, { kind: "list" | "tuple" | "set" }>[] = [];
  for (const item of obj.items) {
    const row = item.kind === "ref" ? heap[item.id] : undefined;
    if (!isSeq(row)) return null;
    rows.push(row);
  }
  const nodes = new Map<string, string>();
  const edges: GraphEdge[] = [];
  const members = new Set<string>(rows.map((row) => row.id));
  const n = rows.length;
  const isTuples = rows.length > 0 && rows.every((row) => row.kind === "tuple" && row.items.length >= 2 && row.items.length <= 3);
  const square = n >= 2 && rows.every((row) => row.items.length === n && row.items.every((v) => v.kind === "prim"));

  if (options.includes("edgelist") || (!options.includes("matrix") && isTuples)) {
    for (const row of rows) {
      const [a, b, w] = row.items;
      const from = a && primNodeKey(a);
      const to = b && primNodeKey(b);
      if (!from || !to) return null;
      nodes.set(from, labelOf(from));
      nodes.set(to, labelOf(to));
      edges.push(w ? { from, to, label: primText(w) } : { from, to });
    }
    return { nodes, edges, members, kind: "edgelist" };
  }

  for (let i = 0; i < n; i++) nodes.set(`n:${i}`, String(i));
  if (options.includes("matrix") || square) {
    const weights = rows.flatMap((row) => row.items.map((v) => primText(v) ?? ""));
    const plain = weights.every((w) => /^(0|1|True|False|true|false|None|null|inf|Infinity|-1)$/.test(w));
    rows.forEach((row, i) => row.items.forEach((v, j) => {
      const text = primText(v) ?? "";
      if (/^(0|False|false|None|null|undefined|inf|Infinity|-inf|-Infinity|NaN|-1)$/.test(text) || text === "") return;
      edges.push(plain ? { from: `n:${i}`, to: `n:${j}` } : { from: `n:${i}`, to: `n:${j}`, label: text });
    }));
    return { nodes, edges, members, kind: "matrix" };
  }

  for (let i = 0; i < n; i++) {
    const neighbors = neighborsOf({ kind: "ref", id: rows[i].id }, heap, members);
    if (!neighbors) return null;
    for (const { to, label } of neighbors) {
      if (!nodes.has(to)) nodes.set(to, labelOf(to));
      edges.push(label === undefined ? { from: `n:${i}`, to } : { from: `n:${i}`, to, label });
    }
  }
  return { nodes, edges, members, kind: "adjacency" };
}

const typeOf = (obj: HeapObject | undefined) => (obj && fieldsOf(obj) ? obj.typeName : null);

/** Classes whose objects hold lists (or dicts) of objects of the same class. */
function linkClasses(heap: Record<string, HeapObject>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const obj of Object.values(heap)) {
    if (obj.kind !== "object") continue;
    for (const [field, value] of obj.fields) {
      const inner = value.kind === "ref" ? heap[value.id] : undefined;
      let links = false;
      if (isSeq(inner) && inner.items.length) {
        links = inner.items.every((item) => item.kind === "ref" && typeOf(heap[item.id]) === obj.typeName);
      } else if (inner?.kind === "dict" && inner.entries.length) {
        links = inner.entries.every(([k, v]) => k.kind === "prim" && v.kind === "ref" && typeOf(heap[v.id]) === obj.typeName);
      }
      if (!links) continue;
      const fields = found.get(obj.typeName) ?? [];
      if (!fields.includes(field)) found.set(obj.typeName, [...fields, field]);
    }
  }
  return found;
}

const idNumber = (id: string) => Number(id.replace(/\D/g, "")) || 0;

function objectGraph(
  heap: Record<string, HeapObject>,
  type: string,
  links: string[] | null,
  hint: GraphHint | null,
): GraphData | null {
  const objects = Object.values(heap)
    .filter((obj) => typeOf(obj) === type)
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
  if (!objects.length || (!hint && objects.length > MAX_AUTO_NODES)) return null;
  const fields = links ?? linkClasses(heap).get(type) ?? [];
  if (!fields.length) return null;
  const kept = objects.slice(0, MAX_NODES);
  const ids = new Set(kept.map((obj) => obj.id));
  const nodes = new Map<string, string>();
  const edges: GraphEdge[] = [];
  const members = new Set<string>();
  const flags = new Map<string, string[]>();

  // The label is the first field that's usually a plain value (not a flag).
  const allFields = [...new Set(kept.flatMap((obj) => fieldsOf(obj)!.map(([name]) => name)))].filter((f) => !fields.includes(f));
  const valueField = allFields.find((field) => {
    let prims = 0;
    let total = 0;
    for (const obj of kept) {
      const value = fieldsOf(obj)!.find(([n]) => n === field)?.[1];
      if (!value) continue;
      total++;
      if (value.kind === "prim" && !isBool(value) && !isNullish(value)) prims++;
    }
    return total > 0 && prims * 2 >= total;
  });

  for (const obj of kept) {
    const own = fieldsOf(obj)!;
    nodes.set(obj.id, primText(own.find(([n]) => n === valueField)?.[1]) ?? "");
    members.add(obj.id);
    const set = own.filter(([name, value]) => !fields.includes(name) && isTrue(value)).map(([name]) => name);
    if (set.length) flags.set(obj.id, set);
    for (const field of fields) {
      const value = own.find(([n]) => n === field)?.[1];
      if (value?.kind !== "ref") continue;
      if (ids.has(value.id)) {
        edges.push({ from: obj.id, to: value.id }); // a direct link named in a hint
        continue;
      }
      const inner = heap[value.id];
      if (isSeq(inner) || inner?.kind === "dict") members.add(inner.id); // drawn as edges
      if (isSeq(inner)) {
        for (const item of inner.items) if (item.kind === "ref" && ids.has(item.id)) edges.push({ from: obj.id, to: item.id });
      } else if (inner?.kind === "dict") {
        for (const [k, v] of inner.entries) {
          if (v.kind === "ref" && ids.has(v.id)) edges.push({ from: obj.id, to: v.id, label: primText(k) });
        }
      }
    }
  }
  return {
    id: `class:${type}`,
    name: type,
    kind: "objects",
    hostId: kept[0].id,
    nodes,
    edges,
    directed: isDirected(edges, hint?.options ?? []),
    members,
    objectNodes: true,
    layout: layoutOption(hint?.options ?? []),
    names: hint?.names ?? [],
    flags,
  };
}

function isDirected(edges: GraphEdge[], options: GraphOption[]): boolean {
  if (options.includes("directed")) return true;
  if (options.includes("undirected")) return false;
  const set = new Set(edges.map((e) => `${e.from}>${e.to}`));
  return edges.some((e) => e.from !== e.to && !set.has(`${e.to}>${e.from}`));
}

function layoutOption(options: GraphOption[]): GraphData["layout"] {
  return options.includes("circle") ? "circle" : options.includes("layered") ? "layered" : options.includes("force") ? "force" : "auto";
}

function containerGraph(
  obj: HeapObject,
  heap: Record<string, HeapObject>,
  name: string,
  hint: GraphHint | null,
): GraphData | null {
  const options = hint?.options ?? [];
  let built: (Built & { kind: GraphData["kind"] }) | null = null;
  if (obj.kind === "dict") {
    const b = fromDict(obj, heap, !hint);
    built = b && { ...b, kind: "adjacency" };
  } else if (hint && isSeq(obj)) {
    built = fromList(obj, heap, options);
  }
  if (!built || built.nodes.size > MAX_NODES) return null;
  return {
    id: `obj:${obj.id}`,
    name,
    kind: built.kind,
    hostId: obj.id,
    nodes: built.nodes,
    edges: built.edges,
    directed: isDirected(built.edges, options),
    members: built.members,
    objectNodes: false,
    layout: layoutOption(options),
    names: hint?.names ?? [],
    flags: new Map(),
  };
}

/**
 * Every graph in a snapshot. `scopes` are the variables in view, outermost
 * first (inner names win). Hinted graphs come first, then ones found
 * automatically: dicts of neighbor lists, and classes whose objects hold
 * lists or dicts of each other.
 */
export function findGraphs(trace: Trace, scopes: Scope[], heap: Record<string, HeapObject>): GraphData[] {
  const hints = trace.viz?.graphs ?? [];
  const plain = new Set(trace.viz?.plain ?? []);
  const linkedTypes = new Set((trace.viz?.linked ?? []).map((h) => h.typeName));
  const named = namedValues(scopes, heap);
  const out: GraphData[] = [];
  const used = new Set<string>();
  const add = (graph: GraphData | null) => {
    if (!graph || used.has(graph.id) || used.has(`obj:${graph.hostId}`)) return;
    used.add(graph.id);
    out.push(graph);
  };
  const lookup = (target: string): [string, Value] | undefined => {
    const exact = named.get(target);
    if (exact) return [target, exact];
    for (const [name, value] of named) if (name.endsWith(`.${target}`)) return [name, value];
    return undefined;
  };

  for (const hint of hints) {
    if (hint.fields) {
      add(objectGraph(heap, hint.target, hint.fields, hint));
      continue;
    }
    const found = lookup(hint.target);
    if (found && found[1].kind === "ref" && heap[found[1].id]) {
      add(containerGraph(heap[found[1].id], heap, found[0], hint));
    } else if (Object.values(heap).some((obj) => typeOf(obj) === hint.target)) {
      add(objectGraph(heap, hint.target, null, hint)); // a class, links found automatically
    }
  }
  for (const [name, value] of named) {
    if (value.kind !== "ref" || plain.has(name) || plain.has(lastSegment(name))) continue;
    const obj = heap[value.id];
    if (obj?.kind !== "dict" || used.has(`obj:${obj.id}`)) continue;
    add(containerGraph(obj, heap, name, null));
  }
  for (const [type, fields] of linkClasses(heap)) {
    if (plain.has(type) || linkedTypes.has(type)) continue;
    add(objectGraph(heap, type, fields, null));
  }
  return out;
}

/** The variables in view at a step, for findGraphs: paused frames, then the stack. */
export function stepScopes(step: Step): Scope[] {
  return [...(step.suspended ?? []), ...step.stack].map((frame) => frame.locals);
}

// ---------------------------------------------------------------------------
// The algorithm's state, read off its variables
// ---------------------------------------------------------------------------

export interface GraphOverlay {
  /** Nodes some collection marks as done: node -> what marked it. */
  visited: Map<string, string>;
  visitedNames: string[];
  /** Nodes waiting in a queue, stack or heap: node -> 0 for "comes out next". */
  frontier: Map<string, number>;
  frontierName: string | null;
  /** Per-node values (dist, depth...): node -> text. */
  labels: Map<string, string>;
  labelNames: string[];
  /** Edges a parent map draws (parent>child). */
  treeEdges: Set<string>;
  treeName: string | null;
  /** Edges a list of (a, b) pairs picks out, like a spanning tree. */
  chosenEdges: Set<string>;
  chosenName: string | null;
  /** Edges along a path list (a>b), and the nodes on it. */
  pathEdges: Set<string>;
  pathNodes: Set<string>;
  pathName: string | null;
  /** Variables pointing at a node. */
  pointers: Map<string, string[]>;
}

/** Names that hold "the current node" in graph code. */
const POINTER_NAMES = new Set([
  "node", "u", "v", "cur", "curr", "current", "start", "src", "source", "target", "dst", "dest", "goal", "end",
  "nb", "nbr", "nei", "next", "neighbor", "neighbour", "nxt", "next_node", "nextNode", "vertex", "vert", "at", "here",
  "root", "child", "parent", "word", "city", "room", "first", "last", "item", "task", "course", "job",
]);
const VISITED_NAMES = /visit|seen|done|explored|closed|finished|order|result|topo|sorted|output|^out$|^res$|marked|reached|removed/i;
const PATH_NAMES = /path|route|trail|walk|cycle|trip|tour/i;
const PARENT_NAMES = /parent|prev|pred|came|^from|via|back|^up$/i;
const LABEL_NAMES = /dist|depth|cost|level|^low|disc|^tin|^tout|indeg|in_deg|inDeg|degree|colou?r|time|rank|comp|group|size|count|score|^d$|^h$|^g$|^f$/i;
const STACK_NAMES = /stack|stk|dfs|todo/i;
const HEAP_NAMES = /heap|pq|prio|frontier|open/i;
const QUEUE_NAMES = /queue|^q$|bfs|deque|ready|waiting/i;
const EDGE_NAMES = /mst|tree|span|chosen|picked|used|edge|matching|cut|bridges/i;

export function emptyOverlay(): GraphOverlay {
  return {
    visited: new Map(), visitedNames: [], frontier: new Map(), frontierName: null,
    labels: new Map(), labelNames: [], treeEdges: new Set(), treeName: null, chosenEdges: new Set(), chosenName: null,
    pathEdges: new Set(), pathNodes: new Set(), pathName: null, pointers: new Map(),
  };
}

export function graphOverlay(trace: Trace, graph: GraphData, scopes: Scope[], heap: Record<string, HeapObject>): GraphOverlay {
  const overlay = emptyOverlay();
  const named = namedValues(scopes, heap);
  const explicit = new Set(graph.names);

  const nodeOf = (value: Value): string | null => {
    if (graph.objectNodes) return value.kind === "ref" && graph.nodes.has(value.id) ? value.id : null;
    const key = primNodeKey(value);
    return key && graph.nodes.has(key) ? key : null;
  };
  // A queue or heap entry may be a (priority, node) or [node, dist] pair.
  const itemNode = (value: Value): string | null => {
    const direct = nodeOf(value);
    if (direct || value.kind !== "ref") return direct;
    const pair = heap[value.id];
    if ((pair?.kind !== "list" && pair?.kind !== "tuple") || pair.items.length < 2 || pair.items.length > 3 || graph.members.has(pair.id)) return null;
    for (let i = pair.items.length - 1; i >= 0; i--) {
      const node = nodeOf(pair.items[i]);
      if (node) return node;
    }
    return null;
  };
  const pointerNames = new Set([
    ...POINTER_NAMES, ...explicit,
    ...(trace.indexNames[graph.name] ?? []), ...(trace.indexNames[lastSegment(graph.name)] ?? []),
    ...(trace.viz?.pointers[graph.name] ?? []), ...(trace.viz?.pointers[lastSegment(graph.name)] ?? []),
  ]);
  const addPointer = (node: string, name: string) => overlay.pointers.set(node, [...(overlay.pointers.get(node) ?? []), name]);
  const markVisited = (nodes: string[], name: string) => {
    if (!nodes.length) return;
    for (const node of nodes) if (!overlay.visited.has(node)) overlay.visited.set(node, name);
    if (!overlay.visitedNames.includes(name)) overlay.visitedNames.push(name);
  };
  const addLabels = (entries: [string, string][], name: string) => {
    if (!entries.length) return;
    overlay.labelNames.push(name);
    for (const [node, text] of entries) {
      const before = overlay.labels.get(node);
      overlay.labels.set(node, before === undefined ? text : `${before} · ${text}`);
    }
  };
  const addTree = (pairs: [string, string][], name: string) => {
    if (!pairs.length || overlay.treeName) return;
    overlay.treeName = name;
    for (const [parent, child] of pairs) overlay.treeEdges.add(`${parent}>${child}`);
  };
  // Nodes 0..n-1: arrays of length n can hold one value per node.
  const keys = [...graph.nodes.keys()];
  const byIndex = !graph.objectNodes && keys.every((k) => k.startsWith("n:")) &&
    keys.map((k) => Number(k.slice(2))).sort((a, b) => a - b).every((n, i) => n === i);

  /** An array with one entry per node (index graphs): true if it was used. */
  const perNode = (name: string, items: Value[]): boolean => {
    const base = lastSegment(name);
    if (items.every(isBool)) {
      markVisited(items.flatMap((v, i) => (isTrue(v) ? [`n:${i}`] : [])), name);
      return true;
    }
    if (PARENT_NAMES.test(base) && items.every((v) => nodeOf(v) || isNullish(v) || primText(v) === "-1")) {
      addTree(items.flatMap((v, i) => {
        const parent = nodeOf(v);
        return parent && primText(v) !== "-1" && parent !== `n:${i}` ? [[parent, `n:${i}`] as [string, string]] : [];
      }), name);
      return true;
    }
    if (LABEL_NAMES.test(base) || items.some((v) => v.kind !== "prim" || !nodeOf(v))) {
      if (items.every((v) => v.kind === "prim")) addLabels(items.map((v, i) => [`n:${i}`, primText(v) ?? ""]), name);
      return true;
    }
    return false;
  };

  for (const [name, value] of named) {
    const base = lastSegment(name);
    if (value.kind === "prim") {
      const node = nodeOf(value);
      if (node && (pointerNames.has(name) || pointerNames.has(base))) addPointer(node, name);
      continue;
    }
    if (value.id === graph.hostId && !graph.objectNodes) continue;
    if (graph.objectNodes && graph.nodes.has(value.id)) {
      addPointer(value.id, name); // a variable holding a node object
      continue;
    }
    if (graph.members.has(value.id)) continue;
    // A node's own fields (paris.roads) are part of the graph, not state.
    const owner = name.includes(".") ? named.get(name.slice(0, name.indexOf("."))) : undefined;
    if (owner?.kind === "ref" && graph.members.has(owner.id)) continue;
    const obj = heap[value.id];
    if (!obj) continue;

    if (isSeq(obj)) {
      if (byIndex && obj.kind !== "set" && obj.items.length === graph.nodes.size && perNode(name, obj.items)) continue;
      if (!obj.items.length) continue;
      // A list of (a, b, ...) edges: a spanning tree, a matching.
      if (EDGE_NAMES.test(base) && !overlay.chosenName) {
        const pairs = obj.items.map((v) => {
          const pair = v.kind === "ref" ? heap[v.id] : undefined;
          if ((pair?.kind !== "list" && pair?.kind !== "tuple") || pair.items.length < 2) return null;
          const a = nodeOf(pair.items[0]);
          const b = nodeOf(pair.items[1]);
          return a && b ? `${a}>${b}` : null;
        });
        if (pairs.every(Boolean)) {
          overlay.chosenName = name;
          for (const pair of pairs) overlay.chosenEdges.add(pair!);
          continue;
        }
      }
      const nodes = obj.items.map(itemNode);
      if (nodes.some((n) => !n)) continue;
      const list = nodes as string[];
      if (obj.kind === "set" || VISITED_NAMES.test(base)) {
        markVisited(list, name);
      } else if (PATH_NAMES.test(base)) {
        if (overlay.pathName) continue;
        overlay.pathName = name;
        list.forEach((node, i) => {
          overlay.pathNodes.add(node);
          if (i > 0) overlay.pathEdges.add(`${list[i - 1]}>${node}`);
        });
      } else if (!overlay.frontierName) {
        overlay.frontierName = name;
        // Which entry comes out next: a stack pops the end, a heap the
        // smallest priority, a queue the front.
        let order = list.map((node, i) => ({ node, rank: i }));
        const prioritized = obj.items.every((v) => {
          const pair = v.kind === "ref" ? heap[v.id] : undefined;
          return (pair?.kind === "list" || pair?.kind === "tuple") && Number.isFinite(Number(primText(pair.items[0])));
        });
        const isQueue = QUEUE_NAMES.test(base) || obj.typeName === "deque";
        if (STACK_NAMES.test(base) && !HEAP_NAMES.test(base)) order = list.map((node, i) => ({ node, rank: list.length - 1 - i }));
        else if (HEAP_NAMES.test(base) || (prioritized && !isQueue)) {
          const priority = (v: Value) => {
            const pair = v.kind === "ref" ? heap[v.id] : undefined;
            return pair && (pair.kind === "list" || pair.kind === "tuple") ? Number(primText(pair.items[0])) : 0;
          };
          order = obj.items.map((v, i) => ({ node: list[i], rank: priority(v) + i * 1e-9 }))
            .sort((a, b) => a.rank - b.rank).map((entry, i) => ({ node: entry.node, rank: i }));
        }
        for (const { node, rank } of order) {
          if (!overlay.frontier.has(node) || overlay.frontier.get(node)! > rank) overlay.frontier.set(node, rank);
        }
        // Positions, counting from 0, with no gaps from duplicates.
        const ranked = [...overlay.frontier].sort((a, b) => a[1] - b[1]);
        ranked.forEach(([node], i) => overlay.frontier.set(node, i));
      }
      continue;
    }

    if (obj.kind === "dict" && obj.entries.length) {
      const nodes = obj.entries.map(([k]) => nodeOf(k));
      if (nodes.some((n) => !n)) continue;
      const values = obj.entries.map(([, v]) => v);
      if (values.every(isBool)) {
        markVisited(obj.entries.flatMap(([, v], i) => (isTrue(v) ? [nodes[i]!] : [])), name);
      } else if (PARENT_NAMES.test(base) && values.every((v) => nodeOf(v) || isNullish(v))) {
        addTree(values.flatMap((v, i) => {
          const parent = nodeOf(v);
          return parent && parent !== nodes[i] ? [[parent, nodes[i]!] as [string, string]] : [];
        }), name);
      } else if (values.every((v) => v.kind === "prim")) {
        addLabels(values.map((v, i) => [nodes[i]!, primText(v) ?? ""]), name);
      }
    }
  }

  // Object graphs: true boolean fields (is_end, visited) mark their node.
  for (const [node, set] of graph.flags) {
    for (const flag of set) markVisited([node], flag);
  }
  return overlay;
}

/** What a node looks like in an overlay, for "did this node change?". */
export function nodeSignature(overlay: GraphOverlay, node: string): string {
  return [overlay.visited.has(node) ? "v" : "", overlay.frontier.get(node) ?? "", overlay.labels.get(node) ?? "",
    overlay.pathNodes.has(node) ? "p" : ""].join("|");
}

/** Changes whenever anything drawn for the graph changes. */
export function graphSignature(graph: GraphData | undefined, overlay: GraphOverlay | undefined): string {
  if (!graph) return "";
  const nodes = [...graph.nodes.keys()].map((node) => `${node}=${overlay ? nodeSignature(overlay, node) : ""}`).join(",");
  const edges = graph.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ""}`).join(",");
  const extra = overlay ? [...overlay.treeEdges, ...overlay.pathEdges, ...overlay.chosenEdges].join(",") : "";
  return `${nodes}#${edges}#${extra}`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface GraphLayout {
  /** Node key -> position in layout units (about one node apart). */
  pos: Map<string, { x: number; y: number }>;
  mode: "circle" | "layered" | "force";
}

/** Each node's neighbors, ignoring direction. */
function undirectedNeighbors(nodes: string[], edges: GraphEdge[]): Map<string, Set<string>> {
  const adj = new Map(nodes.map((n) => [n, new Set<string>()]));
  for (const e of edges) {
    if (e.from === e.to || !adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  return adj;
}

/** Longest-path layers for a DAG, or null if there's a cycle. */
function dagLayers(nodes: string[], edges: GraphEdge[]): Map<string, number> | null {
  const out = new Map(nodes.map((n) => [n, [] as string[]]));
  const indegree = new Map(nodes.map((n) => [n, 0]));
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to)) continue;
    if (e.from === e.to) return null;
    out.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const depth = new Map(nodes.map((n) => [n, 0]));
  const ready = nodes.filter((n) => indegree.get(n) === 0);
  let seen = 0;
  while (ready.length) {
    const n = ready.shift()!;
    seen++;
    for (const m of out.get(n)!) {
      depth.set(m, Math.max(depth.get(m)!, depth.get(n)! + 1));
      indegree.set(m, indegree.get(m)! - 1);
      if (indegree.get(m) === 0) ready.push(m);
    }
  }
  return seen === nodes.length ? depth : null;
}

/** BFS layers for an undirected forest, or null if there's a cycle. */
function forestLayers(nodes: string[], edges: GraphEdge[]): Map<string, number> | null {
  const adj = undirectedNeighbors(nodes, edges);
  const unique = new Set<string>();
  for (const [n, set] of adj) for (const m of set) unique.add(n < m ? `${n}|${m}` : `${m}|${n}`);
  const depth = new Map<string, number>();
  let components = 0;
  for (const root of nodes) {
    if (depth.has(root)) continue;
    components++;
    depth.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) {
        if (depth.has(m)) continue;
        depth.set(m, depth.get(n)! + 1);
        queue.push(m);
      }
    }
  }
  return unique.size === nodes.length - components ? depth : null;
}

function layered(nodes: string[], edges: GraphEdge[], depth: Map<string, number>): Map<string, { x: number; y: number }> {
  const adj = undirectedNeighbors(nodes, edges);
  const levels: string[][] = [];
  // Initial order within a level: depth-first discovery, so subtrees stay together.
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    (levels[depth.get(n)!] ??= []).push(n);
    for (const m of adj.get(n)!) if (depth.get(m)! > depth.get(n)!) visit(m);
  };
  for (const n of nodes) if (depth.get(n) === 0) visit(n);
  for (const n of nodes) visit(n);

  const x = new Map<string, number>();
  for (const level of levels) level?.forEach((n, i) => x.set(n, i));
  const neighborsIn = (n: string, level: number) => [...adj.get(n)!].filter((m) => depth.get(m) === level);
  const place = (level: string[], toward: number) => {
    // Order by the average position of neighbors in the level `toward`...
    const want = new Map(level.map((n) => {
      const ns = neighborsIn(n, toward);
      return [n, ns.length ? ns.reduce((sum, m) => sum + x.get(m)!, 0) / ns.length : x.get(n)!];
    }));
    level.sort((a, b) => want.get(a)! - want.get(b)! || x.get(a)! - x.get(b)!);
    // ...then sit as close to that as a gap of 1 allows, centered on it.
    let cursor = -Infinity;
    const placed = level.map((n) => (cursor = Math.max(want.get(n)!, cursor + 1)));
    const shift = level.reduce((sum, n, i) => sum + placed[i] - want.get(n)!, 0) / Math.max(1, level.length);
    level.forEach((n, i) => x.set(n, placed[i] - shift));
  };
  for (let round = 0; round < 4; round++) {
    for (let d = 1; d < levels.length; d++) if (levels[d]) place(levels[d], d - 1);
    for (let d = levels.length - 2; d >= 0; d--) if (levels[d]) place(levels[d], d + 1);
  }
  const minX = Math.min(...x.values());
  return new Map(nodes.map((n) => [n, { x: x.get(n)! - minX, y: depth.get(n)! }]));
}

function circle(nodes: string[]): Map<string, { x: number; y: number }> {
  if (nodes.length <= 2) return new Map(nodes.map((n, i) => [n, { x: i * 1.4, y: 0 }]));
  const r = Math.max(0.9, (nodes.length * 1.25) / (2 * Math.PI));
  return new Map(nodes.map((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
    return [n, { x: r + r * Math.cos(a), y: r + r * Math.sin(a) }];
  }));
}

/** Fruchterman-Reingold, started from a circle so it's the same every run. */
function force(nodes: string[], edges: GraphEdge[]): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const start = circle(nodes);
  const p = nodes.map((node) => ({ ...start.get(node)! }));
  const index = new Map(nodes.map((node, i) => [node, i]));
  const adj = undirectedNeighbors(nodes, edges);
  const pairs: [number, number][] = [];
  for (const [a, set] of adj) for (const b of set) if (a < b) pairs.push([index.get(a)!, index.get(b)!]);
  const k = 1;
  let t = Math.max(0.5, n / 6);
  const iterations = 300;
  for (let it = 0; it < iterations; it++) {
    const d = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) { dx = 0.01 * (i - j); dy = 0.01; dist = Math.hypot(dx, dy); }
        const f = (k * k) / dist;
        d[i].x += (dx / dist) * f; d[i].y += (dy / dist) * f;
        d[j].x -= (dx / dist) * f; d[j].y -= (dy / dist) * f;
      }
    }
    for (const [i, j] of pairs) {
      const dx = p[i].x - p[j].x;
      const dy = p[i].y - p[j].y;
      const dist = Math.max(1e-6, Math.hypot(dx, dy));
      const f = (dist * dist) / k;
      d[i].x -= (dx / dist) * f; d[i].y -= (dy / dist) * f;
      d[j].x += (dx / dist) * f; d[j].y += (dy / dist) * f;
    }
    // A little gravity keeps separate pieces from drifting apart.
    const cx = p.reduce((s, q) => s + q.x, 0) / n;
    const cy = p.reduce((s, q) => s + q.y, 0) / n;
    for (let i = 0; i < n; i++) {
      d[i].x -= (p[i].x - cx) * 0.08;
      d[i].y -= (p[i].y - cy) * 0.08;
      const len = Math.hypot(d[i].x, d[i].y);
      if (len > 0) {
        p[i].x += (d[i].x / len) * Math.min(len, t);
        p[i].y += (d[i].y / len) * Math.min(len, t);
      }
    }
    t = Math.max(0.01, t * 0.985);
  }
  // Turn the picture so its long side is horizontal.
  const cx = p.reduce((s, q) => s + q.x, 0) / n;
  const cy = p.reduce((s, q) => s + q.y, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of p) { sxx += (q.x - cx) ** 2; syy += (q.y - cy) ** 2; sxy += (q.x - cx) * (q.y - cy); }
  const angle = -0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (const q of p) {
    const x = q.x - cx, y = q.y - cy;
    q.x = x * cos - y * sin;
    q.y = x * sin + y * cos;
  }
  // One edge is about one unit long, and no two nodes sit closer than 0.9.
  const lengths = pairs.map(([i, j]) => Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
  const scale = lengths.length ? 1.15 / (lengths.reduce((a, b) => a + b, 0) / lengths.length) : 1;
  for (const q of p) { q.x *= scale; q.y *= scale; }
  for (let round = 0; round < 60; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[j].x - p[i].x;
        const dy = p[j].y - p[i].y;
        const dist = Math.hypot(dx, dy);
        if (dist >= 0.9) continue;
        const push = (0.9 - dist) / 2 + 0.001;
        const ux = dist > 1e-6 ? dx / dist : 1;
        const uy = dist > 1e-6 ? dy / dist : 0;
        p[i].x -= ux * push; p[i].y -= uy * push;
        p[j].x += ux * push; p[j].y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const minX = Math.min(...p.map((q) => q.x));
  const minY = Math.min(...p.map((q) => q.y));
  return new Map(nodes.map((node, i) => [node, { x: p[i].x - minX, y: p[i].y - minY }]));
}

/** Lay out a graph. Trees and DAGs get layers; everything else is force-directed. */
export function computeLayout(nodes: string[], edges: GraphEdge[], directed: boolean, mode: GraphData["layout"] = "auto"): GraphLayout {
  if (nodes.length === 0) return { pos: new Map(), mode: "circle" };
  if (mode === "circle") return { pos: circle(nodes), mode: "circle" };
  const layers = directed ? dagLayers(nodes, edges) : forestLayers(nodes, edges);
  if (mode === "layered") {
    const depth = layers ?? forestLayers(nodes, edges) ?? bfsDepths(nodes, edges);
    return { pos: layered(nodes, edges, depth), mode: "layered" };
  }
  if (mode === "auto" && layers && edges.length) return { pos: layered(nodes, edges, layers), mode: "layered" };
  if (nodes.length <= 2) return { pos: circle(nodes), mode: "circle" };
  return { pos: force(nodes, edges), mode: "force" };
}

/** Layers by distance from each component's first node, for any graph. */
function bfsDepths(nodes: string[], edges: GraphEdge[]): Map<string, number> {
  const adj = undirectedNeighbors(nodes, edges);
  const depth = new Map<string, number>();
  for (const root of nodes) {
    if (depth.has(root)) continue;
    depth.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) if (!depth.has(m)) { depth.set(m, depth.get(n)! + 1); queue.push(m); }
    }
  }
  return depth;
}

/**
 * One layout per graph for the whole run, made from every node and edge the
 * graph ever has, so nodes stay put from step to step (and between the
 * memory view and the loop history) while the graph is built up.
 */
const layouts = new WeakMap<Trace, Map<string, GraphLayout>>();
/** Every kind of state drawn on each graph during the run, for a steady legend. */
const legends = new WeakMap<Trace, Map<string, GraphOverlay[]>>();

/**
 * The overlays a graph's legend should cover: one for each different set of
 * names seen during the run, so the legend (and the picture's size) stays
 * the same from the first step to the last.
 */
export function legendOverlaysFor(trace: Trace, graph: GraphData): GraphOverlay[] {
  layoutFor(trace, graph);
  return legends.get(trace)?.get(graph.id) ?? [];
}

export function layoutFor(trace: Trace, graph: GraphData): GraphLayout {
  let byId = layouts.get(trace);
  if (!byId) {
    byId = new Map();
    layouts.set(trace, byId);
    const legendById = new Map<string, Map<string, GraphOverlay>>();
    const union = new Map<string, { nodes: Map<string, true>; edges: Map<string, GraphEdge>; directed: boolean; layout: GraphData["layout"] }>();
    for (const step of trace.steps) {
      for (const g of findGraphs(trace, stepScopes(step), step.heap)) {
        const o = graphOverlay(trace, g, stepScopes(step), step.heap);
        const names = { ...emptyOverlay(), visitedNames: o.visitedNames, frontierName: o.frontierName, labelNames: o.labelNames,
          treeName: o.treeName, pathName: o.pathName, chosenName: o.chosenName };
        const seen = legendById.get(g.id) ?? new Map<string, GraphOverlay>();
        seen.set(JSON.stringify([names.visitedNames, names.frontierName, names.labelNames, names.treeName, names.pathName, names.chosenName]), names);
        legendById.set(g.id, seen);
        const entry = union.get(g.id) ?? { nodes: new Map(), edges: new Map(), directed: false, layout: g.layout };
        for (const node of g.nodes.keys()) entry.nodes.set(node, true);
        for (const e of g.edges) entry.edges.set(`${e.from}>${e.to}`, e);
        entry.directed ||= g.directed;
        union.set(g.id, entry);
      }
    }
    for (const [id, entry] of union) {
      byId.set(id, computeLayout([...entry.nodes.keys()], [...entry.edges.values()], entry.directed, entry.layout));
    }
    legends.set(trace, new Map([...legendById].map(([id, seen]) => [id, [...seen.values()]])));
  }
  const known = byId.get(graph.id);
  if (known && [...graph.nodes.keys()].every((node) => known.pos.has(node))) return known;
  // A graph found only in this view (say, from a loop's own frame): lay it out alone.
  const own = computeLayout([...graph.nodes.keys()], graph.edges, graph.directed, graph.layout);
  byId.set(graph.id, own);
  return own;
}

/** Steps' graphs, for the memory view: everything in view at a step. */
export function graphsAt(trace: Trace, step: Step): GraphData[] {
  return findGraphs(trace, stepScopes(step), step.heap);
}

