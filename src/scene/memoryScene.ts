/**
 * The memory view's scene: everything about one step that the memory
 * diagram shows, worked out from the trace, with no positions and no pixels.
 *
 * It says which frames and objects there are and how far each object is
 * from the stack, which objects are drawn inside others (nested mode),
 * which are graphs or binary trees, which variables point into which lists,
 * the grid cell the step touches, what the step printed and what changed
 * since the step before. A renderer decides where all of that goes and how
 * it looks (render/memory.ts draws it as SVG); a different renderer draws
 * the same scene. See docs/how-it-works.md, "Scenes and renderers".
 */
import { localKey, type StepDiff, slotsOf } from "../trace/diff";
import {
  type GraphData,
  type GraphLayout,
  type GraphOverlay,
  graphOverlay,
  graphsAt,
  layoutFor,
  legendOverlaysFor,
  stepScopes,
} from "../trace/graph";
import { focusLines, type GridFocus, gridCells, gridFocus } from "../trace/gridFocus";
import { findLinkedTrack, linkedRow, treeDepths } from "../trace/linked";
import { type SizeModel, type StepSizes, stepSizes } from "../trace/memory";
import { type Printed, printedAt } from "../trace/output";
import { type Frame, type HeapObject, liveFrames, type Step, type Trace, type Value } from "../trace/types";
import { chooseNested, incomingCounts, valuesOf } from "./nesting";
import { type Pointer, pointersFor } from "./pointers";
import { type CompareSpan, comparesFor, hasRegionLabels, type WindowSpan, windowsFor } from "./windows";

/** Arrows: every object is its own box. Nested: an object only one thing refers to is drawn inside it. */
export type MemoryMode = "arrows" | "nested";

export interface MemorySceneOptions {
  mode?: MemoryMode;
  /** Show memory sizes under this model (see trace/memory.ts). */
  sizes?: SizeModel | null;
  /** On a step that prints, show what it printed (default true). */
  output?: boolean;
  /** ...and dim everything else (default false). */
  dimForOutput?: boolean;
  /** The window is taller than wide: very wide layered graphs run left to right (render/graphView.ts). */
  tall?: boolean;
}

/**
 * Stable keys for the diagram's boxes. Frames are keyed by their position
 * on the stack and function name, so "the second factorial() call" keeps
 * its place across steps and re-runs. Objects are keyed by id, which both
 * tracers keep stable for the whole run and assign in the same order on
 * every run. A renderer remembers a box the person dragged by its key.
 */
export const nodeKey = {
  frame: (index: number, func: string) => `frame:${index}:${func}`,
  /** A paused frame keeps its identity (its id) wherever it resumes. */
  paused: (id: string) => `paused:${id}`,
  object: (id: string) => `obj:${id}`,
  /** What a step printed. */
  output: "output",
};

export interface SceneFrame {
  frame: Frame;
  key: string;
  /** The frame that's running (the top of the call stack). */
  active: boolean;
  /** Called since the step before. */
  isNew: boolean;
}

/** An object drawn as a box of its own (not nested inside another). */
export interface SceneObject {
  id: string;
  key: string;
  /** Distance from the stack, in references (a binary tree's nodes all count as its first node's). */
  depth: number;
}

/** A graph, drawn as one box in place of the dict or list (or the node objects) that hold it. */
export interface SceneGraph {
  graph: GraphData;
  overlay: GraphOverlay;
  /** How the code's shape suggests laying it out (a grid, a ring, a tree...). */
  layout: GraphLayout;
  /** The same graph at the step before, if it was there: for animating what changed. */
  previous: { graph: GraphData; overlay: GraphOverlay } | null;
  /** Every overlay the legend needs to explain, this step's first. */
  legendOverlays: GraphOverlay[];
}

/** A binary tree of objects, drawn top-down as one block. */
export interface SceneTree {
  root: string;
  /** Node id -> its in-order position, its depth, and its children's ids. */
  nodes: Map<string, { index: number; depth: number; children: string[] }>;
  inOrder: string[];
}

