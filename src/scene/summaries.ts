/**
 * Summaries: a detail budget for the memory view. A 2,000-node list, a
 * tree of a thousand nodes or recursion 400 calls deep is too much to draw
 * every step, and too much to read at once. So before the scene picks its
 * boxes, long runs are summarized:
 *
 *   a linked chain   its first and last nodes, and one "… 480 more Node"
 *                    box between them, linked like a node
 *   a binary tree    every level that fits, and each subtree below them as
 *                    one leaf, a triangle with its node count
 *   recursion        the outermost and innermost calls of a run of one
 *                    function, and one "fib() × 352" frame between them
 *
 * Whatever the program holds stays: a node a variable points to is never
 * summarized, nor is the path down to it in a tree, so walking a list shows
 * its head, the cursor and what's around it, and its tail.
 *
 * It works on a copy of the step: the summaries are objects (and a frame)
 * of their own, and the objects that pointed into what they stand for point
 * to them instead. Everything after (the scene, the layout, both modes,
 * both renderers) draws a summary like any other box; the trace itself is
 * never changed. The budget comes from the zoom (`detailBudget`): zooming
 * in shows more, zooming out less. A structure the person expanded (by
 * clicking its summary) is drawn in full, by its key.
 */

import { heapEntries, heapIds, heapValues } from "../trace/heapStore";
import { fieldsOf, findLinkedTrack, linkedRow, MEMORY_MAX_NODES, treeDepths } from "../trace/linked";
import { type Frame, type HeapObject, liveFrames, type Step, type Trace, type Value } from "../trace/types";
import { valuesOf } from "./nesting";

/** How much of each structure is drawn, and what the person expanded. */
export interface DetailOptions {
  /** The most nodes of one run (a chain, a tree, calls of one function) drawn before the rest is summarized. */
  budget: number;
  /** Structures drawn in full, by summary key. */
  expanded: ReadonlySet<string>;
}

/** What a summary stands for. */
export interface Summary {
  /** Clicking it expands this structure: the same key every step while it's the same structure. */
  key: string;
  kind: "chain" | "tree" | "frames";
  /** How many nodes (or calls) it stands for. */
  count: number;
  /** Their class, or the function's name. */
  name: string;
}

export interface Summarized {
  /** The step to draw: summaries in place of what they stand for. The same step when nothing is summarized. */
  step: Step;
  /** Each summary, by its object's (or frame's) id. */
  summaries: ReadonlyMap<string, Summary>;
  /** Each frame of the step to draw: its place on the real call stack (for its box's key). */
  stackIndex: ReadonlyMap<Frame, number>;
}

/** Nodes of one run drawn at each level of detail (lod.ts), full to overview. */
const BUDGETS = [64, 48, 32, 16, 8];

/**
 * The detail budget at a zoom's level of detail. With Auto-fit on, the
 * zoom follows the drawing's size, so the budget doesn't follow the zoom
 * (or each would keep changing the other): full detail's.
 */
export function detailBudget(lod: number, autoFit: boolean): number {
  return autoFit ? BUDGETS[0] : BUDGETS[Math.max(0, Math.min(BUDGETS.length - 1, lod))];
}

/** Summaries' ids start with this (their boxes' keys are "obj:sum:..."). */
export const SUMMARY_PREFIX = "sum:";

/** Each summary object and frame made, with what it stands for: shapes draw them as summaries. */
const made = new WeakMap<object, Summary>();

/** What a summary object (or frame) stands for; undefined for a real one. */
export function summaryOf(thing: HeapObject | Frame): Summary | undefined {
  return made.get(thing);
}

/** A copy of an object with its references changed by `to`. */
function mapRefs(obj: HeapObject, to: (id: string) => string): HeapObject {
  const value = (v: Value): Value => (v.kind === "ref" && to(v.id) !== v.id ? { ...v, id: to(v.id) } : v);
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
      return { ...obj, items: obj.items.map(value) };
    case "dict":
      return { ...obj, entries: obj.entries.map(([k, v]) => [value(k), value(v)] as [Value, Value]) };
    case "object":
    case "function":
      return { ...obj, fields: obj.fields.map(([n, v]) => [n, value(v)] as [string, Value]) };
    default:
      return obj;
  }
}

/** Does an object refer to any of these ids? */
const refersTo = (obj: HeapObject, ids: ReadonlySet<string>) =>
  valuesOf(obj).some((v) => v.kind === "ref" && ids.has(v.id));

/** The values a frame (and the step's returned value) holds: what the program has its hands on. */
function heldIds(step: Step): Set<string> {
  const held = new Set<string>();
  for (const frame of liveFrames(step)) for (const [, v] of frame.locals) if (v.kind === "ref") held.add(v.id);
  if (step.returnValue?.kind === "ref") held.add(step.returnValue.id);
  return held;
}

