/**
 * Laying out the memory view (see memory.ts for the big picture): measure
 * every box, put each in the column of its distance from the stack, place
 * them down their columns without overlaps (boxes the person dragged stay
 * put), then route the arrows through the gaps (route.ts).
 */
import { type MemoryScene, nodeKey } from "../../scene/memoryScene";
import { arrowMarkers, FONT, SMALL, s } from "../draw";
import type { Mark } from "../drawing";
import { findFreeY, type Rect, roundedPath, routeEdges } from "../route";
import { GRAPH_BODY_Y, graphBoxes, graphShape, graphSize } from "./graphs";
import { objectShape, viewOf } from "./objects";
import { outputShape, outputWidth } from "./output";
import type { Ctx, MemoryLayout, OutRef, Shape } from "./shapes";
import { frameShape } from "./tables";
import { measureBlock, TREE_GAP, type TreeBlock } from "./trees";

const COLUMN_GAP = 90;
const STACK_GAP = 22;
const MARGIN = 24;
/** Room above the boxes for arrows that route over the top (see route.ts). */
const TOP = 40;
/** Arrows leaving a list downward turn this far below it, then a lane apart. */
const EXIT_DROP = 9;
const EXIT_LANE = 7;

/**
 * A column's boxes in the order their arrows arrive, top to bottom. Boxes
 * with no arrival yet (`arrival` null) keep their places; the others fill
 * the remaining places in arrival order, ties in their first order.
 */
export function inArrowOrder(ids: readonly string[], arrival: (id: string) => number | null): string[] {
  const at = ids.map((id, i) => ({ id, i, y: arrival(id) }));
  const sorted = at.filter((a) => a.y !== null).sort((a, b) => a.y! - b.y! || a.i - b.i);
  let next = 0;
  return at.map((a) => (a.y === null ? a.id : sorted[next++].id));
}

/**
 * The parts of an arrow drawn over the boxes: its start, from the dot to
 * where it leaves its own box (`stub`), and its last few pixels, which
 * carry the arrowhead (`head`). The rest runs behind the boxes.
 */
export function arrowEnds(
  points: { x: number; y: number }[],
  origin: Rect | undefined,
): { stub: { x: number; y: number }[]; head: [{ x: number; y: number }, { x: number; y: number }] | null } {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  const inside = (p: { x: number; y: number }) =>
    !!origin && p.x > origin.x && p.x < origin.x + origin.w && p.y > origin.y && p.y < origin.y + origin.h;
  const stub = [pts[0]];
  if (origin && inside(pts[0])) {
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      if (inside(b)) {
        stub.push(b);
        continue;
      }
      // Where this segment leaves the box (segments are level or upright).
      const x = b.x > a.x ? origin.x + origin.w : b.x < a.x ? origin.x : a.x;
      const y = b.y > a.y ? origin.y + origin.h : b.y < a.y ? origin.y : a.y;
      stub.push(a.x === b.x ? { x: a.x, y } : { x, y: a.y });
      break;
    }
  }
  if (pts.length < 2) return { stub, head: null };
  const end = pts[pts.length - 1];
  const before = pts[pts.length - 2];
  const len = Math.hypot(end.x - before.x, end.y - before.y) || 1;
  const back = Math.min(10, len);
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    stub,
    head: [{ x: r(end.x - ((end.x - before.x) / len) * back), y: r(end.y - ((end.y - before.y) / len) * back) }, end],
  };
}

