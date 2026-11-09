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

import { computeLayout, type GraphLayout } from "./graphLayout";
import { fieldsOf } from "./linked";
import type { GraphHint, GraphOption, HeapObject, Step, Trace, Value } from "./types";
import { finishNow, stepOf, type Work } from "./work";

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
  /**
   * How edges are drawn (render/graphView.ts): "auto" (straight, or curving
   * around nodes when they must), "straight", "curved" or "angled" (right
   * angles). A hint's option.
   */
  edgeStyle: EdgeStyle;
  /** Layers left to right instead of top to bottom (a hint's `sideways`). */
  sideways: boolean;
  /** Names a hint asked to draw on the graph. */
  names: string[];
  /** Object graphs: true boolean fields per node (is_end, visited...). */
  flags: Map<string, string[]>;
  /**
   * Drawn as clusters (scene/graphClusters.ts): these nodes each stand for
   * several of the graph's, by key; clicking one opens it.
   */
  clusters?: ReadonlyMap<string, { key: string; members: readonly string[] }>;
}

/**
 * The most nodes a graph found in a dict (automatically) or a list (with a
 * hint) may have: as many as a graph of node objects, since past the detail
 * budget a big one is drawn as clusters (scene/graphClusters.ts).
 */
const MAX_AUTO_NODES = 500;
const MAX_NODES = 500;
/**
 * Graphs of node objects can be much bigger: past the detail budget they're
 * drawn as clusters (graphClusters.ts), so a few hundred people linked as
 * friends are one box, not hundreds.
 */
