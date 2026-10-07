/**
 * The memory view: one snapshot of the program.
 *
 *   frames (scopes)      heap, column 0        column 1 ...
 *   ┌ Global ───────┐    list  ┌──┬──┬──┐
 *   │ arr       ● ──┼──▶       │ 5│ 2│ 4│
 *   │ n         4   │          └──┴──┴──┘
 *   └───────────────┘    Node ┌────────┐     Node ┌────────┐
 *   ┌ fact ─────────┐         │ next ●─┼──▶       │ next   │
 *
 * Heap objects are placed in columns by distance from the stack, so a
 * linked list or tree reads left to right. Within a column, each object
 * lines up with the arrow pointing at it when there is room.
 *
 * Every frame and object is drawn in its own <g class="node"> with a stable
 * key (see nodeKey). A box the person has dragged is drawn at its saved
 * position instead of in its column, and arrows connect to wherever boxes
 * ended up.
 *
 * There are two ways to show a reference (MemoryMode):
 *   "arrows"  every object is its own box, and references are arrows.
 *   "nested"  an object that only one thing refers to is drawn inside that
 *             thing ("container in container"). Shared objects and cycles
 *             still need arrows, so they stay separate. See chooseNested.
 */
import { localKey, slotsOf, valueKey, type StepDiff } from "../trace/diff";
import type { Frame, HeapObject, SequenceObject, Step, Trace, Value } from "../trace/types";
import {
  CELL_H, CELL_MIN_W, FONT, HEADER_H, INDEX_H, LABEL_H, POINTER_H, ROW_H, SMALL,
  arrowMarkers, cellWidth, pointerMarkers, pointersFor, refArrow, s, textWidth, uiTextWidth, valueCell,
} from "./draw";

interface OutRef { from: Point; target: string; changed: boolean }
type Pointers = { name: string; index: number; changed: boolean }[];

interface Shape {
  w: number;
  h: number;
  /** Where incoming arrows land, relative to the top of the shape. */
  inY: number;
  draw(x: number, y: number, layer: SVGGElement, refs: OutRef[]): void;
}

export interface Point { x: number; y: number }

export type MemoryMode = "arrows" | "nested";

/** Where the person has dragged boxes, by node key, in diagram units. */
export interface MemoryLayout {
  positions: ReadonlyMap<string, Point>;
  /** The node being dragged right now, drawn on top of the others. */
  raise?: string | null;
  mode?: MemoryMode;
}

/**
 * Stable keys for draggable boxes. Frames are keyed by their position on the
 * stack and function name, so "the second factorial() call" keeps its place
 * across steps and re-runs. Objects are keyed by id, which both tracers keep
 * stable for the whole run and assign in the same order on every run.
 */
export const nodeKey = {
  frame: (index: number, func: string) => `frame:${index}:${func}`,
  object: (id: string) => `obj:${id}`,
};

const COLUMN_GAP = 90;
const STACK_GAP = 22;
const MARGIN = 24;
/** Nesting deeper than this switches back to arrows, so boxes stay readable. */
export const MAX_NEST_DEPTH = 6;
const NEST_PAD = 4;

// ---------------------------------------------------------------------------
// Choosing what to nest
// ---------------------------------------------------------------------------

/** Every value an object holds, including dict keys. */
function valuesOf(obj: HeapObject): Value[] {
  const values: Value[] = [];
  if (obj.kind === "dict") for (const [key] of obj.entries) values.push(key);
  values.push(...slotsOf(obj).values());
  return values;
}

/** References an object holds that could be drawn inside it (not dict keys). */
function nestableChildren(obj: HeapObject): string[] {
  const ids: string[] = [];
  for (const value of slotsOf(obj).values()) if (value.kind === "ref") ids.push(value.id);
  return ids;
}

/**
 * Which objects to draw inside the thing that refers to them. An object is
 * nested when exactly one reference to it exists in this snapshot (from a
 * variable, a field, an item or the return value). Anything referenced twice
 * (aliasing), part of a cycle, or nested deeper than MAX_NEST_DEPTH stays a
 * separate box, because only an arrow can show "these point at the same
 * object".
 */
