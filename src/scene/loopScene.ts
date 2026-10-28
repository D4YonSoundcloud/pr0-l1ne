/**
 * The loop history's scene: one loop's passes (trace/loopHistory.ts), and
 * everything the loop view shows about them, worked out from the trace with
 * no positions and no pixels.
 *
 * It says which containers and scalars are worth showing, which of them is a
 * grid, the graph and linked structure (list or tree) in each row, which rows
 * changed something, where runs of quiet passes collapse into one band and
 * where unrecorded passes were skipped, each run's header, and each row's
 * label, pointers and sizes. A renderer decides where it goes and how it
 * looks (render/loopView.ts draws it as SVG). See docs/how-it-works.md,
 * "Scenes and renderers".
 */
import { valueKey } from "../trace/diff";
import { evaluateText, showVal, truthy } from "../trace/expr";
import {
  findGraphs,
  type GraphData,
  type GraphLayout,
  type GraphOverlay,
  graphOverlay,
  graphSignature,
  layoutFor,
  legendOverlaysFor,
  type Scope,
} from "../trace/graph";
import { focusLines, type GridFocus, gridFocus } from "../trace/gridFocus";
import { findLinkedTrack, type LinkedRow, type LinkedTrack, linkedRow, linkedSignature } from "../trace/linked";
import { type LoopHistory, type LoopRow, runKey } from "../trace/loopHistory";
import { type SizeModel, type StepSizes, stepSizes } from "../trace/memory";
import {
  type HeapObject,
  type LoopInfo,
  liveFrames,
  type SequenceObject,
  type Trace,
  type Value,
} from "../trace/types";
import { type Pointer, pointersFor } from "./pointers";
import { type CompareSpan, comparesFor, hasRegionLabels, type WindowSpan, windowsFor } from "./windows";

// ---------------------------------------------------------------------------
// Reading a row
// ---------------------------------------------------------------------------

export type ContainerObject = Extract<HeapObject, { kind: "list" | "tuple" | "set" | "dict" }>;

export interface Cell {
  key: string;
  label: string;
  value: Value;
}

