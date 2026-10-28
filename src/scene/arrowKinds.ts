/**
 * What kind of link each arrow is, for coloring arrows by kind (Style →
 * Arrow colors):
 *
 *   ref     a variable, list or dict pointing at something
 *   tree    a tree's parent to its child (the layout knows these)
 *   next    one object linking to another of its class (a linked list's next)
 *   back    the way back of a two-way link: parent, prev
 *   cycle   a link that closes a loop of links (a list whose end points
 *           back into it)
 *
 * "Back" and "cycle" both point backwards along the links; they're told
 * apart by whether the object pointed at links straight back. Which way of
 * a two-way link is "back" goes by the field's name (parent, prev...) when
 * it has one, and otherwise by the order the links are reached from the
 * variables.
 */
import type { HeapObject, Step, Value } from "../trace/types";

export type LinkKind = "ref" | "tree" | "next" | "back" | "cycle";
export const LINK_KINDS: readonly LinkKind[] = ["ref", "tree", "next", "back", "cycle"];

/** Fields that name the way back of a two-way link. */
const BACK_NAMES = new Set(["parent", "prev", "previous", "pred", "back", "up", "father", "mother"]);

interface Edge {
  to: string;
  field: string | null;
}

function outgoing(obj: HeapObject | undefined): Edge[] {
  if (!obj) return [];
  const edge = (value: Value, field: string | null): Edge[] => (value.kind === "ref" ? [{ to: value.id, field }] : []);
  switch (obj.kind) {
    case "object":
    case "function":
      return obj.fields.flatMap(([name, value]) => edge(value, name));
    case "list":
    case "tuple":
    case "set":
      return obj.items.flatMap((v) => edge(v, null));
    case "dict":
      return obj.entries.flatMap(([k, v]) => [...edge(k, null), ...edge(v, null)]);
    default:
      return [];
  }
}

const cache = new WeakMap<Step, (from: string, to: string) => LinkKind>();

/** The kind of the link from one object to another at a step (call with the objects' ids). */
export function linkKinds(step: Step): (from: string, to: string) => LinkKind {
  const known = cache.get(step);
  if (known) return known;
  const { heap } = step;
  const edges = new Map<string, Edge[]>();
  const out = (id: string) => {
    let list = edges.get(id);
    if (!list) {
      list = outgoing(heap[id]);
      edges.set(id, list);
    }
    return list;
  };

  // Walk the links from the variables, in order: a link to an object
  // still being walked points back along the way it was reached.
  const backEdges = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const roots: string[] = [];
  for (const frame of [...step.stack, ...(step.suspended ?? [])])
    for (const [, value] of frame.locals) if (value.kind === "ref") roots.push(value.id);
  roots.push(...Object.keys(heap));
  for (const root of roots) {
    if (state.has(root) || !heap[root]) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, "open");
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = out(top.id);
      if (top.next >= list.length) {
        state.set(top.id, "done");
        stack.pop();
        continue;
      }
      const { to } = list[top.next++];
      if (!heap[to]) continue;
      const seen = state.get(to);
      if (seen === "open") backEdges.add(`${top.id}>${to}`);
      else if (!seen) {
        state.set(to, "open");
        stack.push({ id: to, next: 0 });
      }
    }
  }

  const fieldOf = (from: string, to: string) => out(from).find((e) => e.to === to)?.field ?? null;
  const isBackName = (field: string | null) => !!field && BACK_NAMES.has(field.toLowerCase());
  const kind = (from: string, to: string): LinkKind => {
    const a = heap[from];
    const b = heap[to];
    const mutual = out(to).some((e) => e.to === from);
    const back = backEdges.has(`${from}>${to}`);
    const sameClass = a?.kind === "object" && b?.kind === "object" && a.typeName === b.typeName;
    if (mutual && sameClass) {
      // next and next, each way: not a two-way link, a loop of two.
      if (fieldOf(from, to) === fieldOf(to, from)) return back ? "cycle" : "next";
      if (isBackName(fieldOf(from, to))) return "back";
      if (isBackName(fieldOf(to, from))) return "next";
      return back ? "back" : "next";
    }
    if (back) return mutual ? "back" : "cycle";
    return sameClass ? "next" : "ref";
  };
  cache.set(step, kind);
  return kind;
}

/** The kind of a link in a loop row's linked list or tree, by its field. */
export function trackLinkKind(field: string, shape: "list" | "tree", pointsBack: boolean): LinkKind {
  if (BACK_NAMES.has(field.toLowerCase())) return "back";
  if (shape === "tree") return "tree";
  return pointsBack ? "cycle" : "next";
}
