/**
 * Drawing only the loop rows that changed since the last step, as
 * memoryView/boxCache.ts does for boxes.
 *
 * In stacked mode a step adds at most a row (or moves which row is the
 * current one), but each step drew every row again: a 60 × 60 grid in 120
 * rows is about 430,000 cells. A row's drawing is the same as last step's
 * when it's the same pass of the loop, compared with the same row above it
 * (as far above as before: a row is drawn from its own top and moved into
 * place, layout.ts, so one that moves down, past a fold growing above it
 * or earlier rows left out, is the same marks), under the same plan (columns, their places
 * and widths) and the same things the whole loop view shares (which
 * variables and containers are shown, heatmap ranges...). Then its marks go
 * into the new drawing as they are (Mark.appendShared): the SVG patcher and
 * the canvas skip them at once.
 *
 * A pass is known by the trace data it's drawn from: its step, its frame and
 * its heap (compared by identity: the trace never changes them, and a
 * history built again for the next step points to the same ones). Every
 * other thing a row reads from the scene is worked out from those and the
 * run's hints, the same each step. What is shared by the whole view goes in
 * one key per drawing (sceneKey); what is the row's own, in its key
 * (rowKey). A graph's layout and legend, and a linked track's columns, are
 * worked out across every row, so they're in the drawing's key: rows are
 * kept while they stay the same, and drawn again when they change (a new
 * node in the track, a new kind of mark in the legend).
 */
import { containerIn, type LoopScene } from "../../scene/loopScene";
import type { LoopRow } from "../../trace/loopHistory";
import type { Mark } from "../drawing";
import { legendItems } from "../graphView";
import type { LoopPlan } from "./plan";
import type { DrawnRow } from "./row";

/** Numbers for objects, so keys can name them (the objects aren't kept alive by it). */
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(obj: object | null | undefined): number {
  if (!obj) return 0;
  let id = ids.get(obj);
  if (id === undefined) {
    id = nextId++;
    ids.set(obj, id);
  }
  return id;
}

/** A pass of the loop, by the trace data it's drawn from. */
export const passKey = (row: LoopRow | null | undefined): string =>
  row
    ? `${row.stepIndex}.${idOf(row.frame)}.${idOf(row.heap)}.${row.iteration}.${row.loop ?? ""}.${row.instance ?? ""}.${row.depth ?? ""}`
    : "-";

/** What every row of a drawing shares: the plan, and what the scene shows. Null when rows can't be kept. */
export function sceneKey(scene: LoopScene, plan: LoopPlan, vertical: boolean): string | null {
  if (scene.live) return null;
  const graph = plan.graph
    ? {
        first: idOf(scene.graph?.first),
        name: scene.graph?.first.name,
        layout: idOf(plan.graph.layout),
        legend: legendItems(plan.graph.overlays),
        x: plan.graph.x,
        h: plan.graph.h,
        top: plan.graphTop,
      }
    : null;
  const track = plan.track
    ? {
        type: plan.track.track.typeName,
        links: plan.track.track.links,
        value: plan.track.track.valueField,
        shape: plan.track.track.shape,
        order: plan.track.track.order,
        x: plan.track.x,
        valueW: plan.track.valueW,
        nodeW: plan.track.nodeW,
        places: plan.track.places ? [...plan.track.places] : null,
        lines: plan.track.lines ?? null,
        lineStep: plan.track.lineStep ?? null,
        top: plan.trackTop,
      }
    : null;
  return JSON.stringify({
    graph,
    track,
    vertical,
    tall: !!scene.tall,
    nested: !!scene.history.nested,
    loop: scene.history.info.id,
    scalars: scene.scalars,
    containers: scene.containers,
    grids: [...scene.grids].sort(),
    plan: {
      gutter: plan.gutter,
      columns: plan.columns,
      cellsTop: plan.columns.map((c) => plan.cellsTop(c)),
      isTree: plan.isTree,
      vertical: plan.vertical,
      scalarsX: plan.scalarsX,
      contentW: plan.contentW,
      rowTop: plan.rowTop,
      rowH: plan.rowH,
    },
    heat: plan.columns.map((c) => scene.heat(c.name)),
    regions: plan.columns.map((c) => scene.regionLabels(c.name)),
  });
}

