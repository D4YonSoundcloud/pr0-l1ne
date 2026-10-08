/**
 * Linked structures (linked lists, trees) for the loop history view.
 *
 * Lists and dicts are easy to stack row by row because their cells have
 * indices. Linked nodes don't, so this gives them some: every node seen
 * anywhere in the loop gets a fixed column, and each row shows where its
 * links point at that moment. Reversing a list then reads as the arrows
 * turning around while the nodes stay put.
 */
import { valueKey } from "./diff";
import type { HeapObject, LinkedHint, Value } from "./types";

/** The parts of a loop row this module needs. */
export interface RowSnapshot {
  locals: [string, Value][];
  heap: Record<string, HeapObject>;
}

export interface LinkedTrack {
  /** The node class, e.g. "Node" or "ListNode". */
  typeName: string;
  /** Fields that point at other nodes, in field order, e.g. ["next"]. */
  links: string[];
  /** The field shown in the node's cell, e.g. "val". */
  valueField: string | null;
  /** Node ids in column order. */
  order: string[];
  /**
   * "tree" when there are exactly two links and no node ever has more than
   * one incoming link (a binary tree), so it can be drawn top-down.
   * Everything else, including doubly linked lists, is a "list".
   */
  shape: "list" | "tree";
}

export interface NodeState {
  value: Value | undefined;
  /** For each link field: the target node id, or null for null/None/missing. */
  links: (string | null)[];
}

export interface LinkedRow {
  /** Nodes present in this row, by id. */
  nodes: Map<string, NodeState>;
  /** Names that point at nodes, e.g. "curr" or "this.head", with their column. */
  pointers: { name: string; index: number }[];
}

/** Field names that suggest a link even when every value seen is null. */
const LINK_NAMES = new Set(["next", "prev", "previous", "left", "right", "parent", "child", "head", "tail"]);
const MAX_NODES = 40;

/** Named fields of an instance or a JavaScript plain object. */
export function fieldsOf(obj: HeapObject | undefined): [string, Value][] | null {
  if (!obj) return null;
  if (obj.kind === "object") return obj.fields;
  // JavaScript plain objects ({ val: 1, next: null }) are drawn as dicts with
  // unquoted "key" keys. Treat them as instances of a class named "Object".
  if (obj.kind === "dict" && obj.entries.every(([key]) => key.kind === "prim" && key.type === "key")) {
    return obj.entries.map(([key, value]) => [(key as { repr: string }).repr, value]);
  }
  return null;
}

const typeOf = (obj: HeapObject | undefined) => (obj && fieldsOf(obj) ? obj.typeName : null);

/**
 * Where to start looking for nodes: each variable, plus one level through
 * other objects, so `self.head` or `this.head` inside a method is found.
 */
function roots(row: RowSnapshot, nodeType: string | null): { name: string; id: string }[] {
  const out: { name: string; id: string }[] = [];
  for (const [name, value] of row.locals) {
    if (value.kind !== "ref") continue;
    const obj = row.heap[value.id];
    if (!obj) continue;
    if (nodeType === null || typeOf(obj) === nodeType) out.push({ name, id: value.id });
    if (nodeType !== null && typeOf(obj) === nodeType) continue;
    for (const [field, inner] of fieldsOf(obj) ?? []) {
      if (inner.kind === "ref" && (nodeType === null || typeOf(row.heap[inner.id]) === nodeType)) {
        out.push({ name: `${name}.${field}`, id: inner.id });
      }
    }
  }
  return out;
}

/** Find the linked class in a loop's rows, if there is one. */
export function findLinkedTrack(rows: RowSnapshot[], hints: LinkedHint[] = []): LinkedTrack | null {
  // A `viz: tree` / `viz: list` hint for a class in these rows wins over
  // detection: it says exactly which fields are the links.
  for (const hint of hints) {
    if (!rows.some((row) => Object.values(row.heap).some((obj) => typeOf(obj) === hint.typeName))) continue;
    const fields = [...new Set(rows.flatMap((row) => nodesOfType(row, hint.typeName).flatMap(([, f]) => f.map(([n]) => n))))];
    const others = fields.filter((f) => !hint.links.includes(f));
    const valueField = others.find((f) => isMostlyPrimitive(rows, hint.typeName, f)) ?? null;
    const track: LinkedTrack = { typeName: hint.typeName, links: hint.links, valueField, order: [], shape: hint.shape };
    track.order = columnOrder(rows, track);
    if (track.order.length) return track;
  }

  // Count, per class, the fields that point at the same class.
  const linkFields = new Map<string, string[]>();
  const fieldOrder = new Map<string, string[]>();
  const nodeCount = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const obj = row.heap[id];
      const fields = fieldsOf(obj);
      if (!obj || !fields) return;
      const type = obj.typeName;
      fieldOrder.set(type, [...new Set([...(fieldOrder.get(type) ?? []), ...fields.map(([n]) => n)])]);
      nodeCount.set(type, (nodeCount.get(type) ?? new Set()).add(id));
      for (const [name, value] of fields) {
        if (value.kind !== "ref") continue;
        if (typeOf(row.heap[value.id]) === type) {
          const links = linkFields.get(type) ?? [];
          if (!links.includes(name)) linkFields.set(type, [...links, name]);
        }
        visit(value.id);
      }
    };
    for (const root of roots(row, null)) visit(root.id);
  }

  // The class with links and the most nodes wins.
  let best: string | null = null;
  for (const type of linkFields.keys()) {
    if (!best || nodeCount.get(type)!.size > nodeCount.get(best)!.size) best = type;
  }
  if (!best) return null;

  const fields = fieldOrder.get(best)!;
  const links = fields.filter((f) => linkFields.get(best!)!.includes(f) || (LINK_NAMES.has(f) && linkFields.get(best!)!.length > 0 && isAlwaysNullOrNode(rows, best!, f)));
  const valueField = fields.find((f) => !links.includes(f) && isMostlyPrimitive(rows, best!, f)) ?? null;
  const track: LinkedTrack = { typeName: best, links, valueField, order: [], shape: "list" };
  if (links.length === 2 && rows.every((row) => maxIndegree(row, best!, links) <= 1)) track.shape = "tree";
  track.order = columnOrder(rows, track);
  return track.order.length ? track : null;
}