export function isContainer(obj: HeapObject | undefined): obj is ContainerObject {
  return !!obj && (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set" || obj.kind === "dict");
}

export function cellsOf(obj: ContainerObject): Cell[] {
  switch (obj.kind) {
    case "dict":
      return obj.entries.map(([key, value]) => ({
        key: valueKey(key),
        label: key.kind === "prim" ? key.repr : "•",
        value,
      }));
    case "set":
      return obj.items.map((value) => ({ key: valueKey(value), label: "", value }));
    default: {
      // A long list's items are a window of it: keys and labels are real indices.
      const offset = obj.offset ?? 0;
      // A number's bits (viz: bits) count from the right: bit 0 is the last cell.
      return obj.items.map((value, index) => ({
        key: String(offset + index),
        label: String(obj.typeName === "bits" ? obj.length - 1 - (offset + index) : offset + index),
        value,
      }));
    }
  }
}

export function containerIn(row: LoopRow, name: string): ContainerObject | undefined {
  const value = row.frame.locals.find(([n]) => n === name)?.[1];
  if (value?.kind !== "ref") return undefined;
  const obj = row.heap[value.id];
  return isContainer(obj) ? obj : undefined;
}

/** Changes whenever the container or a list directly inside it changes. */
export function signature(row: LoopRow, name: string): string {
  const obj = containerIn(row, name);
  if (!obj) return "";
  return `${obj.id}|${cellsOf(obj)
    .map((c) => {
      const inner = c.value.kind === "ref" ? row.heap[c.value.id] : undefined;
      const deep = isContainer(inner)
        ? `[${cellsOf(inner)
            .map((ic) => valueKey(ic.value))
            .join(",")}]`
        : "";
      return `${c.key}=${valueKey(c.value)}${deep}`;
    })
    .join(",")}`;
}

export type Sequence = SequenceObject;

/** A list of lists in this row, as its rows; null if it isn't one. */
export function gridIn(row: LoopRow, name: string): Sequence[] | null {
  const obj = containerIn(row, name);
  if (!obj || (obj.kind !== "list" && obj.kind !== "tuple") || !obj.items.length) return null;
  const rows: Sequence[] = [];
  for (const item of obj.items) {
    const inner = item.kind === "ref" ? row.heap[item.id] : undefined;
    if (inner?.kind !== "list" && inner?.kind !== "tuple") return null;
    rows.push(inner);
  }
  return rows;
}

export function scalarIn(row: LoopRow, name: string): Value | undefined {
  const value = row.frame.locals.find(([n]) => n === name)?.[1];
  return value?.kind === "prim" ? value : undefined;
}

/** Decide which containers and scalars are worth showing for this loop. */
function pickVariables(
  trace: Trace,
  rows: LoopRow[],
  hasTrack: boolean,
  exclude: Set<string>,
): { containers: string[]; scalars: string[] } {
  const containerNames: string[] = [];
  const scalarNames: string[] = [];
  for (const row of rows) {
    for (const [name, value] of row.frame.locals) {
      if (value.kind === "ref" && isContainer(row.heap[value.id])) {
        if (!containerNames.includes(name) && !exclude.has(name)) containerNames.push(name);
      } else if (value.kind === "prim" && !scalarNames.includes(name)) {
        scalarNames.push(name);
      }
    }
  }

  const changes = (read: (row: LoopRow) => string) => rows.some((row, i) => i > 0 && read(row) !== read(rows[i - 1]));
  // An indexed list is worth showing even if it never changes, because its
  // pointer markers (i, lo, hi...) move. Dicts and objects don't get pointer
  // markers, so they're only shown when they change.
  const isSequence = (name: string) =>
    rows.some((row) => {
      const kind = containerIn(row, name)?.kind;
      return kind === "list" || kind === "tuple";
    });
  // `viz: show name` always includes it.
  const shown = new Set(trace.viz?.show ?? []);
  let containers = containerNames.filter(
    (name) =>
      shown.has(name) ||
      (trace.indexNames[name] !== undefined && isSequence(name)) ||
      changes((row) => signature(row, name)),
  );
  // With nothing else to show, fall back to every container. A linked track
  // counts as something to show.
  if (!containers.length && !hasTrack) containers = containerNames.slice(0, 4);

  const lastLocals = new Map(rows[rows.length - 1].frame.locals);
  const indexVars = new Set(
    containers.flatMap((name) =>
      [
        ...pointersFor(name, trace.indexNames, lastLocals),
        ...pointersFor(`${name}[]`, trace.indexNames, lastLocals),
      ].map((p) => p.name),
    ),
  );
  let scalars = scalarNames.filter(
    (name) =>
      shown.has(name) ||
      indexVars.has(name) ||
      changes((row) => {
        const v = scalarIn(row, name);
        return v ? valueKey(v) : "";
      }),
  );
  if (!scalars.length) scalars = scalarNames.slice(0, 6);
  return { containers, scalars };
}

// ---------------------------------------------------------------------------
// Loop headers, items and linked chains
// ---------------------------------------------------------------------------

export type LoopItem =
  | { kind: "row"; row: LoopRow; index: number }
  /** Passes that changed nothing, collapsed. `run`: the loop run they're passes of. */
  | { kind: "band"; from: number; to: number; run: string; name: string | null }
  /** Passes that ran but weren't recorded (a sampled loop). */
  | { kind: "gap"; from: number; to: number; name: string | null }
  /** A run of a loop starts: its header as written, and with its values. */
  | { kind: "header"; loop: string; call: string | undefined; depth: number };

/** A loop's variable, from its header: "for j in ..." / "for (let j = ..." -> "j". Null for while loops. */
export function loopVariable(info: LoopInfo | undefined): string | null {
  if (info?.kind !== "for") return null;
  const m = /^(?:async\s+)?for\s+\(?\s*(?:(?:let|const|var)\s+)?\[?\s*([A-Za-z_$][\w$]*)/.exec(info.header);
  return m ? m[1] : null;
}

/**
 * A loop's header with this run's values: Python's range as it was
 * (`for j in range(0, 3)`), JavaScript's start and bound
 * (`for (j = 0; j < 3; j++)`).
 */
export function evaluatedHeader(info: LoopInfo, call: string): string {
  if (/^(async\s+)?for\s+\(/.test(info.header)) return `for (${call})`;
  const at = info.header.lastIndexOf(" in ");
  return at >= 0 ? `${info.header.slice(0, at)} in ${call}` : call;
}

/** The linked structure at every step of this run of the loop after the last row (up to 3,000 steps). */
function laterRows(trace: Trace, history: LoopHistory, track: LinkedTrack): LinkedRow[] {
  const ctx = history.context;
  const last = history.rows[history.rows.length - 1];
  const out: LinkedRow[] = [];
  if (!last) return out;
  for (let i = last.stepIndex + 1; i < Math.min(trace.steps.length, last.stepIndex + 3000); i++) {
    const step = trace.steps[i];
    if (!step.loops.some((c) => c.frame === ctx.frame && c.loop === ctx.loop && c.instance === ctx.instance)) break;
    const frame = liveFrames(step).find((f) => f.id === ctx.frame);
    if (frame) out.push(linkedRow(track, { locals: frame.locals, heap: step.heap }));
  }
  return out;
}

/**
 * Separate lists: nodes joined by a link in any row are in the same chain,
 * so a node stays on one line from row to row. Chains in the order their
 * first node appears in the track.
 */
export function linkedChains(order: string[], rows: (LinkedRow | null)[]): string[][] {
  const parent = new Map(order.map((id) => [id, id]));
  const find = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    parent.set(id, at);
    return at;
  };
  for (const row of rows) {
    for (const [id, node] of row?.nodes ?? []) {
      for (const target of node.links) {
        if (target !== null && parent.has(target) && parent.has(id)) parent.set(find(id), find(target));
      }
    }
  }
  const chains = new Map<string, string[]>();
  for (const id of order) {
    const root = find(id);
    if (!chains.has(root)) chains.set(root, []);
    chains.get(root)!.push(id);
  }
  return [...chains.values()];
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export interface LoopSceneOptions {
  /** Collapse runs of passes that changed nothing into one band. */
  hideQuiet: boolean;
  /** Show each container's total memory size under its name. */
  sizes?: SizeModel | null;
  /**
   * Animated mode: just the live state (`current`), compared with the
   * previous step (`prev`), instead of a row per iteration. What to show
   * still comes from the full history, so the picture stays steady from
   * step to step. With every loop together (a nested history), one live row
   * per loop, outermost first: each inner loop under the loop around it.
   */
  live?: LiveRow | LiveRow[];
  /** The window is taller than wide: very wide layered graphs run left to right (render/graphView.ts). */
  tall?: boolean;
}

/** One loop's live state in animated mode. */
export interface LiveRow {
  prev: LoopRow;
  current: LoopRow;
  /** The loop isn't running at this step: its row is how it last was. */
  done?: boolean;
}

/** The graph in view, drawn in every row with that row's state on it. */
export interface LoopGraph {
  /** The graph as first found: its name, and how to lay it out. */
  first: GraphData;
  layout: GraphLayout;
  /** Every overlay the legend needs to explain, across the rows. */
  overlays: GraphOverlay[];
  /** Each row's graph and overlay (null where it isn't there), lined up with `all`. */
  rows: ({ graph: GraphData; overlay: GraphOverlay } | null)[];
}

/** A linked list or binary tree in view, drawn in every row. */
export interface LoopTrack {
  track: LinkedTrack;
  /** Each row's nodes and links, lined up with `all`. */
  rows: LinkedRow[];
  /** Separate lists (nodes ever linked together), over the loop's whole run, in the order they first appear. */
  chains(): string[][];
}

export interface LoopScene {
  /** The window is taller than wide (LoopSceneOptions.tall). */
  tall?: boolean;
  history: LoopHistory;
  /** The history's rows (passes). */
  rows: LoopRow[];
  /** Every row measured: the history's, then in animated mode the live previous and current. */
  all: LoopRow[];
  /** Animated mode: each live row, outermost loop first (just one unless every loop is together). */
  live: LiveRow[] | null;
  /** Containers worth showing (they change, are indexed, or are hinted), and which of them are grids. */
  containers: string[];
  grids: ReadonlySet<string>;
  /** Scalars worth showing. */
  scalars: string[];
  graph: LoopGraph | null;
  track: LoopTrack | null;
  /** Anything to draw besides scalars. */
  hasContent: boolean;
  /** Per history row: did it change something since the row before? */
  changed: boolean[];
  /** What to draw, in order: rows, quiet bands, unrecorded gaps and run headers. */
  items: LoopItem[];
  /** Rows left out from the start (the history was too long). */
  hiddenRows: number;
  /** The row the first drawn row compares with (animated mode: the step before). */
  before: { row: LoopRow; index: number } | null;
  /** A row's label: "before", "#3", or with every loop together "j #3". */
  label(row: LoopRow): string;
  /** How deeply a row's loop is nested (0 unless every loop is shown together). */
  depth(row: LoopRow): number;
  /** A row's run header line, with its values when known (for measuring). */
  header(row: LoopRow): string;
  /** Is this row (by its index in `all`) the one running now? */
  isCurrent(index: number): boolean;
  /** Memory sizes at a row's own step, when they're shown. */
  sizes(row: LoopRow): StepSizes | null;
  /** Index pointers into a container in a row (`name[]`: a grid's columns). */
  pointers(row: LoopRow, name: string, changedNames?: Set<string>): Pointer[];
  /** Sliding windows and labeled regions over a list in a row (`viz: window`, `viz: region`). */
  windows(row: LoopRow, name: string, changedNames?: Set<string>): WindowSpan[];
  /** The two cells of a list being compared in a row (`viz: compare`). */
  compares(row: LoopRow, name: string, changedNames?: Set<string>): CompareSpan[];
  /** Does a container have labeled regions (room for their labels above it)? */
  regionLabels(name: string): boolean;
  /** `viz: heatmap`: the run's range of numbers for a container's cell colors; null without the hint. */
  heat(name: string): { min: number; max: number } | null;
  /** `viz: watch` expressions, worked out in a row: their text, and value ("?" where it can't be worked out). */
  watches(row: LoopRow): { text: string; value: string }[];
  /** `viz: check` invariants that are false in a row. */
  failedChecks(row: LoopRow): string[];
  /** The grid cell a row's step reads or writes. */
  gridFocus(row: LoopRow, name: string, size: { rows: number; cols: (row: number) => number }): GridFocus | null;
  /** The loop's info, by id (the history's own when not given). */
  info(loop?: string): LoopInfo | undefined;
}

/** Rows drawn at most; earlier ones are left out. */
const MAX_ROWS = 120;

/** Graphs found in each loop row, by step and frame: the same for the whole run. */
const graphCache = new WeakMap<Trace, Map<string, GraphData[]>>();

/** The scene for the loop history of one loop (or every loop together). */
export function loopScene(trace: Trace, history: LoopHistory, options: LoopSceneOptions): LoopScene {
  const { rows } = history;
  const live = options.live ? (Array.isArray(options.live) ? options.live : [options.live]) : null;
  // Every row that will be measured; in animated mode, plus each live one's previous and current.
  const all = live ? [...rows, ...live.flatMap((l) => [l.prev, l.current])] : rows;
  // A graph in view (the loop's variables, or globals): drawn in every row
  // with that row's state on it. The first one found wins; hinted ones
  // are found first.
  const scopesOf = (row: LoopRow): Scope[] => {
    const global = trace.steps[row.stepIndex]?.stack[0];
    return global && global.id !== row.frame.id ? [global.locals, row.frame.locals] : [row.frame.locals];
  };
  let cache = graphCache.get(trace);
  if (!cache) {
    cache = new Map();
    graphCache.set(trace, cache);
  }
  const found = all.map((row) => {
    const key = `${row.stepIndex}:${row.frame.id}`;
    let graphs = cache!.get(key);
    if (!graphs) {
      graphs = findGraphs(trace, scopesOf(row), row.heap);
      cache!.set(key, graphs);
    }
    return graphs;
  });
  const graphId = found.flat()[0]?.id;
  const graphRows = all.map((row, i) => {
    const graph = graphId ? found[i].find((g) => g.id === graphId) : undefined;
    return graph ? { graph, overlay: graphOverlay(trace, graph, scopesOf(row), row.heap) } : null;
  });
  const firstGraph = graphRows.find(Boolean)?.graph;
  // The graph's own container isn't repeated as a row of cells.
  const graphHosts = new Set(graphRows.flatMap((r) => (r ? [r.graph.hostId] : [])));
  const exclude = new Set(
    all.flatMap((row) =>
      row.frame.locals
        .filter(([, v]) => v.kind === "ref" && graphHosts.has(v.id) && !firstGraph?.objectNodes)
        .map(([name]) => name),
    ),
  );

  let track = findLinkedTrack(
    all.map((row) => ({ locals: row.frame.locals, heap: row.heap })),
    trace.viz?.linked,
    trace.viz?.labels,
  );
  if (track && firstGraph?.objectNodes && track.typeName === firstGraph.name) track = null;
  const trackRows: (LinkedRow | null)[] = all.map((row) =>
    track ? linkedRow(track, { locals: row.frame.locals, heap: row.heap }) : null,
  );
  const { containers, scalars } = pickVariables(trace, rows, !!track || !!firstGraph, exclude);
  // A list of lists in every row where it has items: drawn as a grid.
  const grids = new Set(
    containers.filter((name) => {
      const present = all.filter((row) => containerIn(row, name) && cellsOf(containerIn(row, name)!).length);
      return present.length > 0 && present.every((row) => gridIn(row, name));
    }),
  );

  const info = (loop?: string) => trace.loops.find((l) => l.id === (loop ?? history.info.id));
  const runOf = (row: LoopRow) =>
    row.loop !== undefined
      ? runKey(row.loop, row.instance ?? 0)
      : runKey(history.context.loop, history.context.instance);
  const nameOf = (row: LoopRow) => (history.nested ? loopVariable(info(row.loop)) : null);
  const language =
    trace.language === "python" ? "python" : trace.language === "typescript" ? "typescript" : "javascript";
  /** "i = 3" for `viz: rows by i`: the first name in its loop's header, or else the first it has. */
  const rowsBy = (row: LoopRow): string | null => {
    const names = trace.viz?.rowsBy;
    if (!names?.length) return null;
    const locals = new Map(row.frame.locals);
    const header = info(row.loop ?? history.info.id)?.header ?? "";
    const words = new Set(header.match(/[A-Za-z_$][\w$]*/g) ?? []);
    // With nested loops together, a loop without one of the names in its header keeps "j #3".
    const candidates = history.nested
      ? names.filter((n) => words.has(n))
      : [...names.filter((n) => words.has(n)), ...names];
    const name = candidates.find((n) => locals.get(n)?.kind === "prim");
    const value = name ? locals.get(name) : undefined;
    return name && value?.kind === "prim" ? `${name} = ${value.repr}` : null;
  };
  const hasContent = containers.length > 0 || !!track || !!firstGraph;

  // Which rows changed something compared with the row before?
  const trackSignature = (i: number) => (trackRows[i] ? linkedSignature(trackRows[i]!) : "");
  const changed = rows.map(
    (row, i) =>
      i === 0 ||
      containers.some((name) => signature(row, name) !== signature(rows[i - 1], name)) ||
      trackSignature(i) !== trackSignature(i - 1) ||
      graphSignature(graphRows[i]?.graph, graphRows[i]?.overlay) !==
        graphSignature(graphRows[i - 1]?.graph, graphRows[i - 1]?.overlay),
  );

  // Collapse runs of quiet iterations into a single band, but only for loops
  // that mutate data. In a read-only loop (a search, a scan) the moving
  // indices are the story, so every row stays.
  const mutates = changed.some((c, i) => c && i > 0);
  let items: LoopItem[] = [];
  const lastPass = new Map<string, number>();
  rows.forEach((row, index) => {
    const isLast = index === rows.length - 1;
    const run = runOf(row);
    // A run of a loop starts: its header, with its values when known. With
    // every loop together, each inner run gets one, so you can see which
    // range it covers.
    if (!lastPass.has(run)) {
      const call = history.calls.get(run);
      if (call || (history.nested && (row.depth ?? 0) > 0))
        items.push({
          kind: "header",
          loop: row.loop ?? history.info.id,
          call,
          depth: history.nested ? (row.depth ?? 0) : 0,
        });
    }
    const before = lastPass.get(run);
    lastPass.set(run, row.iteration);
    const name = nameOf(row);
    if (before !== undefined && row.iteration - before > 1)
      items.push({ kind: "gap", from: before + 1, to: row.iteration - 1, name });
    if (!options.hideQuiet || !mutates || changed[index] || isLast || !hasContent) {
      items.push({ kind: "row", row, index });
      return;
    }
    const prev = items[items.length - 1];
    if (prev?.kind === "band" && prev.run === run) prev.to = row.iteration;
    else items.push({ kind: "band", from: row.iteration, to: row.iteration, run, name });
  });
  let hiddenRows = 0;
  const rowItems = items.filter((item) => item.kind === "row").length;
  if (rowItems > MAX_ROWS) {
    let toDrop = rowItems - MAX_ROWS;
    while (toDrop > 0 && items.length) {
      const dropped = items.shift()!;
      if (dropped.kind === "row") {
        toDrop--;
        hiddenRows++;
      }
    }
  }
  let before: LoopScene["before"] = null;
  if (live) {
    // A row per live loop: its state, compared with the step before it.
    // Each inner loop's row goes under the loop around it, after its header.
    items = [];
    live.forEach((l, i) => {
      const index = rows.length + 2 * i + 1;
      if (i > 0 && history.nested) {
        items.push({
          kind: "header",
          loop: l.current.loop ?? history.info.id,
          call: history.calls.get(runOf(l.current)),
          depth: l.current.depth ?? 0,
        });
      }
      items.push({ kind: "row", row: l.current, index });
    });
    before = { row: live[0].prev, index: rows.length };
  }

  /** The live row (by its place in `live`) of the deepest loop still running, or -1. */
  let innermostRunning = -1;
  live?.forEach((l, i) => {
    if (l.done) return;
    if (innermostRunning < 0 || (l.current.depth ?? 0) >= (live[innermostRunning].current.depth ?? 0))
      innermostRunning = i;
  });

  const tracked = track;
  return {
    tall: options.tall,
    history,
    rows,
    all,
    live,
    containers,
    grids,
    scalars,
    graph: firstGraph
      ? {
          first: firstGraph,
          layout: layoutFor(trace, firstGraph),
          overlays: [...graphRows.flatMap((r) => (r ? [r.overlay] : [])), ...legendOverlaysFor(trace, firstGraph)],
          rows: graphRows,
        }
      : null,
    track: tracked
      ? {
          track: tracked,
          rows: trackRows as LinkedRow[],
          // Over the loop's whole run, not just up to this step, so a node
          // that gets linked in later is on its list's line from the start.
          chains: () => linkedChains(tracked.order, [...trackRows, ...laterRows(trace, history, tracked)]),
        }
      : null,
    hasContent,
    changed,
    items,
    hiddenRows,
    before,
    label: (row) => {
      if (row.iteration === 0) return "before";
      // `viz: rows by i`: the loop's own variable's value, where it has one.
      const by = rowsBy(row);
      if (by) return by;
      return `${nameOf(row) ? `${nameOf(row)} ` : ""}#${row.iteration}`;
    },
    depth: (row) => (history.nested ? (row.depth ?? 0) : 0),
    header(row) {
      const loop = info(row.loop ?? history.info.id);
      const call = history.calls.get(runOf(row));
      return loop ? `${loop.header}${call ? `  →  ${evaluatedHeader(loop, call)}` : ""}` : "";
    },
    // Animated nested loops: only the innermost loop running gets the
    // running row's highlight; the loops around it are running too, but
    // they're waiting on it.
    isCurrent: (index) =>
      live ? (index - rows.length - 1) / 2 === innermostRunning : history.running && index === rows.length - 1,
    sizes: (row) =>
      options.sizes && trace.steps[row.stepIndex] ? stepSizes(trace.steps[row.stepIndex], options.sizes) : null,
    pointers: (row, name, changedNames) => pointersFor(name, trace.indexNames, new Map(row.frame.locals), changedNames),
    windows: (row, name, changedNames) => windowsFor(name, trace.viz?.windows, new Map(row.frame.locals), changedNames),
    compares: (row, name, changedNames) =>
      comparesFor(name, trace.viz?.compares, new Map(row.frame.locals), changedNames),
    regionLabels: (name) => hasRegionLabels(name, trace.viz?.windows),
    heat: (name) => {
      const hint = trace.viz?.heatmaps?.find((h) => h.name === name);
      return hint ? { min: hint.min ?? 0, max: hint.max ?? 0 } : null;
    },
    watches: (row) =>
      (trace.viz?.watches ?? []).map((w) => {
        const value = evaluateText(w.text, new Map(row.frame.locals), row.heap, language);
        return { text: w.text, value: value === undefined ? "?" : showVal(value, language) };
      }),
    failedChecks: (row) =>
      (trace.viz?.checks ?? []).flatMap((c) => {
        const value = evaluateText(c.text, new Map(row.frame.locals), row.heap, language);
        // Only a check that can be worked out here, and is false, fails.
        return value !== undefined && !truthy(value) ? [c.text] : [];
      }),
    gridFocus: (row, name, size) =>
      gridFocus(
        trace.gridAccesses,
        name,
        focusLines(trace, row.stepIndex),
        new Map(row.frame.locals),
        size,
        trace.language === "python",
      ),
    info,
  };
}