/** What a row's drawing is made from, besides what the whole drawing shares. */
export function rowKey(
  scene: LoopScene,
  plan: LoopPlan,
  row: LoopRow,
  index: number,
  /** The row drawn above, where it is from this row's top (rows are drawn from their own top). */
  prevDrawn: DrawnRow | null,
  afterGap: boolean,
): string {
  const prevRow = index > 0 ? scene.all[index - 1] : null;
  const sizes = scene.sizes(row);
  const graphRow = scene.graph?.rows[index];
  const trackRow = scene.track?.rows[index];
  const prevTrack = prevDrawn ? scene.track?.rows[prevDrawn.index] : null;
  const prevGraph = prevDrawn ? scene.graph?.rows[prevDrawn.index] : null;
  return [
    passKey(row),
    index,
    scene.isCurrent(index) ? 1 : 0,
    passKey(prevRow),
    prevDrawn ? `${passKey(prevDrawn.row)}@${prevDrawn.y}#${prevDrawn.index}` : "-",
    afterGap ? 1 : 0,
    plan.labelOf(row),
    plan.indentOf(row),
    scene.depth(row),
    // Memory sizes, if shown: the containers' totals, as the row writes them.
    sizes
      ? `${sizes.approximate}:${plan.columns.map((c) => {
          const obj = containerIn(row, c.name);
          return obj ? sizes.total(obj.id) : "";
        })}`
      : "-",
    // The row's graph and linked nodes (kept per row, so the same objects when the same).
    graphRow ? `${idOf(graphRow.graph)}/${idOf(graphRow.overlay)}` : "-",
    prevGraph ? `${idOf(prevGraph.graph)}/${idOf(prevGraph.overlay)}` : "-",
    trackRow ? idOf(trackRow) : "-",
    prevTrack ? idOf(prevTrack) : "-",
    // Their memory sizes, if shown.
    sizes && graphRow
      ? graphRow.graph.objectNodes
        ? sizes.of([...graphRow.graph.nodes.keys()].map((id) => ({ kind: "ref" as const, id })))
        : sizes.total(graphRow.graph.hostId)
      : "-",
    sizes && trackRow ? sizes.of([...trackRow.nodes.keys()].map((id) => ({ kind: "ref" as const, id }))) : "-",
  ].join("|");
}

/** A row as drawn: its group, and the change arrows it added above every row. */
interface Kept {
  row: Mark;
  arrows: Mark[];
}

/** Rows kept from one drawing of a loop view to the next. Give the same one to each drawing of a window. */
export class RowCache {
  private kept = new Map<string, Kept>();
  private next = new Map<string, Kept>();
  private scene: string | null = null;
  /** The least detail any kept row was built with. */
  private level = 0;
  stats = { drawn: 0, kept: 0 };

  /**
   * A drawing begins, of a scene with this key (sceneKey), built at this
   * level of detail (lod.ts buildAt). Rows built with more detail are kept
   * for one with less (atLevel leaves out the rest); not the other way.
   */
  begin(key: string | null, level = 0): void {
    if (key !== this.scene || level < this.level) {
      this.kept.clear();
      this.level = level;
    } else this.level = Math.max(this.level, level);
    this.scene = key;
    this.next = new Map();
    this.stats = { drawn: 0, kept: 0 };
  }

  end(): void {
    this.kept = this.next;
    this.next = new Map();
  }

  /** Can rows be kept in this drawing? */
  get on(): boolean {
    return this.scene !== null;
  }

  get(key: string): Kept | undefined {
    const kept = this.kept.get(key);
    if (kept) {
      this.next.set(key, kept);
      this.stats.kept++;
    }
    return kept;
  }

  set(key: string, kept: Kept): void {
    this.next.set(key, kept);
    this.stats.drawn++;
  }
}

/** A span of the drawing, top to bottom, in diagram units. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * Which rows a loop window draws: those in view and a window's height more
 * above and below, so a little panning needs nothing new. When the view
 * moves past what was drawn, the window draws its step again (`stale`).
 * With Auto-fit on, the whole history is in view: every row is drawn.
 */
export class RowsInView {
  /** What the last drawing covered: undefined, everything. */
  private drawn: Span | undefined;

  /** The span to draw now (LoopViewOptions.visible). */
  next(view: { autoFit: boolean; span(margin: number): Span | null }): Span | undefined {
    this.drawn = view.autoFit ? undefined : (view.span(1) ?? undefined);
    return this.drawn;
  }

  /**
   * Should the window draw again for where the view is now? When it's moved
   * past what was drawn; or when everything was drawn (Auto-fit was on) and
   * Auto-fit is off now, so only what's in view need be.
   */
  stale(view: { autoFit: boolean; span(margin: number): Span | null }): boolean {
    if (!this.drawn) return !view.autoFit && view.span(0) !== null;
    const inView = view.span(0);
    return !!inView && (inView.top < this.drawn.top || inView.bottom > this.drawn.bottom);
  }
}