/** An arrow between two boxes, by key: a reference, or from what was printed to an object it printed. */
export interface SceneLink {
  from: string;
  to: string;
  printed?: boolean;
}

export interface SceneOutput {
  printed: Printed;
  /** The objects it printed (as the boxes they're drawn in), once each. */
  targets: string[];
}

export interface MemoryScene {
  /** The window is taller than wide (MemorySceneOptions.tall). */
  tall?: boolean;
  /** The run it's a step of (for what stays the same through it, like arrows' colors). */
  trace: Trace;
  step: Step;
  stepIndex: number;
  language: Trace["language"];
  mode: MemoryMode;
  /** "def" or "function", for function objects' titles. */
  functionKeyword: string;
  /** The call stack, then paused generators and coroutines. */
  frames: SceneFrame[];
  /** Objects with a box of their own, nearest the stack first. */
  objects: SceneObject[];
  /** Objects drawn inside the one thing that refers to them (nested mode). */
  nested: ReadonlySet<string>;
  /** Graphs, by the heap id each is drawn in place of. */
  graphs: ReadonlyMap<string, SceneGraph>;
  /** A node object of a graph -> the graph it's drawn in (arrows to it go to the graph). */
  graphAlias: ReadonlyMap<string, string>;
  trees: SceneTree[];
  /** Every arrow between boxes. */
  links: SceneLink[];
  /** What changed since the step before. */
  changes: StepDiff;
  /** Memory sizes, when they're shown. */
  sizes: StepSizes | null;
  /** Index pointers into a list: level 0 is arr[i]; level 1 is grid[i][j]'s j. */
  pointers(id: string, level?: 0 | 1): Pointer[];
  /** Sliding windows over a list (`viz: window`). */
  windows(id: string): WindowSpan[];
  /** The two cells of a list being compared (`viz: compare`). */
  compares(id: string): CompareSpan[];
  /** Does a list have labeled regions (room for their labels above it)? */
  regionLabels(id: string): boolean;
  /** A box's title: its type, and with `viz: label Node by val`, that field's value. */
  title(obj: HeapObject): string;
  /** The grid cell this step reads or writes (trace/gridFocus.ts), given the grid's shape; null if the code never indexes it by name. */
  gridFocus(id: string, size: { rows: number; cols: (row: number) => number }): GridFocus | null;
  /** The cell a heatmap grid's step works on and the cells it reads (trace/gridFocus.ts gridCells). */
  gridCells(id: string, size: { rows: number; cols: (row: number) => number }): ReturnType<typeof gridCells>;
  /** `viz: heatmap`: the range of numbers a list holds over the run, for coloring its cells; null without the hint. */
  heat(id: string): { min: number; max: number } | null;
  /** `viz: table` or `viz: intervals`: a list (or dict) drawn as a table, or as bars along a number line. */
  drawAs(id: string): DrawAs | null;
  /** What this step printed, or null (or output turned off). */
  output: SceneOutput | null;
  /** The run's longest printed line, in characters, when output is shown and the run prints; else null. */
  longestOutputLine: number | null;
  /** Everything but the output (and what it printed) is dimmed; `entering` or `leaving` on the step where that starts or stops. */
  dim: { on: boolean; entering: boolean; leaving: boolean };
}

/** How a hint draws a list: as a table of its items' keys, or as intervals on a number line. */
export type DrawAs = { kind: "table" } | { kind: "intervals"; min: number; max: number; fields?: [string, string] };

/** The longest printed line of a run, worked out once per trace. */
const longestLines = new WeakMap<Trace, number>();
function longestLine(trace: Trace): number {
  let n = longestLines.get(trace);
  if (n === undefined) {
    n = Math.max(0, ...trace.stdout.split("\n").map((l) => l.length));
    longestLines.set(trace, n);
  }
  return n;
}