export function chooseNested(step: Step): Set<string> {
  const incoming = new Map<string, number>();
  const count = (value: Value | undefined) => {
    if (value?.kind === "ref") incoming.set(value.id, (incoming.get(value.id) ?? 0) + 1);
  };
  for (const frame of step.stack) for (const [, value] of frame.locals) count(value);
  count(step.returnValue);
  for (const obj of Object.values(step.heap)) for (const value of valuesOf(obj)) count(value);

  const nested = new Set<string>();
  const visited = new Set<string>();
  const tryNest = (id: string, depth: number) => {
    const obj = step.heap[id];
    if (!obj || visited.has(id) || incoming.get(id) !== 1 || depth > MAX_NEST_DEPTH) return;
    visited.add(id);
    nested.add(id);
    for (const child of nestableChildren(obj)) tryNest(child, depth + 1);
  };
  // Start from the variables, then from every object that stayed separate,
  // so things inside a shared object can still nest inside it.
  for (const frame of step.stack) for (const [, value] of frame.locals) if (value.kind === "ref") tryNest(value.id, 1);
  if (step.returnValue?.kind === "ref") tryNest(step.returnValue.id, 1);
  for (const [id, obj] of Object.entries(step.heap)) {
    if (nested.has(id)) continue;
    visited.add(id);
    for (const child of nestableChildren(obj)) tryNest(child, 1);
  }
  return nested;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Shared state for drawing one snapshot. */
interface Ctx {
  step: Step;
  diff: StepDiff;
  nested: ReadonlySet<string>;
  functionKeyword: string;
  pointersFor(id: string): Pointers;
}

/**
 * What goes in a value slot: a primitive or a reference dot ("cell"), or in
 * nested mode a whole child shape. Rows and list cells size to their views.
 */
interface View {
  w: number;
  h: number;
  nested: boolean;
  draw(x: number, y: number, w: number, h: number, layer: SVGGElement, refs: OutRef[], changed: boolean): void;
}

function viewOf(value: Value, ctx: Ctx, cellH: number): View {
  if (value.kind === "ref" && ctx.nested.has(value.id) && ctx.step.heap[value.id]) {
    const shape = objectShape(ctx.step.heap[value.id], ctx, true);
    return {
      w: shape.w, h: shape.h, nested: true,
      draw(x, y, _w, _h, layer, refs) {
        shape.draw(x, y, layer, refs);
      },
    };
  }
  return {
    w: cellWidth(value), h: cellH, nested: false,
    draw(x, y, w, h, layer, refs, changed) {
      const { el, dot } = valueCell(value, { x, y, w, h, changed });
      layer.append(el);
      if (dot && value.kind === "ref") refs.push({ from: dot, target: value.id, changed });
    },
  };
}

interface TableRow {
  label: string | Value;
  value: Value;
  changed: boolean;
  variant?: string;
}

function labelWidth(label: string | Value): number {
  if (typeof label === "string") return textWidth(label);
  return label.kind === "prim" ? textWidth(label.repr) : 20;
}

function tableShape(
  title: string,
  rows: TableRow[],
  ctx: Ctx,
  opts: { variant: string; isNew?: boolean; emptyText?: string; nested?: boolean },
): Shape {
  const views = rows.map((row) => viewOf(row.value, ctx, ROW_H - 8));
  const leftW = rows.length ? Math.max(...rows.map((r) => labelWidth(r.label))) : 0;
  const rightW = views.length ? Math.max(...views.map((v) => v.w)) : 0;
  // Plain cells keep their own width rather than stretching to match a wide
  // nested box in the same column.
  const cellsW = Math.max(0, ...views.filter((v) => !v.nested).map((v) => v.w));
  const emptyW = opts.emptyText ? uiTextWidth(opts.emptyText, 12) + 24 : 0;
  // Function and class titles are set in the code font (see styles.css).
  const codeTitle = /\b(function|class)\b/.test(opts.variant);
  const titleW = codeTitle ? textWidth(title, 12.5) + 22 : uiTextWidth(title, 12) + 28;
  const w = Math.max(titleW, leftW + rightW + 34, emptyW, opts.nested ? 0 : 120);
  const rowHeights = views.map((v) => Math.max(ROW_H, v.h + 2 * NEST_PAD));
  const bodyH = rows.length ? rowHeights.reduce((a, b) => a + b, 0) + 6 : opts.emptyText ? ROW_H : 0;
  const h = HEADER_H + bodyH;

  return {
    w, h, inY: HEADER_H / 2,
    draw(x, y, layer, refs) {
      const cls = ["box", opts.variant, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" ");
      const g = s("g", { class: cls });
      g.append(
        s("rect", { class: "box-body", x, y, width: w, height: h, rx: 5 }),
        s("path", { class: "box-header", d: `M${x},${y + HEADER_H} V${y + 5} q0,-5 5,-5 H${x + w - 5} q5,0 5,5 V${y + HEADER_H} z` }),
        s("text", { class: "box-title", x: x + 10, y: y + HEADER_H / 2, "dominant-baseline": "central" }, title),
      );
      if (!rows.length && opts.emptyText) {
        g.append(s("text", { class: "box-empty", x: x + 10, y: y + HEADER_H + ROW_H / 2, "dominant-baseline": "central" }, opts.emptyText));
      }
      let rowY = y + HEADER_H + 3;
      rows.forEach((row, i) => {
        const rowH = rowHeights[i];
        const view = views[i];
        // Labels sit level with the first line, even beside a tall nested box.
        const labelY = view.nested ? rowY + NEST_PAD + HEADER_H / 2 : rowY + rowH / 2;
        const rowG = s("g", { class: ["row", row.variant, row.changed && "is-changed"].filter(Boolean).join(" ") });
        if (typeof row.label === "string") {
          rowG.append(s("text", { class: "row-label", x: x + 10, y: labelY, "dominant-baseline": "central" }, row.label));
        } else if (row.label.kind === "prim") {
          const { el } = valueCell(row.label, { x: x + 6, y: labelY - (ROW_H - 8) / 2, w: leftW + 8, h: ROW_H - 8, variant: "key" });
          rowG.append(el);
        } else {
          const { el, dot } = valueCell(row.label, { x: x + 6, y: labelY - (ROW_H - 8) / 2, w: 22, h: ROW_H - 8, variant: "key" });
          rowG.append(el);
          if (dot) refs.push({ from: dot, target: row.label.id, changed: false });
        }
        const cellX = x + w - 8 - rightW;
        if (view.nested) view.draw(cellX, rowY + NEST_PAD, view.w, view.h, rowG, refs, row.changed);
        else view.draw(cellX, rowY + 4, cellsW, ROW_H - 8, rowG, refs, row.changed);
        g.append(rowG);
        rowY += rowH;
      });
      layer.append(g);
    },
  };
}

function sequenceShape(
  obj: SequenceObject,
  ctx: Ctx,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape {
  const hasIndices = obj.kind !== "set";
  const truncated = obj.length > obj.items.length;
  const views = obj.items.map((item) => viewOf(item, ctx, CELL_H));
  const anyNested = views.some((v) => v.nested);
  const pad = anyNested ? NEST_PAD : 0;
  const cellW = Math.max(CELL_MIN_W, ...views.map((v) => v.w + 2 * pad));
  const cellH = Math.max(CELL_H, ...views.map((v) => (v.nested ? v.h + 2 * pad : CELL_H)));
  const count = Math.max(obj.items.length, 1) + (truncated ? 1 : 0);
  // Inside another box, the type label is left out to save room.
  const showLabel = !opts.nested || truncated;
  const label = truncated ? `${obj.typeName}, first ${obj.items.length} of ${obj.length}` : obj.typeName;
  const labelH = showLabel ? LABEL_H : 2;
  const hasPointers = opts.pointers.length > 0;
  const w = Math.max(count * cellW, showLabel ? uiTextWidth(label) + 8 : 0);
  const cellsY = labelH + (hasIndices ? INDEX_H : 0);
  const h = cellsY + cellH + (hasPointers ? POINTER_H : 0);

  return {
    w, h, inY: cellsY + Math.min(cellH, CELL_H) / 2,
    draw(x, y, layer, refs) {
      const g = s("g", { class: ["seq", obj.kind, opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" ") });
      if (showLabel) g.append(s("text", { class: "seq-label", x, y: y + 11 }, label));
      if (!obj.items.length) {
        g.append(s("g", { class: "cell is-empty" },
          s("rect", { x, y: y + cellsY, width: cellW, height: CELL_H, rx: 3 }),
          s("text", { class: "value v-none", x: x + cellW / 2, y: y + cellsY + CELL_H / 2, "text-anchor": "middle", "dominant-baseline": "central" }, "∅")));
      }
      obj.items.forEach((_item, i) => {
        const cx = x + i * cellW;
        const changed = opts.changed.has(String(i));
        if (hasIndices) {
          g.append(s("text", { class: "index", x: cx + cellW / 2, y: y + labelH + 9, "text-anchor": "middle" }, String(i)));
        }
        const view = views[i];
        if (view.nested) {
          // A cell frame with the nested object inside it.
          g.append(s("g", { class: ["cell", "is-holder", changed && "is-changed"].filter(Boolean).join(" ") },
            s("rect", { x: cx, y: y + cellsY, width: cellW, height: cellH, rx: 3 })));
          view.draw(cx + pad, y + cellsY + pad, view.w, view.h, g, refs, changed);
        } else {
          view.draw(cx, y + cellsY, cellW, cellH, g, refs, changed);
        }
      });
      if (truncated) {
        const cx = x + obj.items.length * cellW;
        g.append(s("text", { class: "value v-none", x: cx + cellW / 2, y: y + cellsY + cellH / 2, "text-anchor": "middle", "dominant-baseline": "central" }, "…"));
      }
      if (hasPointers) {
        g.append(pointerMarkers(opts.pointers, (i) => x + i * cellW, cellW, y + cellsY + cellH, obj.items.length));
      }
      layer.append(g);
    },
  };
}

function objectShape(obj: HeapObject, ctx: Ctx, nested = false): Shape {
  const changed = ctx.diff.changedSlots.get(obj.id) ?? new Set<string>();
  const isNew = ctx.diff.newObjects.has(obj.id);
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
      return sequenceShape(obj, ctx, { changed, isNew, pointers: ctx.pointersFor(obj.id), nested });
    case "dict":
      return tableShape(obj.typeName, obj.entries.map(([key, value]) => ({ label: key, value, changed: changed.has(valueKey(key)) })),
        ctx, { variant: "dict", isNew, emptyText: "empty", nested });
    case "object":
      return tableShape(obj.typeName, obj.fields.map(([name, value]) => ({ label: name, value, changed: changed.has(name) })),
        ctx, { variant: "instance", isNew, emptyText: "no fields", nested });
    case "function": {
      const title = obj.builtin ? `builtin ${obj.name}` : `${ctx.functionKeyword} ${obj.name}(${obj.params.join(", ")})`;
      return tableShape(title, obj.fields.map(([name, value]) => ({ label: name, value, changed: changed.has(name) })),
        ctx, { variant: "function", isNew, nested });
    }
    case "class":
      return tableShape(`class ${obj.name}`, [], ctx, { variant: "class", isNew, nested });
    case "opaque":
      return tableShape(obj.typeName, [{ label: "", value: { kind: "prim", type: "repr", repr: obj.repr }, changed: changed.has("*") }],
        ctx, { variant: "opaque", isNew, nested });
  }
}

function frameShape(frame: Frame, ctx: Ctx, isActive: boolean): Shape {
  const { step, diff } = ctx;
  const rows: TableRow[] = frame.locals.map(([name, value]) => ({
    label: name, value, changed: diff.changedLocals.has(localKey(frame.id, name)),
  }));
  if (isActive && step.event === "return" && step.returnValue && frame.func !== "Global") {
    rows.push({ label: "returns", value: step.returnValue, changed: true, variant: "return-row" });
  }
  const title = frame.func === "Global" ? "Global" : `${frame.func}()`;
  return tableShape(title, rows, ctx, {
    variant: ["frame", isActive && "is-active"].filter(Boolean).join(" "),
    isNew: diff.newFrames.has(frame.id),
    emptyText: "no variables yet",
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function renderMemory(
  trace: Trace,
  stepIndex: number,
  diff: StepDiff,
  layout: MemoryLayout = { positions: new Map() },
): SVGSVGElement {
  const step = trace.steps[stepIndex];
  const svg = s("svg", { class: "memory-svg", xmlns: "http://www.w3.org/2000/svg" });
  svg.append(arrowMarkers());
  const boxLayer = s("g", { class: "boxes" });
  const arrowLayer = s("g", { class: "arrows" });
  svg.append(boxLayer, arrowLayer);

  const nested = layout.mode === "nested" ? chooseNested(step) : new Set<string>();

  // Index pointers (i, j, lo, hi...) belong to the variable that holds a list.
  const pointerOwner = new Map<string, { name: string; frame: Frame }>();
  for (const frame of step.stack) {
    for (const [name, value] of frame.locals) if (value.kind === "ref") pointerOwner.set(value.id, { name, frame }); // innermost frame wins
  }
  const ctx: Ctx = {
    step,
    diff,
    nested,
    functionKeyword: trace.language === "python" ? "def" : "function",
    pointersFor(id) {
      const owner = pointerOwner.get(id);
      if (!owner) return [];
      const changedNames = new Set(owner.frame.locals.map(([n]) => n).filter((n) => diff.changedLocals.has(localKey(owner.frame.id, n))));
      return pointersFor(owner.name, trace.indexNames, new Map(owner.frame.locals), changedNames);
    },
  };

  // References that leave a group of nested boxes: where its arrows go.
  const exits = (values: Value[], out: string[] = []): string[] => {
    for (const value of values) {
      if (value.kind !== "ref" || !step.heap[value.id]) continue;
      if (nested.has(value.id)) exits(valuesOf(step.heap[value.id]), out);
      else out.push(value.id);
    }
    return out;
  };

  // 1. Breadth-first walk from the stack assigns each separate box a column.
  //    Nested objects aren't boxes of their own: their outgoing arrows count
  //    as coming from the box they're drawn in.
  const depth = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  const enqueue = (id: string, d: number) => {
    if (depth.has(id)) return;
    depth.set(id, d);
    order.push(id);
    queue.push(id);
  };
  const roots = step.stack.flatMap((frame) => frame.locals.map(([, value]) => value));
  if (step.returnValue) roots.push(step.returnValue);
  for (const id of exits(roots)) enqueue(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of exits(valuesOf(step.heap[id]))) enqueue(child, depth.get(id)! + 1);
  }

  // 2. Measure everything, then size the columns.
  const shapes = new Map<string, Shape>();
  for (const id of order) shapes.set(id, objectShape(step.heap[id], ctx));

  const frameShapes = step.stack.map((frame, i) => frameShape(frame, ctx, i === step.stack.length - 1));
  const framesW = Math.max(160, ...frameShapes.map((f) => f.w));
  const columnW: number[] = [];
  for (const id of order) {
    const d = depth.get(id)!;
    columnW[d] = Math.max(columnW[d] ?? 0, shapes.get(id)!.w);
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
  const placed = new Map<string, Point & { w: number; inY: number }>();
  const preferredY = new Map<string, number>();
  const notePreferences = (from: number) => {
    for (let i = from; i < refs.length; i++) {
      if (!preferredY.has(refs[i].target)) preferredY.set(refs[i].target, refs[i].from.y);
    }
  };

  // Each box goes in its own group, so the viewport can find and drag it.
  let maxX = 0;
  let maxY = 0;
  let raised: SVGGElement | null = null;
  const drawNode = (key: string, shape: Shape, x: number, y: number) => {
    const pos = { x, y };
    const g = s("g", { class: "node", "data-node-key": key, "data-x": pos.x, "data-y": pos.y });
    if (layout.positions.has(key)) g.classList.add("is-moved");
    // An invisible backing, so a press anywhere on the box (even between its
    // index numbers and cells) grabs the box instead of panning the canvas.
    g.append(s("rect", { class: "node-hit", x: pos.x - 2, y: pos.y - 2, width: shape.w + 4, height: shape.h + 4, fill: "transparent" }));
    const before = refs.length;
    shape.draw(pos.x, pos.y, g, refs);
    notePreferences(before);
    boxLayer.append(g);
    if (key === layout.raise) raised = g;
    maxX = Math.max(maxX, pos.x + shape.w);
    maxY = Math.max(maxY, pos.y + shape.h);
  };

  // A moved box is out of the automatic flow: it doesn't push the boxes
  // after it down, so they keep their usual places.
  let frameY = MARGIN;
  frameShapes.forEach((shape, index) => {
    const key = nodeKey.frame(index, step.stack[index].func);
    const moved = layout.positions.get(key);
    drawNode(key, shape, moved?.x ?? MARGIN, moved?.y ?? frameY);
    if (!moved) frameY += shape.h + STACK_GAP;
  });

  const columnCursor: number[] = columnW.map(() => MARGIN);
  for (const id of order) {
    const d = depth.get(id)!;
    const shape = shapes.get(id)!;
    const key = nodeKey.object(id);
    const moved = layout.positions.get(key);
    let x: number;
    let y: number;
    if (moved) {
      ({ x, y } = moved);
    } else {
      const want = preferredY.has(id) ? preferredY.get(id)! - shape.inY : MARGIN;
      x = columnX[d];
      y = Math.max(columnCursor[d], want);
      columnCursor[d] = y + shape.h + STACK_GAP;
    }
    drawNode(key, shape, x, y);
    placed.set(id, { x, y, w: shape.w, inY: shape.inY });
  }
  // Boxes the person placed sit on top of automatically placed ones, and the
  // box being dragged right now is on top of everything.
  for (const g of [...boxLayer.querySelectorAll(".node.is-moved")]) boxLayer.append(g);
  if (raised) boxLayer.append(raised);

  for (const ref of refs) {
    const target = placed.get(ref.target);
    if (!target) continue;
    arrowLayer.append(refArrow(ref.from, target, ref.changed));
  }

  // Leave room on the right for back-edge arrows that swing around a column.
  const width = Math.max(cursorX - COLUMN_GAP + MARGIN + 30, MARGIN * 2 + framesW, maxX + MARGIN + 30);
  const height = Math.max(frameY, ...columnCursor, maxY + STACK_GAP) + MARGIN - STACK_GAP;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.setProperty("--font-size", `${FONT}px`);
  svg.style.setProperty("--small-size", `${SMALL}px`);
  return svg;
}