/** Lay out a memory scene as a drawing (drawing.ts). */
export function memoryDrawing(scene: MemoryScene, layout: MemoryLayout = { positions: new Map() }): Mark {
  const { step, graphAlias } = scene;
  const svg = s("svg", { class: "memory-svg", xmlns: "http://www.w3.org/2000/svg" });
  svg.append(arrowMarkers());
  // Arrows run behind the boxes; what must stay visible goes over them:
  // each arrow's start inside its own box, its arrowhead, and (x-ray, or
  // while its box is hovered) a copy of it. See drawArrow.
  const arrowLayer = s("g", { class: "arrows" });
  const boxLayer = s("g", { class: "boxes" });
  const topLayer = s("g", { class: "arrows arrow-tops" });
  svg.append(arrowLayer, boxLayer, topLayer);

  const graphs = graphBoxes(scene);
  const ctx: Ctx = {
    step,
    diff: scene.changes,
    sizes: scene.sizes,
    nested: scene.nested,
    functionKeyword: scene.functionKeyword,
    pointersFor: (id, level) => scene.pointers(id, level),
    gridFocus: (id, size) => scene.gridFocus(id, size),
    view: (value, cellH) => viewOf(value, ctx, cellH),
  };

  // Binary trees are laid out top-down as one block: each node in its
  // in-order slot, at the height of its depth.
  const blocks = scene.trees.map((tree): TreeBlock => ({ ...tree, slotW: 0, levelH: 0, w: 0, h: 0 }));
  const blockOf = new Map<string, TreeBlock>();
  for (const block of blocks) for (const id of block.nodes.keys()) blockOf.set(id, block);

  // 1. Each separate box goes in the column of its distance from the stack.
  const depth = new Map(scene.objects.map((o) => [o.id, o.depth]));
  const order = scene.objects.map((o) => o.id);

  // 2. Measure everything, then size the columns.
  const shapes = new Map<string, Shape>();
  for (const id of order) {
    const box = graphs.get(id);
    shapes.set(
      id,
      box
        ? graphShape(box, step.heap[id], scene.changes.newObjects.has(id), graphSize(box, ctx))
        : objectShape(step.heap[id], ctx),
    );
  }

  // The call stack, then paused frames under it.
  const frameShapes = scene.frames.map((f) => frameShape(f.frame, ctx, f.active));
  // A program that prints gets a stack column wide enough for its output
  // card (worked out from the whole run, so it doesn't change between steps).
  const framesW = Math.max(160, ...frameShapes.map((f) => f.w), outputWidth(scene.longestOutputLine));
  for (const block of blocks) measureBlock(block, shapes);
  const columnW: number[] = [];
  for (const id of order) {
    const d = depth.get(id)!;
    columnW[d] = Math.max(columnW[d] ?? 0, blockOf.get(id)?.w ?? shapes.get(id)!.w);
  }
  const columnX: number[] = [];
  let cursorX = MARGIN + framesW + COLUMN_GAP;
  for (let d = 0; d < columnW.length; d++) {
    columnX[d] = cursorX;
    cursorX += (columnW[d] ?? 0) + COLUMN_GAP;
  }

  // 3. Place and draw. Frames first, then objects in BFS order so a parent
  //    is always placed before its children and can pull them level with it.
  const refs: OutRef[] = [];
  const preferredY = new Map<string, number>();

  // Boxes the person dragged stay exactly where they were put. Everything
  // else is placed automatically, moving down past anything already there,
  // so a new box is never hidden under another one.
  const frameKeys = scene.frames.map((f) => f.key);
  const obstacles: Rect[] = [];
  frameShapes.forEach((shape, index) => {
    const moved = layout.positions.get(frameKeys[index]);
    if (moved) obstacles.push({ ...moved, w: shape.w, h: shape.h });
  });
  for (const id of order) {
    const moved = layout.positions.get(nodeKey.object(id));
    if (moved) obstacles.push({ ...moved, w: shapes.get(id)!.w, h: shapes.get(id)!.h });
  }

  // Each box goes in its own group, so the viewport can find and drag it.
  const rects = new Map<string, Rect & { inY: number }>();
  let raised: Mark | null = null;
  /** Each box's group, by key, and the ones the person moved (in drawing order). */
  const nodes = new Map<string, Mark>();
  const movedNodes: Mark[] = [];
  const drawNode = (key: string, shape: Shape, x: number, y: number) => {
    const g = s("g", { class: "node", "data-node-key": key, "data-flip": key, "data-x": x, "data-y": y });
    const isMoved = layout.positions.has(key);
    if (isMoved) g.classList.add("is-moved");
    // An invisible backing, so a press anywhere on the box (even between its
    // index numbers and cells) grabs the box instead of panning the canvas.
    g.append(
      s("rect", {
        class: "node-hit",
        x: x - 2,
        y: y - 2,
        width: shape.w + 4,
        height: shape.h + 4,
        fill: "transparent",
      }),
    );
    const before = refs.length;
    shape.draw(x, y, g, refs);
    for (let i = before; i < refs.length; i++) refs[i].source = key;
    // Arrows leaving list cells downward turn under the box like the teeth
    // of a comb: the leftmost cell turns highest, so they stay in order.
    const down = refs
      .slice(before)
      .filter((r) => r.down)
      .sort((a, b) => a.from.x - b.from.x);
    down.forEach((ref, rank) => {
      ref.exitDownY = y + shape.h + EXIT_DROP + rank * EXIT_LANE;
    });
    // Line each target up with where its arrow arrives.
    for (let i = before; i < refs.length; i++) {
      const ref = refs[i];
      if (!preferredY.has(ref.target)) preferredY.set(ref.target, ref.exitDownY ?? ref.from.y);
    }
    boxLayer.append(g);
    if (!nodes.has(key)) nodes.set(key, g);
    if (isMoved) movedNodes.push(g);
    if (key === layout.raise) raised = g;
    const rect = { x, y, w: shape.w, h: shape.h, inY: shape.inY };
    rects.set(key, rect);
    // Keep the turns under a list clear of the next box down.
    const below = down.length ? EXIT_DROP + (down.length - 1) * EXIT_LANE + 6 : 0;
    if (!isMoved) obstacles.push({ ...rect, h: rect.h + below });
    return below;
  };

  let frameY = TOP;
  frameShapes.forEach((shape, index) => {
    const key = frameKeys[index];
    const moved = layout.positions.get(key);
    if (moved) {
      drawNode(key, shape, moved.x, moved.y);
      return;
    }
    const y = findFreeY(MARGIN, shape.w, shape.h, frameY, obstacles, STACK_GAP);
    const below = drawNode(key, shape, MARGIN, y);
    frameY = y + shape.h + below + STACK_GAP;
  });

  const columnCursor: number[] = columnW.map(() => TOP);
  // Objects come in breadth-first order, so one column at a time. Within a
  // column, boxes go in the order their arrows arrive (top to bottom), so
  // arrows into a column don't cross on the way. Boxes placed by hand, tree
  // nodes and boxes nothing in an earlier column points to keep their
  // places. The order depends only on the arrows, so a box only moves when
  // an arrow does.
  // Each column is placed before the next is ordered: the next one's arrows come from it.
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end < order.length && depth.get(order[end]) === depth.get(order[start])) end++;
    const column = inArrowOrder(order.slice(start, end), (id) =>
      layout.positions.has(nodeKey.object(id)) || blockOf.has(id) ? null : (preferredY.get(id) ?? null),
    );
    for (const id of column) placeObject(id);
    start = end;
  }

  function placeObject(id: string): void {
    const d = depth.get(id)!;
    const shape = shapes.get(id)!;
    const key = nodeKey.object(id);
    const moved = layout.positions.get(key);
    if (moved) {
      drawNode(key, shape, moved.x, moved.y);
      return;
    }
    const block = blockOf.get(id);
    if (block) {
      // The first node reached places the whole tree; every node then goes
      // to its slot in the block.
      if (!block.origin) {
        const want = preferredY.has(block.root) ? preferredY.get(block.root)! - shapes.get(block.root)!.inY : TOP;
        const y = findFreeY(columnX[d], block.w, block.h, Math.max(columnCursor[d], want), obstacles, STACK_GAP);
        block.origin = { x: columnX[d], y };
        columnCursor[d] = y + block.h + STACK_GAP;
      }
      const slot = block.nodes.get(id)!;
      drawNode(
        key,
        shape,
        block.origin.x + slot.index * (block.slotW + TREE_GAP) + Math.round((block.slotW - shape.w) / 2),
        block.origin.y + slot.depth * block.levelH,
      );
      return;
    }
    const want = preferredY.has(id) ? preferredY.get(id)! - shape.inY : TOP;
    const y = findFreeY(columnX[d], shape.w, shape.h, Math.max(columnCursor[d], want), obstacles, STACK_GAP);
    const below = drawNode(key, shape, columnX[d], y);
    columnCursor[d] = y + shape.h + below + STACK_GAP;
  }
  // What this step printed: a node under the call stack (moving down past
  // anything in the way), with arrows to the objects it printed. Everything
  // else dims, so the output and what it's about stand out.
  if (scene.output) {
    const { printed, targets } = scene.output;
    const shape = outputShape(printed, targets, framesW);
    const key = nodeKey.output;
    const moved = layout.positions.get(key);
    if (moved) drawNode(key, shape, moved.x, moved.y);
    else drawNode(key, shape, MARGIN, findFreeY(MARGIN, shape.w, shape.h, frameY, obstacles, STACK_GAP));
    if (scene.dim.on) svg.classList.add("has-output");
    for (const id of targets) nodes.get(nodeKey.object(id))?.classList.add("is-printed");
    const card = nodes.get(key);
    card?.classList.add("is-output");
    // Its entrance is its own (CSS, set in the Style panel), not the step's fade.
    card?.setAttribute("data-no-fade", "");
  }
  // Dim in when printing starts, and back up the step after.
  if (scene.dim.entering) svg.classList.add("output-in");
  if (scene.dim.leaving) svg.classList.add("output-out");

  // Boxes the person placed sit on top of automatically placed ones, and the
  // box being dragged right now is on top of everything.
  for (const g of movedNodes) boxLayer.append(g);
  if (raised) boxLayer.append(raised);

  // 4. Route the arrows through the gaps between boxes (see route.ts).
  const edges = refs
    .map((ref) => ({
      ref,
      source: rects.get(ref.source ?? ""),
      target: rects.get(nodeKey.object(graphAlias.get(ref.target) ?? ref.target)),
    }))
    .filter(
      (e): e is { ref: OutRef; source: Rect & { inY: number }; target: Rect & { inY: number } } =>
        !!e.source && !!e.target,
    );
  const idOf = (key: string | undefined) => (key?.startsWith("obj:") ? key.slice(4) : "");
  const routes = routeEdges(
    edges.map(({ ref, source, target }) => {
      const block = blockOf.get(ref.target);
      const sourceId = idOf(ref.source);
      // An arrow to a node of a graph lands level with that node.
      const host = graphAlias.get(ref.target) ?? ref.target;
      const center = graphs.get(host)?.picture.centers.get(ref.target);
      const entryY =
        center && graphs.get(host)!.graph.objectNodes ? target.y + GRAPH_BODY_Y + center.y : target.y + target.inY;
      const base = { from: ref.from, exitDownY: ref.exitDownY, source, target, entryY };
      if (!block?.origin) return base;
      // Parent to child inside a tree: drop from the parent to the child's top.
      const parent = block.nodes.get(sourceId);
      if (parent && blockOf.get(sourceId) === block && parent.children.includes(ref.target)) {
        return {
          ...base,
          tree: block.nodes.get(ref.target)!.index < parent.index ? ("left" as const) : ("right" as const),
        };
      }
      // From outside, to the left of the tree: come down beside the tree and
      // in from above, so the arrow doesn't run through the node's neighbors.
      if (source.x + source.w + 20 <= block.origin.x) return { ...base, enterTopFrom: block.origin.x };
      return base;
    }),
    [...rects.values()],
  );
  let maxX = 0;
  let maxY = 0;
  for (const rect of rects.values()) {
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  routes.forEach((points, i) => {
    const { ref } = edges[i];
    for (const p of points) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const kind = ref.printed ? "print-arrow" : ref.changed ? "is-changed" : "";
    const ends = { "data-from": ref.source, "data-to": nodeKey.object(graphAlias.get(ref.target) ?? ref.target) };
    const d = roundedPath(points);
    const part = (cls: string, path: string, attrs: Record<string, string> = {}) =>
      s("path", { d: path, class: ["ref-arrow-part", cls, kind].filter(Boolean).join(" "), ...ends, ...attrs });
    // The whole arrow, behind every box.
    arrowLayer.append(s("path", { d, class: ["ref-arrow", kind].filter(Boolean).join(" "), ...ends }));
    const { stub, head } = arrowEnds(points, edges[i].source);
    if (stub.length > 1) topLayer.append(part("arrow-stub", roundedPath(stub)));
    topLayer.append(part("arrow-xray", d));
    if (head)
      topLayer.append(
        part("arrow-head", `M${head[0].x},${head[0].y} L${head[1].x},${head[1].y}`, {
          "marker-end": "url(#arrow-ref)",
        }),
      );
  });

  const width = Math.max(maxX + MARGIN, MARGIN * 2 + framesW, cursorX - COLUMN_GAP + MARGIN);
  const height = maxY + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.setProperty("--font-size", `${FONT}px`);
  svg.style.setProperty("--small-size", `${SMALL}px`);
  return svg;
}