/** Binary trees in this step with at least two nodes (none in nested mode, which draws trees as boxes in boxes). */
function findTrees(trace: Trace, step: Step, mode: MemoryMode): SceneTree[] {
  if (mode === "nested") return [];
  const row = { locals: liveFrames(step).flatMap((frame) => frame.locals), heap: step.heap };
  const track = findLinkedTrack([row], trace.viz?.linked, trace.viz?.labels);
  if (track?.shape !== "tree") return [];
  const state = linkedRow(track, row);
  const depths = treeDepths(state);
  const trees: SceneTree[] = [];
  const placed = new Set<string>();
  for (const [id] of state.nodes) {
    if (depths.get(id) !== 0 || placed.has(id)) continue;
    const tree: SceneTree = { root: id, nodes: new Map(), inOrder: [] };
    const visit = (nodeId: string | null, depth: number) => {
      if (!nodeId || placed.has(nodeId) || !state.nodes.has(nodeId)) return;
      placed.add(nodeId);
      const [left, right] = state.nodes.get(nodeId)!.links;
      visit(left, depth + 1);
      tree.nodes.set(nodeId, {
        index: tree.inOrder.length,
        depth,
        children: [left, right].filter((c): c is string => !!c),
      });
      tree.inOrder.push(nodeId);
      visit(right, depth + 1);
    };
    visit(id, 0);
    if (tree.inOrder.length >= 2) trees.push(tree);
  }
  return trees;
}

/** The graphs at a step, by the heap id each one is drawn in place of. */
function findGraphs(trace: Trace, stepIndex: number): Map<string, SceneGraph> {
  const step = trace.steps[stepIndex];
  const before = trace.steps[stepIndex - 1];
  const prev = new Map(
    (before ? graphsAt(trace, before) : []).map((graph) => [
      graph.id,
      { graph, overlay: graphOverlay(trace, graph, stepScopes(before), before.heap) },
    ]),
  );
  const graphs = new Map<string, SceneGraph>();
  for (const graph of graphsAt(trace, step)) {
    const overlay = graphOverlay(trace, graph, stepScopes(step), step.heap);
    graphs.set(graph.hostId, {
      graph,
      overlay,
      layout: layoutFor(trace, graph),
      previous: before ? (prev.get(graph.id) ?? null) : null,
      legendOverlays: [overlay, ...legendOverlaysFor(trace, graph)],
    });
  }
  return graphs;
}