/** Summarize a step's long chains, big trees and deep recursion; `skip`: objects never summarized (graphs' members). */
export function summarize(
  trace: Trace,
  step: Step,
  detail: DetailOptions | undefined,
  skip: ReadonlySet<string> = new Set(),
): Summarized {
  const stackIndex = new Map<Frame, number>();
  liveFrames(step).forEach((f, i) => {
    stackIndex.set(f, i);
  });
  const none: Summarized = { step, summaries: new Map(), stackIndex };
  if (!detail) return none;
  const budget = Math.max(2, detail.budget);
  const summaries = new Map<string, Summary>();
  /** Hidden object -> the summary standing for it. */
  const hiddenBy = new Map<string, string>();
  /** New and changed objects. */
  const replaced = new Map<string, HeapObject>();
  const held = heldIds(step);

  // One linked class at a time, as the loop history finds it.
  const row = { locals: liveFrames(step).flatMap((f) => f.locals), heap: step.heap };
  const track = findLinkedTrack([row], trace.viz?.linked, trace.viz?.labels, MEMORY_MAX_NODES);
  if (track && !track.links.length) return none;
  const ofType = (id: string | null | undefined): id is string =>
    !!id && step.heap[id]?.typeName === track?.typeName && !skip.has(id);
  const linkOf = (id: string, link: string): string | null => {
    const v = fieldsOf(step.heap[id])?.find(([n]) => n === link)?.[1];
    return v?.kind === "ref" ? v.id : null;
  };
  const none_ = (): Value =>
    trace.language === "python"
      ? { kind: "prim", type: "none", repr: "None" }
      : { kind: "prim", type: "null", repr: "null" };

  if (track?.shape === "tree") {
    summarizeTrees();
  } else if (track) {
    summarizeChains();
  }
  const stack = summarizeFrames();

  if (!summaries.size) return none;

  // Whatever pointed into what a summary stands for points to the summary.
  const heap: Record<string, HeapObject> = {};
  const hidden = new Set(hiddenBy.keys());
  for (const [id, obj] of heapEntries(step.heap)) {
    if (hidden.has(id)) continue;
    const own = replaced.get(id) ?? obj;
    heap[id] = refersTo(own, hidden) ? mapRefs(own, (to) => hiddenBy.get(to) ?? to) : own;
  }
  for (const [id, obj] of replaced) if (!(id in heap) && !hidden.has(id)) heap[id] = obj;
  const view: Step = { ...step, heap, stack: stack ?? step.stack };
  return { step: view, summaries, stackIndex };

  /** Long runs of a chain's nodes nobody else holds, each down to `budget` nodes and a summary. */
  function summarizeChains(): void {
    if (!track) return;
    const link = track.links[0];
    // Who points at each node along the link (once), and whether anything
    // outside the chain does (a doubly linked list's back links are the chain's own).
    const pred = new Map<string, string>();
    const otherRefs = new Map<string, number>();
    for (const obj of heapValues(step.heap)) {
      const own = ofType(obj.id);
      const inChain = new Set(own ? track.links.map((l) => linkOf(obj.id, l)).filter(ofType) : []);
      const next = own ? linkOf(obj.id, link) : null;
      for (const v of valuesOf(obj)) {
        if (v.kind !== "ref") continue;
        if (v.id === next && ofType(next) && !pred.has(next)) pred.set(next, obj.id);
        else if (!inChain.has(v.id)) otherRefs.set(v.id, (otherRefs.get(v.id) ?? 0) + 1);
      }
    }
    /** A node that can be summarized: only its chain's previous node points at it. */
    const hideable = (id: string) => ofType(id) && pred.has(id) && !held.has(id) && !otherRefs.has(id);
    const heads = new Map<string, string>();
    const headOf = (id: string): string => {
      const known = heads.get(id);
      if (known) return known;
      let at = id;
      const seen = new Set<string>();
      while (pred.has(at) && !seen.has(at)) {
        seen.add(at);
        at = pred.get(at)!;
      }
      heads.set(id, at);
      return at;
    };
    const done = new Set<string>();
    for (const start of heapIds(step.heap)) {
      if (!ofType(start) || done.has(start) || hideable(start)) continue;
      // From a node that stays (or starts a chain), each run of hideable nodes after it.
      let at: string | null = start;
      while (at && !done.has(at)) {
        done.add(at);
        const run: string[] = [];
        let next: string | null = linkOf(at, link);
        while (next && hideable(next) && !done.has(next)) {
          done.add(next);
          run.push(next);
          next = linkOf(next, link);
        }
        const key = `chain:${track.typeName}:${headOf(start)}`;
        if (run.length > budget && !detail!.expanded.has(key)) {
          const keepFirst = Math.ceil(budget / 2);
          const keepLast = Math.floor(budget / 2);
          const middle = run.slice(keepFirst, run.length - keepLast);
          const after = run[run.length - keepLast] ?? next;
          const id = `${SUMMARY_PREFIX}${middle[0]}`;
          for (const m of middle) hiddenBy.set(m, id);
          const summary: Summary = { key, kind: "chain", count: middle.length, name: track.typeName };
          summaries.set(id, summary);
          // Linked like a node, to the node after what it stands for. (Whatever
          // pointed into what it stands for points to it: mapRefs, below.)
          const obj: HeapObject = {
            kind: "object",
            id,
            typeName: track.typeName,
            fields: after ? [[link, { kind: "ref", id: after }]] : [],
          };
          made.set(obj, summary);
          replaced.set(id, obj);
        }
        at = next && !done.has(next) ? next : null;
      }
    }
  }

  /** Big trees: every level that fits the budget; each subtree below as one leaf with its count. */
  function summarizeTrees(): void {
    if (!track) return;
    const state = linkedRow(track, row);
    const depths = treeDepths(state);
    const children = (id: string) => (state.nodes.get(id)?.links ?? []).filter((c): c is string => !!c && !skip.has(c));
    const size = new Map<string, number>();
    const holds = new Map<string, boolean>();
    const measure = (id: string, seen: Set<string>): void => {
      if (seen.has(id)) return;
      seen.add(id);
      let n = 1;
      let h = held.has(id);
      for (const c of children(id)) {
        measure(c, seen);
        n += size.get(c) ?? 0;
        h ||= holds.get(c) ?? false;
      }
      size.set(id, n);
      holds.set(id, h);
    };
    for (const [id, depth] of depths) {
      if (depth !== 0) continue;
      measure(id, new Set());
      if ((size.get(id) ?? 0) <= budget) continue;
      // The deepest level whose nodes (and everything above) fit the budget, at least the root and its children.
      const perLevel: number[] = [];
      const count = (n: string, d: number, seen: Set<string>) => {
        if (seen.has(n)) return;
        seen.add(n);
        perLevel[d] = (perLevel[d] ?? 0) + 1;
        for (const c of children(n)) count(c, d + 1, seen);
      };
      count(id, 0, new Set());
      // With each kept level's nodes, at most two leaves under each of the last level's.
      let keep = 1;
      let total = perLevel[0] + (perLevel[1] ?? 0);
      while (keep + 1 < perLevel.length) {
        const more = total + perLevel[keep + 1];
        if (more + 2 * perLevel[keep + 1] > budget) break;
        keep++;
        total = more;
      }
      const fold = (n: string, d: number, seen: Set<string>) => {
        if (seen.has(n)) return;
        seen.add(n);
        const kids = children(n);
        for (const c of kids) {
          const key = `tree:${c}`;
          if (d + 1 > keep && !holds.get(c) && !detail!.expanded.has(key)) {
            // c and everything under it: one leaf.
            const sid = `${SUMMARY_PREFIX}${c}`;
            const under = (x: string, s: Set<string>) => {
              if (s.has(x)) return;
              s.add(x);
              hiddenBy.set(x, sid);
              for (const k of children(x)) under(k, s);
            };
            under(c, new Set());
            const summary: Summary = { key, kind: "tree", count: size.get(c) ?? 1, name: track.typeName };
            summaries.set(sid, summary);
            // A leaf of the same class: the tree's layout places it as one.
            const obj: HeapObject = {
              kind: "object",
              id: sid,
              typeName: track.typeName,
              fields: track.links.map((l) => [l, none_()] as [string, Value]),
            };
            made.set(obj, summary);
            replaced.set(sid, obj);
          } else if (!detail!.expanded.has(key)) fold(c, d + 1, seen);
        }
      };
      fold(id, 0, new Set());
    }
  }

  /** Deep recursion: a run of one function's calls down to its outermost and innermost, and one frame between. */
  function summarizeFrames(): Frame[] | null {
    const stack = step.stack;
    const out: Frame[] = [];
    let changed = false;
    for (let i = 0; i < stack.length; ) {
      let j = i;
      while (j < stack.length && stack[j].func === stack[i].func) j++;
      const run = j - i;
      const key = `frames:${stack[i].func}:${i}`;
      if (run > budget && stack[i].func !== "Global" && !detail!.expanded.has(key)) {
        const keepFirst = Math.ceil(budget / 2);
        const keepLast = Math.floor(budget / 2);
        out.push(...stack.slice(i, i + keepFirst));
        const id = `${SUMMARY_PREFIX}frames:${stack[i].func}:${i}`;
        const folded: Frame = { id, func: stack[i].func, line: stack[i + keepFirst].line, locals: [] };
        stackIndex.set(folded, i + keepFirst);
        const summary: Summary = { key, kind: "frames", count: run - keepFirst - keepLast, name: stack[i].func };
        summaries.set(id, summary);
        made.set(folded, summary);
        out.push(folded);
        out.push(...stack.slice(j - keepLast, j));
        changed = true;
      } else out.push(...stack.slice(i, j));
      i = j;
    }
    return changed ? out : null;
  }
}

/** Each summary's box, by its key in the scene ("obj:sum:..." or a frame's), and the structure it opens. */
export function summaryBoxes(scene: {
  summaries: ReadonlyMap<string, Summary>;
  frames: { key: string; frame: Frame }[];
}): Map<string, string> {
  const out = new Map<string, string>();
  if (!scene.summaries.size) return out;
  for (const f of scene.frames) {
    const s = scene.summaries.get(f.frame.id);
    if (s) out.set(f.key, s.key);
  }
  for (const [id, s] of scene.summaries) if (s.kind !== "frames") out.set(`obj:${id}`, s.key);
  return out;
}