const MAX_OBJECT_NODES = 500;

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
  if (value?.kind !== "prim") return undefined;
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
function neighborsOf(
  value: Value,
  heap: Record<string, HeapObject>,
  members: Set<string>,
): { to: string; label?: string }[] | null {
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
      if ((pair?.kind !== "list" && pair?.kind !== "tuple") || pair.items.length < 2 || pair.items.length > 3)
        return null;
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

function fromDict(
  obj: Extract<HeapObject, { kind: "dict" }>,
  heap: Record<string, HeapObject>,
  strict: boolean,
): Built | null {
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
  if (strict && (nodes.size < 2 || !edges.length || known * 2 < edges.length || nodes.size > MAX_AUTO_NODES))
    return null;
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
  const isTuples =
    rows.length > 0 && rows.every((row) => row.kind === "tuple" && row.items.length >= 2 && row.items.length <= 3);
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
    rows.forEach((row, i) => {
      row.items.forEach((v, j) => {
        const text = primText(v) ?? "";
        if (/^(0|False|false|None|null|undefined|inf|Infinity|-inf|-Infinity|NaN|-1)$/.test(text) || text === "")
          return;
        edges.push(plain ? { from: `n:${i}`, to: `n:${j}` } : { from: `n:${i}`, to: `n:${j}`, label: text });
      });
    });
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
  const known = sameHeap(heap);
  if (known.links) return known.links;
  const found = new Map<string, string[]>();
  known.links = found;
  for (const obj of known.objects) {
    if (obj.kind !== "object") continue;
    for (const field of linkFields(obj, heap)) {
      const fields = found.get(obj.typeName) ?? [];
      if (!fields.includes(field)) found.set(obj.typeName, [...fields, field]);
    }
  }
  return found;
}

/**
 * An object's fields that hold a list or dict of objects of its own class,
 * kept with the object while what those fields hold is the same (objects
 * are shared between steps until they change).
 */
const objectLinks = new WeakMap<HeapObject, { inners: (HeapObject | undefined)[]; fields: string[] }>();

function linkFields(obj: Extract<HeapObject, { kind: "object" }>, heap: Record<string, HeapObject>): string[] {
  const inners = obj.fields.map(([, value]) => (value.kind === "ref" ? heap[value.id] : undefined));
  const known = objectLinks.get(obj);
  if (known && sameObjects(known.inners, inners)) return known.fields;
  const fields: string[] = [];
  obj.fields.forEach(([field], i) => {
    const inner = inners[i];
    let links = false;
    if (isSeq(inner) && inner.items.length) {
      links = inner.items.every((item) => item.kind === "ref" && typeOf(heap[item.id]) === obj.typeName);
    } else if (inner?.kind === "dict" && inner.entries.length) {
      links = inner.entries.every(
        ([k, v]) => k.kind === "prim" && v.kind === "ref" && typeOf(heap[v.id]) === obj.typeName,
      );
    }
    if (links) fields.push(field);
  });
  objectLinks.set(obj, { inners, fields });
  return fields;
}

const idNumbers = new Map<string, number>();
const idNumber = (id: string) => {
  let n = idNumbers.get(id);
  if (n === undefined) {
    n = Number(id.replace(/\D/g, "")) || 0;
    if (idNumbers.size > 100_000) idNumbers.clear();
    idNumbers.set(id, n);
  }
  return n;
};

/**
 * The last graph of node objects made for each class (and links, and hint),
 * with the objects it was made from. A step that left them all the same
 * objects (a run shares unchanged objects between steps) gets the same
 * graph: a few hundred nodes isn't built again at every step.
 */
const lastObjectGraphs = new Map<
  string,
  { objects: HeapObject[]; inners: (HeapObject | undefined)[]; graph: GraphData | null }
>();

const sameObjects = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What's worked out about a heap, kept while the steps' heaps hold the same
 * objects: most steps change only variables, and a run shares unchanged
 * objects between steps, so a step whose heap has every one of the last
 * one's objects (and no others) gets the last one's answers.
 */
/** The heap's objects of a class, in the order they were made: once per heap (sameHeap). */
function objectsOfType(heap: Record<string, HeapObject>, type: string): HeapObject[] {
  const facts = sameHeap(heap);
  if (!facts.byType) {
    facts.byType = new Map();
    for (const obj of facts.objects) {
      const t = typeOf(obj);
      if (!t) continue;
      const list = facts.byType.get(t);
      if (list) list.push(obj);
      else facts.byType.set(t, [obj]);
    }
    // In id order; a class with more objects than a graph takes is only counted (objectGraphOf), so not sorted.
    for (const list of facts.byType.values())
      if (list.length <= MAX_OBJECT_NODES) list.sort((a, b) => idNumber(a.id) - idNumber(b.id));
  }
  return facts.byType.get(type) ?? [];
}

interface HeapFacts {
  /** The last heap record compared (the same record is asked about several times a step). */
  heap: Record<string, HeapObject>;
  objects: HeapObject[];
  links?: Map<string, string[]>;
  byType?: Map<string, HeapObject[]>;
  graphs: Map<string, GraphData | null>;
}
let lastHeap: HeapFacts | null = null;

function sameHeap(heap: Record<string, HeapObject>): HeapFacts {
  const known = lastHeap;
  if (known?.heap === heap) return known;
  // Each object knows its id: the same objects in the same order are the same heap.
  const objects = Object.values(heap);
  if (known && sameObjects(known.objects, objects)) {
    known.heap = heap;
    return known;
  }
  const facts: HeapFacts = { heap, objects, graphs: new Map() };
  lastHeap = facts;
  return facts;
}

function objectGraph(
  heap: Record<string, HeapObject>,
  type: string,
  links: string[] | null,
  hint: GraphHint | null,
): GraphData | null {
  const facts = sameHeap(heap);
  const factKey = `${type}|${links?.join(",") ?? ""}|${hint ? JSON.stringify(hint) : ""}`;
  if (facts.graphs.has(factKey)) return facts.graphs.get(factKey)!;
  const graph = objectGraphOf(heap, type, links, hint);
  facts.graphs.set(factKey, graph);
  return graph;
}

function objectGraphOf(
  heap: Record<string, HeapObject>,
  type: string,
  links: string[] | null,
  hint: GraphHint | null,
): GraphData | null {
  const objects = objectsOfType(heap, type);
  if (!objects.length || objects.length > MAX_OBJECT_NODES) return null;
  const fields = links ?? linkClasses(heap).get(type) ?? [];
  if (!fields.length) return null;
  const memoKey = `${type}|${fields.join(",")}|${hint ? JSON.stringify(hint) : ""}`;
  const inners: (HeapObject | undefined)[] = [];
  for (const obj of objects)
    for (const [name, value] of fieldsOf(obj)!)
      if (fields.includes(name) && value.kind === "ref") inners.push(heap[value.id]);
  const last = lastObjectGraphs.get(memoKey);
  if (last && sameObjects(last.objects, objects) && sameObjects(last.inners, inners)) return last.graph;
  const graph = buildObjectGraph(heap, type, objects, fields, hint);
  lastObjectGraphs.set(memoKey, { objects, inners, graph });
  return graph;
}

function buildObjectGraph(
  heap: Record<string, HeapObject>,
  type: string,
  objects: HeapObject[],
  fields: string[],
  hint: GraphHint | null,
): GraphData | null {
  const kept = objects;
  const ids = new Set(kept.map((obj) => obj.id));
  const nodes = new Map<string, string>();
  const edges: GraphEdge[] = [];
  const members = new Set<string>();
  const flags = new Map<string, string[]>();

  // The label is the first field that's usually a plain value (not a flag).
  const allFields = [...new Set(kept.flatMap((obj) => fieldsOf(obj)!.map(([name]) => name)))].filter(
    (f) => !fields.includes(f),
  );
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
        for (const item of inner.items)
          if (item.kind === "ref" && ids.has(item.id)) edges.push({ from: obj.id, to: item.id });
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
    edgeStyle: edgeStyleOption(hint?.options ?? []),
    sideways: (hint?.options ?? []).includes("sideways"),
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

export type EdgeStyle = "auto" | "straight" | "curved" | "angled";

function edgeStyleOption(options: GraphOption[]): EdgeStyle {
  return options.includes("angled")
    ? "angled"
    : options.includes("curved")
      ? "curved"
      : options.includes("straight")
        ? "straight"
        : "auto";
}

function layoutOption(options: GraphOption[]): GraphData["layout"] {
  return options.includes("circle")
    ? "circle"
    : options.includes("layered")
      ? "layered"
      : options.includes("force")
        ? "force"
        : "auto";
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
    edgeStyle: edgeStyleOption(options),
    sideways: options.includes("sideways"),
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
  "node",
  "u",
  "v",
  "cur",
  "curr",
  "current",
  "start",
  "src",
  "source",
  "target",
  "dst",
  "dest",
  "goal",
  "end",
  "nb",
  "nbr",
  "nei",
  "next",
  "neighbor",
  "neighbour",
  "nxt",
  "next_node",
  "nextNode",
  "vertex",
  "vert",
  "at",
  "here",
  "root",
  "child",
  "parent",
  "word",
  "city",
  "room",
  "first",
  "last",
  "item",
  "task",
  "course",
  "job",
]);
const VISITED_NAMES =
  /visit|seen|done|explored|closed|finished|order|result|topo|sorted|output|^out$|^res$|marked|reached|removed/i;
const PATH_NAMES = /path|route|trail|walk|cycle|trip|tour/i;
const PARENT_NAMES = /parent|prev|pred|came|^from|via|back|^up$/i;
const LABEL_NAMES =
  /dist|depth|cost|level|^low|disc|^tin|^tout|indeg|in_deg|inDeg|degree|colou?r|time|rank|comp|group|size|count|score|^d$|^h$|^g$|^f$/i;
const STACK_NAMES = /stack|stk|dfs|todo/i;
const HEAP_NAMES = /heap|pq|prio|frontier|open/i;
const QUEUE_NAMES = /queue|^q$|bfs|deque|ready|waiting/i;
const EDGE_NAMES = /mst|tree|span|chosen|picked|used|edge|matching|cut|bridges/i;

export function emptyOverlay(): GraphOverlay {
  return {
    visited: new Map(),
    visitedNames: [],
    frontier: new Map(),
    frontierName: null,
    labels: new Map(),
    labelNames: [],
    treeEdges: new Set(),
    treeName: null,
    chosenEdges: new Set(),
    chosenName: null,
    pathEdges: new Set(),
    pathNodes: new Set(),
    pathName: null,
    pointers: new Map(),
  };
}

export function graphOverlay(
  trace: Trace,
  graph: GraphData,
  scopes: Scope[],
  heap: Record<string, HeapObject>,
): GraphOverlay {
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
    if (
      (pair?.kind !== "list" && pair?.kind !== "tuple") ||
      pair.items.length < 2 ||
      pair.items.length > 3 ||
      graph.members.has(pair.id)
    )
      return null;
    for (let i = pair.items.length - 1; i >= 0; i--) {
      const node = nodeOf(pair.items[i]);
      if (node) return node;
    }
    return null;
  };
  const pointerNames = new Set([
    ...POINTER_NAMES,
    ...explicit,
    ...(trace.indexNames[graph.name] ?? []),
    ...(trace.indexNames[lastSegment(graph.name)] ?? []),
    ...(trace.viz?.pointers[graph.name] ?? []),
    ...(trace.viz?.pointers[lastSegment(graph.name)] ?? []),
  ]);
  const addPointer = (node: string, name: string) =>
    overlay.pointers.set(node, [...(overlay.pointers.get(node) ?? []), name]);
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
  const byIndex =
    !graph.objectNodes &&
    keys.every((k) => k.startsWith("n:")) &&
    keys
      .map((k) => Number(k.slice(2)))
      .sort((a, b) => a - b)
      .every((n, i) => n === i);

  /** An array with one entry per node (index graphs): true if it was used. */
  const perNode = (name: string, items: Value[]): boolean => {
    const base = lastSegment(name);
    if (items.every(isBool)) {
      markVisited(
        items.flatMap((v, i) => (isTrue(v) ? [`n:${i}`] : [])),
        name,
      );
      return true;
    }
    if (PARENT_NAMES.test(base) && items.every((v) => nodeOf(v) || isNullish(v) || primText(v) === "-1")) {
      addTree(
        items.flatMap((v, i) => {
          const parent = nodeOf(v);
          return parent && primText(v) !== "-1" && parent !== `n:${i}` ? [[parent, `n:${i}`] as [string, string]] : [];
        }),
        name,
      );
      return true;
    }
    if (LABEL_NAMES.test(base) || items.some((v) => v.kind !== "prim" || !nodeOf(v))) {
      if (items.every((v) => v.kind === "prim"))
        addLabels(
          items.map((v, i) => [`n:${i}`, primText(v) ?? ""]),
          name,
        );
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
        if (STACK_NAMES.test(base) && !HEAP_NAMES.test(base))
          order = list.map((node, i) => ({ node, rank: list.length - 1 - i }));
        else if (HEAP_NAMES.test(base) || (prioritized && !isQueue)) {
          const priority = (v: Value) => {
            const pair = v.kind === "ref" ? heap[v.id] : undefined;
            return pair && (pair.kind === "list" || pair.kind === "tuple") ? Number(primText(pair.items[0])) : 0;
          };
          order = obj.items
            .map((v, i) => ({ node: list[i], rank: priority(v) + i * 1e-9 }))
            .sort((a, b) => a.rank - b.rank)
            .map((entry, i) => ({ node: entry.node, rank: i }));
        }
        for (const { node, rank } of order) {
          if (!overlay.frontier.has(node) || overlay.frontier.get(node)! > rank) overlay.frontier.set(node, rank);
        }
        // Positions, counting from 0, with no gaps from duplicates.
        const ranked = [...overlay.frontier].sort((a, b) => a[1] - b[1]);
        ranked.forEach(([node], i) => {
          overlay.frontier.set(node, i);
        });
      }
      continue;
    }

    if (obj.kind === "dict" && obj.entries.length) {
      const nodes = obj.entries.map(([k]) => nodeOf(k));
      if (nodes.some((n) => !n)) continue;
      const values = obj.entries.map(([, v]) => v);
      if (values.every(isBool)) {
        markVisited(
          obj.entries.flatMap(([, v], i) => (isTrue(v) ? [nodes[i]!] : [])),
          name,
        );
      } else if (PARENT_NAMES.test(base) && values.every((v) => nodeOf(v) || isNullish(v))) {
        addTree(
          values.flatMap((v, i) => {
            const parent = nodeOf(v);
            return parent && parent !== nodes[i] ? [[parent, nodes[i]!] as [string, string]] : [];
          }),
          name,
        );
      } else if (values.every((v) => v.kind === "prim")) {
        addLabels(
          values.map((v, i) => [nodes[i]!, primText(v) ?? ""]),
          name,
        );
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
  return [
    overlay.visited.has(node) ? "v" : "",
    overlay.frontier.get(node) ?? "",
    overlay.labels.get(node) ?? "",
    overlay.pathNodes.has(node) ? "p" : "",
  ].join("|");
}

/** A node with nothing drawn on it, as nodeSignature writes it. */
const UNMARKED = "|||";

/** A graph's own part of its signature (its nodes and edges), and each node's place: kept with the graph, which steps share until it changes. */
const graphParts = new WeakMap<GraphData, { key: string; order: Map<string, number> }>();

/**
 * Changes whenever anything drawn for the graph changes: its nodes and
 * edges, and what's drawn on each node. Only the nodes with something on
 * them are listed, so a loop history comparing a big graph from pass to
 * pass costs what its algorithm marks, not every node every pass.
 */
export function graphSignature(graph: GraphData | undefined, overlay: GraphOverlay | undefined): string {
  if (!graph) return "";
  let part = graphParts.get(graph);
  if (!part) {
    const nodes = [...graph.nodes.keys()];
    const edges = graph.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ""}`).join(",");
    part = { key: `${nodes.join(",")}#${edges}`, order: new Map(nodes.map((node, i) => [node, i])) };
    graphParts.set(graph, part);
  }
  if (!overlay) return `${part.key}##`;
  const order = part.order;
  const marked = new Set<string>([
    ...overlay.visited.keys(),
    ...overlay.frontier.keys(),
    ...overlay.labels.keys(),
    ...overlay.pathNodes,
  ]);
  const nodes = [...marked]
    .filter((node) => order.has(node))
    .sort((a, b) => order.get(a)! - order.get(b)!)
    .map((node) => [node, nodeSignature(overlay, node)])
    .filter(([, sig]) => sig !== UNMARKED)
    .map(([node, sig]) => `${node}=${sig}`)
    .join(",");
  const extra = [...overlay.treeEdges, ...overlay.pathEdges, ...overlay.chosenEdges].join(",");
  return `${part.key}#${nodes}#${extra}`;
}

// ---------------------------------------------------------------------------
// Layout (graphLayout.ts)
// ---------------------------------------------------------------------------

export type { GraphLayout };
export { computeLayout };

/**
 * One layout per graph for the whole run, made from every node and edge the
 * graph ever has, so nodes stay put from step to step (and between the
 * memory view and the loop history) while the graph is built up.
 */
const layouts = new WeakMap<Trace, Map<string, GraphLayout>>();
/** Every node and edge each graph has during the run (unionFor). */
const unions = new WeakMap<Trace, Map<string, GraphUnion>>();
/** Every kind of state drawn on each graph during the run, for a steady legend. */
const legends = new WeakMap<Trace, Map<string, GraphOverlay[]>>();

/** A graph over the whole run: every node it ever has (in the order first seen) and every edge. */
export interface GraphUnion {
  nodes: string[];
  /** The same nodes, to look up. */
  has: ReadonlySet<string>;
  edges: GraphEdge[];
  directed: boolean;
  layout: GraphData["layout"];
  angled: boolean;
  /** Where the algorithm starts (startOf), if a step shows it. */
  start: string | null;
}

/**
 * The overlays a graph's legend should cover: one for each different set of
 * names seen during the run, so the legend (and the picture's size) stays
 * the same from the first step to the last.
 */
export function legendOverlaysFor(trace: Trace, graph: GraphData): GraphOverlay[] {
  unionsOf(trace);
  return legends.get(trace)?.get(graph.id) ?? [];
}

/** Every graph's union over the run, and its legend: found once per trace. */
function unionsOf(trace: Trace): Map<string, GraphUnion> {
  return unions.get(trace) ?? finishNow(graphUnionsWork(trace));
}

/**
 * Find every graph's union over the run, and its legend, a step at a time
 * (trace/work.ts), so the page can do it in slices before the first
 * drawing; then unionFor, layoutFor and legendOverlaysFor have them at once.
 * Nothing to do when they're found already.
 */
export function* graphUnionsWork(trace: Trace): Work<Map<string, GraphUnion>> {
  const already = unions.get(trace);
  if (already) return already;
  const byId = new Map<string, GraphUnion>();
  const legendById = new Map<string, Map<string, GraphOverlay>>();
  const found = new Map<
    string,
    {
      nodes: Map<string, true>;
      edges: Map<string, GraphEdge>;
      directed: boolean;
      layout: GraphData["layout"];
      angled: boolean;
      start: string | null;
    }
  >();
  /** The graph object last merged for each id: one found the same as last step's (graphs are kept, see objectGraph) is merged once. */
  const merged = new Map<string, GraphData>();
  const total = trace.steps.length;
  for (let i = 0; i < total; i++) {
    const step = trace.steps[i];
    if (i) yield stepOf("Finding graphs", i, total);
    for (const g of findGraphs(trace, stepScopes(step), step.heap)) {
      const o = graphOverlay(trace, g, stepScopes(step), step.heap);
      const names = {
        ...emptyOverlay(),
        visitedNames: o.visitedNames,
        frontierName: o.frontierName,
        labelNames: o.labelNames,
        treeName: o.treeName,
        pathName: o.pathName,
        chosenName: o.chosenName,
      };
      const seen = legendById.get(g.id) ?? new Map<string, GraphOverlay>();
      seen.set(
        JSON.stringify([
          names.visitedNames,
          names.frontierName,
          names.labelNames,
          names.treeName,
          names.pathName,
          names.chosenName,
        ]),
        names,
      );
      legendById.set(g.id, seen);
      const entry = found.get(g.id) ?? {
        nodes: new Map(),
        edges: new Map(),
        directed: false,
        layout: g.layout,
        angled: g.edgeStyle === "angled",
        start: null,
      };
      entry.start ??= startOf(o);
      found.set(g.id, entry);
      if (merged.get(g.id) === g) continue;
      merged.set(g.id, g);
      for (const node of g.nodes.keys()) entry.nodes.set(node, true);
      for (const e of g.edges) entry.edges.set(`${e.from}>${e.to}`, e);
      entry.directed ||= g.directed;
    }
  }
  for (const [id, entry] of found)
    byId.set(id, {
      nodes: [...entry.nodes.keys()],
      has: new Set(entry.nodes.keys()),
      edges: [...entry.edges.values()],
      directed: entry.directed,
      layout: entry.layout,
      angled: entry.angled,
      start: entry.start,
    });
  legends.set(trace, new Map([...legendById].map(([id, seen]) => [id, [...seen.values()]])));
  // Kept only once complete: work stopped part way (a newer run) leaves nothing half found.
  unions.set(trace, byId);
  return byId;
}

/**
 * A graph over the whole run (every node and edge it ever has), or, for a
 * graph found only in this view (say, from a loop's own frame), the graph
 * itself.
 */
export function unionFor(trace: Trace, graph: GraphData): GraphUnion {
  const known = unionsOf(trace).get(graph.id);
  if (known && [...graph.nodes.keys()].every((node) => known.has.has(node))) return known;
  return {
    nodes: [...graph.nodes.keys()],
    has: new Set(graph.nodes.keys()),
    edges: graph.edges,
    directed: graph.directed,
    layout: graph.layout,
    angled: graph.edgeStyle === "angled",
    start: null,
  };
}

/** The graph's layout for the run, made the first time it's asked for (a big graph drawn as clusters never is). */
export function layoutFor(trace: Trace, graph: GraphData): GraphLayout {
  let byId = layouts.get(trace);
  if (!byId) {
    byId = new Map();
    layouts.set(trace, byId);
  }
  const known = byId.get(graph.id);
  if (known && [...graph.nodes.keys()].every((node) => known.pos.has(node))) return known;
  const union = unionFor(trace, graph);
  const layout = computeLayout(union.nodes, union.edges, {
    directed: union.directed,
    mode: union.layout,
    angled: union.angled,
    start: union.start,
  });
  byId.set(graph.id, layout);
  return layout;
}

/**
 * Where the algorithm starts, as far as one step shows: the node it queued
 * first (the one that comes out next), or the only one it has visited. The
 * first step that shows one decides (layoutFor), and the layout puts it on
 * top.
 */
function startOf(overlay: GraphOverlay): string | null {
  const next = [...overlay.frontier].sort((a, b) => a[1] - b[1])[0];
  if (overlay.visited.size === 0 && next) return next[0];
  if (overlay.visited.size === 1) return [...overlay.visited.keys()][0];
  return null;
}

/** Steps' graphs, for the memory view: everything in view at a step. */
export function graphsAt(trace: Trace, step: Step): GraphData[] {
  return findGraphs(trace, stepScopes(step), step.heap);
}