/** The scene for the memory view at one step of a trace. */
export function memoryScene(
  trace: Trace,
  stepIndex: number,
  changes: StepDiff,
  options: MemorySceneOptions = {},
): MemoryScene {
  const step = trace.steps[stepIndex];
  const mode = options.mode ?? "arrows";
  const nested = mode === "nested" ? chooseNested(step) : new Set<string>();

  // Graphs are drawn as one box, in place of the dict or list that holds
  // them (or, for graphs of objects, in place of all the node objects).
  const graphs = findGraphs(trace, stepIndex);
  const graphAlias = new Map<string, string>();
  for (const { graph } of graphs.values()) {
    nested.delete(graph.hostId);
    if (!graph.objectNodes) continue;
    for (const member of graph.members) {
      nested.delete(member);
      // Arrows to any node (or its neighbor list) go to the graph's box.
      if (member !== graph.hostId) graphAlias.set(member, graph.hostId);
    }
  }
  const outgoing = (id: string): Value[] => (graphs.has(id) ? [] : valuesOf(step.heap[id]));

  // A table, a heatmap's grid and intervals draw their items inside them:
  // each item nobody else points to is nested, whatever the mode.
  const viz = trace.viz;
  const ownWay = new Set([
    ...(viz?.tables ?? []),
    ...(viz?.heatmaps ?? []).map((h) => h.name),
    ...(viz?.intervals ?? []).map((h) => h.name),
  ]);
  if (ownWay.size) {
    const incoming = incomingCounts(step);
    for (const frame of liveFrames(step))
      for (const [name, value] of frame.locals) {
        if (!ownWay.has(name) || value.kind !== "ref") continue;
        const holder = step.heap[value.id];
        if (!holder) continue;
        const items =
          holder.kind === "list" || holder.kind === "tuple"
            ? holder.items
            : holder.kind === "dict"
              ? holder.entries.map(([, v]) => v)
              : [];
        for (const item of items)
          if (item.kind === "ref" && step.heap[item.id] && incoming.get(item.id) === 1) nested.add(item.id);
      }
  }

  // Index pointers (i, j, lo, hi...) belong to the variable that holds a list.
  const pointerOwner = new Map<string, { name: string; frame: Frame }>();
  for (const frame of liveFrames(step)) {
    for (const [name, value] of frame.locals)
      if (value.kind === "ref" && !pointerOwner.has(value.id)) pointerOwner.set(value.id, { name, frame });
  }
  // The running frame's names win over paused frames and callers.
  for (const frame of step.stack) {
    for (const [name, value] of frame.locals) if (value.kind === "ref") pointerOwner.set(value.id, { name, frame });
  }

  // References that leave a group of nested boxes: where its arrows go.
  const exits = (values: Value[], out: string[] = []): string[] => {
    for (const value of values) {
      if (value.kind !== "ref" || !step.heap[value.id]) continue;
      if (nested.has(value.id)) exits(outgoing(value.id), out);
      else out.push(graphAlias.get(value.id) ?? value.id);
    }
    return out;
  };

  const trees = findTrees(trace, step, mode);
  const treeOf = new Map<string, SceneTree>();
  for (const tree of trees) for (const id of tree.nodes.keys()) treeOf.set(id, tree);

  // Breadth-first from the stack: each separate box's distance from it.
  // Nested objects aren't boxes of their own: their references count as
  // coming from the box they're drawn in.
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  const enqueue = (id: string, d: number) => {
    if (depth.has(id)) return;
    // A tree's nodes all go with the first one reached.
    for (const member of treeOf.get(id)?.inOrder ?? [id]) {
      if (depth.has(member)) continue;
      depth.set(member, d);
      order.push(member);
      queue.push(member);
    }
  };
  const frames = liveFrames(step);
  const roots = frames.flatMap((frame) => frame.locals.map(([, value]) => value));
  if (step.returnValue) roots.push(step.returnValue);
  for (const id of exits(roots)) enqueue(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of exits(outgoing(id))) enqueue(child, depth.get(id)! + 1);
  }

  const sceneFrames: SceneFrame[] = frames.map((frame, index) => ({
    frame,
    key: frame.state === "suspended" ? nodeKey.paused(frame.id) : nodeKey.frame(index, frame.func),
    active: index === step.stack.length - 1,
    isNew: changes.newFrames.has(frame.id),
  }));
  const objects = order.map((id) => ({ id, key: nodeKey.object(id), depth: depth.get(id)! }));
  const boxes = new Set([...sceneFrames.map((f) => f.key), ...objects.map((o) => o.key)]);

  // Arrows: every reference from a box (or from something nested in it) to
  // another box. A frame also shows what it's returning or yielding.
  const links: SceneLink[] = [];
  const linkFrom = (key: string, values: Value[]) => {
    for (const to of exits(values))
      if (boxes.has(nodeKey.object(to))) links.push({ from: key, to: nodeKey.object(to) });
  };
  for (const { frame, key, active } of sceneFrames) {
    const values = frame.locals.map(([, value]) => value);
    const returns = step.event === "return" && frame.func !== "Global";
    if (active && step.returnValue && (returns || step.event === "yield")) values.push(step.returnValue);
    linkFrom(key, values);
  }
  for (const { id, key } of objects) linkFrom(key, outgoing(id));

  const show = options.output !== false;
  const printed = show ? printedAt(trace, stepIndex) : null;
  let output: SceneOutput | null = null;
  if (printed) {
    const targets = printed.refs
      .map((id) => graphAlias.get(id) ?? id)
      .filter((id, i, all) => boxes.has(nodeKey.object(id)) && all.indexOf(id) === i);
    output = { printed, targets };
    for (const id of targets) links.push({ from: nodeKey.output, to: nodeKey.object(id), printed: true });
  }
  // Dim in when printing starts, and back up the step after.
  const dim = !!options.dimForOutput;
  const printedBefore = show && options.dimForOutput === true && stepIndex > 0 && !!printedAt(trace, stepIndex - 1);

  return {
    tall: options.tall,
    trace,
    step,
    stepIndex,
    language: trace.language,
    mode,
    functionKeyword: trace.language === "python" ? "def" : "function",
    frames: sceneFrames,
    objects,
    nested,
    graphs,
    graphAlias,
    trees,
    links,
    changes,
    sizes: options.sizes ? stepSizes(step, options.sizes) : null,
    pointers(id, level = 0) {
      const owner = pointerOwner.get(id);
      if (!owner) return [];
      const changedNames = new Set(
        owner.frame.locals.map(([n]) => n).filter((n) => changes.changedLocals.has(localKey(owner.frame.id, n))),
      );
      const name = level === 1 ? `${owner.name}[]` : owner.name;
      return pointersFor(name, trace.indexNames, new Map(owner.frame.locals), changedNames);
    },
    windows(id) {
      const owner = pointerOwner.get(id);
      if (!owner || !trace.viz?.windows?.length) return [];
      const changedNames = new Set(
        owner.frame.locals.map(([n]) => n).filter((n) => changes.changedLocals.has(localKey(owner.frame.id, n))),
      );
      return windowsFor(owner.name, trace.viz.windows, new Map(owner.frame.locals), changedNames);
    },
    compares(id) {
      const owner = pointerOwner.get(id);
      if (!owner || !trace.viz?.compares?.length) return [];
      const changedNames = new Set(
        owner.frame.locals.map(([n]) => n).filter((n) => changes.changedLocals.has(localKey(owner.frame.id, n))),
      );
      return comparesFor(owner.name, trace.viz.compares, new Map(owner.frame.locals), changedNames);
    },
    regionLabels(id) {
      const owner = pointerOwner.get(id);
      return !!owner && hasRegionLabels(owner.name, trace.viz?.windows);
    },
    title(obj) {
      const label = trace.viz?.labels?.find((l) => l.typeName === obj.typeName);
      if (!label || obj.kind !== "object") return obj.typeName;
      const value = obj.fields.find(([name]) => name === label.field)?.[1];
      return value?.kind === "prim" ? `${obj.typeName} ${value.repr}` : obj.typeName;
    },
    gridFocus(id, size) {
      const owner = pointerOwner.get(id);
      if (!owner) return null;
      return gridFocus(
        trace.gridAccesses,
        owner.name,
        focusLines(trace, stepIndex),
        new Map(owner.frame.locals),
        size,
        trace.language === "python",
      );
    },
    gridCells(id, size) {
      const owner = pointerOwner.get(id);
      if (!owner) return null;
      return gridCells(
        trace.gridAccesses,
        owner.name,
        focusLines(trace, stepIndex),
        new Map(owner.frame.locals),
        size,
        trace.language === "python",
      );
    },
    heat(id) {
      const owner = pointerOwner.get(id);
      const hint = owner && viz?.heatmaps?.find((h) => h.name === owner.name);
      return hint ? { min: hint.min ?? 0, max: hint.max ?? 0 } : null;
    },
    drawAs(id) {
      const owner = pointerOwner.get(id);
      if (!owner) return null;
      if (viz?.tables?.includes(owner.name)) return { kind: "table" };
      const hint = viz?.intervals?.find((h) => h.name === owner.name);
      if (!hint) return null;
      return {
        kind: "intervals",
        min: hint.min ?? 0,
        max: hint.max ?? 1,
        ...(hint.fields ? { fields: hint.fields } : {}),
      };
    },
    output,
    longestOutputLine: show && trace.stdout ? longestLine(trace) : null,
    dim: { on: !!printed && dim, entering: !!printed && dim && !printedBefore, leaving: !printed && printedBefore },
  };
}

/** The values a box shows, for tests and renderers that walk them: a frame's locals, an object's slots and keys. */
export function boxValues(scene: MemoryScene, key: string): Value[] {
  const frame = scene.frames.find((f) => f.key === key);
  if (frame) return frame.frame.locals.map(([, value]) => value);
  const id = key.startsWith("obj:") ? key.slice(4) : null;
  const obj = id ? scene.step.heap[id] : undefined;
  return obj ? [...(obj.kind === "dict" ? obj.entries.map(([k]) => k) : []), ...slotsOf(obj).values()] : [];
}