/** The most links pointing at any single node of this class in a row. */
function maxIndegree(row: RowSnapshot, type: string, links: string[]): number {
  const counts = new Map<string, number>();
  for (const [, fields] of nodesOfType(row, type)) {
    for (const link of links) {
      const target = linkTarget(fields, link);
      if (target && typeOf(row.heap[target]) === type) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return Math.max(0, ...counts.values());
}

function nodesOfType(row: RowSnapshot, type: string): [string, [string, Value][]][] {
  return Object.values(row.heap)
    .filter((obj) => typeOf(obj) === type)
    .map((obj) => [obj.id, fieldsOf(obj)!]);
}

function isAlwaysNullOrNode(rows: RowSnapshot[], type: string, field: string): boolean {
  return rows.every((row) => nodesOfType(row, type).every(([, fields]) => {
    const value = fields.find(([n]) => n === field)?.[1];
    return !value || (value.kind === "prim" ? /^(null|None|undefined)$/.test(value.repr) : typeOf(row.heap[value.id]) === type);
  }));
}

function isMostlyPrimitive(rows: RowSnapshot[], type: string, field: string): boolean {
  let prims = 0;
  let total = 0;
  for (const row of rows) {
    for (const [, fields] of nodesOfType(row, type)) {
      const value = fields.find(([n]) => n === field)?.[1];
      if (!value) continue;
      total++;
      if (value.kind === "prim") prims++;
    }
  }
  return total > 0 && prims * 2 >= total;
}

const linkTarget = (fields: [string, Value][], field: string): string | null => {
  const value = fields.find(([n]) => n === field)?.[1];
  return value?.kind === "ref" ? value.id : null;
};

/**
 * Fixed column order: follow links from the first row's variables, so the
 * starting structure reads left to right; nodes that appear later go on the
 * end. Binary trees use in-order, so a search tree reads sorted, and
 * drawn top-down (in-order x, depth y) it's the classic tree picture.
 */
function columnOrder(rows: RowSnapshot[], track: LinkedTrack): string[] {
  const order: string[] = [];
  const inOrder = track.shape === "tree";
  for (const row of rows) {
    const seen = new Set<string>();
    const visit = (id: string | null) => {
      if (!id || seen.has(id) || order.length >= MAX_NODES) return;
      const fields = fieldsOf(row.heap[id]);
      if (!fields || row.heap[id].typeName !== track.typeName) return;
      seen.add(id);
      if (inOrder) {
        visit(linkTarget(fields, track.links[0]));
        if (!order.includes(id)) order.push(id);
        visit(linkTarget(fields, track.links[1]));
      } else {
        if (!order.includes(id)) order.push(id);
        for (const link of track.links) visit(linkTarget(fields, link));
      }
    };
    for (const root of roots(row, track.typeName)) visit(root.id);
  }
  return order;
}

/** What one row shows: each node's value and links, and the named pointers. */
export function linkedRow(track: LinkedTrack, row: RowSnapshot): LinkedRow {
  const nodes = new Map<string, NodeState>();
  for (const id of track.order) {
    const fields = fieldsOf(row.heap[id]);
    if (!fields) continue;
    // Only nodes the code can still reach count as present.
    nodes.set(id, {
      value: track.valueField ? fields.find(([n]) => n === track.valueField)?.[1] : undefined,
      links: track.links.map((link) => {
        const target = linkTarget(fields, link);
        return target && track.order.includes(target) ? target : null;
      }),
    });
  }
  const reachable = new Set<string>();
  const walk = (id: string | null) => {
    if (!id || reachable.has(id) || !nodes.has(id)) return;
    reachable.add(id);
    for (const target of nodes.get(id)!.links) walk(target);
  };
  const named = roots(row, track.typeName);
  for (const root of named) walk(root.id);
  for (const id of [...nodes.keys()]) if (!reachable.has(id)) nodes.delete(id);

  const pointers = named
    .map(({ name, id }) => ({ name, index: track.order.indexOf(id) }))
    .filter((p) => p.index >= 0);
  return { nodes, pointers };
}

/** A string that changes whenever anything visible in the row changes. */
export function linkedSignature(state: LinkedRow): string {
  return [...state.nodes].map(([id, node]) =>
    `${id}=${node.value ? valueKey(node.value) : ""}>${node.links.join(",")}`).join("|");
}

/** Depth of each node in one row of a tree: roots (nothing links to them) are 0. */
export function treeDepths(state: LinkedRow): Map<string, number> {
  const targets = new Set<string>();
  for (const node of state.nodes.values()) for (const t of node.links) if (t) targets.add(t);
  const depth = new Map<string, number>();
  const walk = (id: string, d: number) => {
    if (depth.has(id) || !state.nodes.has(id)) return;
    depth.set(id, d);
    for (const child of state.nodes.get(id)!.links) if (child) walk(child, d + 1);
  };
  for (const id of state.nodes.keys()) if (!targets.has(id)) walk(id, 0);
  for (const id of state.nodes.keys()) walk(id, 0); // a cycle with no root
  return depth;
}
