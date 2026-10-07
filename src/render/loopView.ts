/**
 * The loop view: one row per iteration, stacked, with arrows for changes.
 *
 *   before   arr  [5][2][4][1]      i = 0
 *                     ╲╱             <- a swap draws crossing arrows
 *   #1       arr  [2][5][4][1]      i = 0   j = 1
 *                  ^j
 *
 * Only containers and scalars that change during the loop are shown (plus
 * anything used as an index), so unrelated variables stay out of the way.
 */
import { valueKey } from "../trace/diff";
import { findLinkedTrack, linkedRow, linkedSignature, type LinkedRow, type LinkedTrack } from "../trace/linked";
import type { LoopHistory, LoopRow } from "../trace/loopHistory";
import type { HeapObject, Trace, Value } from "../trace/types";
import {
  CELL_H, CELL_MIN_W, INDEX_H, POINTER_H, arrowMarkers, cellWidth, changeArrow, pointerMarkers, pointersFor, s,
  textWidth, uiTextWidth, valueCell,
} from "./draw";

const MARGIN = 20;
const GUTTER_W = 64;
const SCALARS_GAP = 28;   // space between the last container and "i = 2  j = 0"
const ROW_GAP = 34;
const BAND_H = 30;
const CONTAINER_GAP = 44;
const MAX_ROWS = 120;
// Linked track (see trace/linked.ts)
const SLOT_W = 18;        // a node's link slot
const NODE_GAP = 30;      // room between nodes for a straight arrow
const ARC_TOP = 30;       // room above the cells for links that arc over
const ARC_BOTTOM = 26;    // ...and below, for a second link field

type ContainerObject = Extract<HeapObject, { kind: "list" | "tuple" | "set" | "dict" }>;

interface Cell { key: string; label: string; value: Value }

function isContainer(obj: HeapObject | undefined): obj is ContainerObject {
  return !!obj && (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set" || obj.kind === "dict");
}

function cellsOf(obj: ContainerObject): Cell[] {
  switch (obj.kind) {
    case "dict":
      return obj.entries.map(([key, value]) => ({
        key: valueKey(key), label: key.kind === "prim" ? key.repr : "•", value,
      }));
    case "set":
      return obj.items.map((value) => ({ key: valueKey(value), label: "", value }));
    default:
      return obj.items.map((value, index) => ({ key: String(index), label: String(index), value }));
  }
}

function containerIn(row: LoopRow, name: string): ContainerObject | undefined {
  const value = row.frame.locals.find(([n]) => n === name)?.[1];
  if (value?.kind !== "ref") return undefined;
  const obj = row.heap[value.id];
  return isContainer(obj) ? obj : undefined;
}

function signature(obj: ContainerObject | undefined): string {
  if (!obj) return "";
  return obj.id + "|" + cellsOf(obj).map((c) => c.key + "=" + valueKey(c.value)).join(",");
}

function scalarIn(row: LoopRow, name: string): Value | undefined {
  const value = row.frame.locals.find(([n]) => n === name)?.[1];
  return value?.kind === "prim" ? value : undefined;
}

/** Decide which containers and scalars are worth showing for this loop. */
function pickVariables(trace: Trace, rows: LoopRow[], hasTrack: boolean): { containers: string[]; scalars: string[] } {
  const containerNames: string[] = [];
  const scalarNames: string[] = [];
  for (const row of rows) {
    for (const [name, value] of row.frame.locals) {
      if (value.kind === "ref" && isContainer(row.heap[value.id])) {
        if (!containerNames.includes(name)) containerNames.push(name);
      } else if (value.kind === "prim" && !scalarNames.includes(name)) {
        scalarNames.push(name);
      }
    }
  }

  const changes = (read: (row: LoopRow) => string) => rows.some((row, i) => i > 0 && read(row) !== read(rows[i - 1]));
  // An indexed list is worth showing even if it never changes, because its
  // pointer markers (i, lo, hi...) move. Dicts and objects don't get pointer
  // markers, so they're only shown when they change.
  const isSequence = (name: string) => rows.some((row) => {
    const kind = containerIn(row, name)?.kind;
    return kind === "list" || kind === "tuple";
  });
  let containers = containerNames.filter((name) =>
    (trace.indexNames[name] !== undefined && isSequence(name)) || changes((row) => signature(containerIn(row, name))));
  // With nothing else to show, fall back to every container. A linked track
  // counts as something to show.
  if (!containers.length && !hasTrack) containers = containerNames.slice(0, 4);

  const indexVars = new Set(containers.flatMap((name) =>
    pointersFor(name, trace.indexNames, new Map(rows[rows.length - 1].frame.locals)).map((p) => p.name)));
  let scalars = scalarNames.filter((name) =>
    indexVars.has(name) || changes((row) => { const v = scalarIn(row, name); return v ? valueKey(v) : ""; }));
  if (!scalars.length) scalars = scalarNames.slice(0, 6);
  return { containers, scalars };
}

function scalarText(row: LoopRow, names: string[]): string {
  return names.map((name) => {
    const value = scalarIn(row, name);
    return value?.kind === "prim" ? `${name} = ${value.repr}` : "";
  }).filter(Boolean).join("   ");
}

interface ContainerColumn {
  name: string;
  x: number;        // where cells start
  cellW: number;
  hasPointers: boolean;
}

type Item = { kind: "row"; row: LoopRow; index: number } | { kind: "band"; from: number; to: number };

interface TrackLayout {
  track: LinkedTrack;
  x: number;        // where the first node starts
  valueW: number;   // width of a node's value cell
  nodeW: number;    // value cell plus link slots
}

const EMPTY: Value = { kind: "prim", type: "none", repr: "" };

/** One row of the linked track: nodes in fixed columns, links as arrows. */
function drawTrack(
  g: SVGGElement,
  arrowLayer: SVGGElement,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
): void {
  const { track, valueW, nodeW } = layout;
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const midY = cellsY + CELL_H / 2;
  const trackG = s("g", { class: "linked-track" });
  g.append(s("text", { class: "container-name", x: layout.x - 8, y: midY, "text-anchor": "end", "dominant-baseline": "central" }, track.typeName));

  track.order.forEach((id, column) => {
    const node = state.nodes.get(id);
    if (!node) return; // not reachable in this row
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const nodeG = s("g", { class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" ") });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: cellsY, w: valueW, changed: valueChanged }).el);

    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(s("g", { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
        s("rect", { x: sx, y: cellsY, width: SLOT_W, height: CELL_H, rx: 3 })));
      if (target === null) {
        // null / None: a slash through the slot.
        nodeG.append(s("line", { class: "null-slash", x1: sx + 4, y1: cellsY + CELL_H - 5, x2: sx + SLOT_W - 4, y2: cellsY + 5 }));
        return;
      }
      const cx = sx + SLOT_W / 2;
      nodeG.append(s("circle", { class: "ref-dot", cx, cy: midY, r: 3.5 }));
      const tColumn = track.order.indexOf(target);
      const tx = columnX(tColumn);
      const span = Math.abs(tColumn - column);
      let d: string;
      if (track.links.length === 1 && tColumn === column + 1) {
        d = `M${cx},${midY} L${tx - 2},${midY}`;
      } else if (k === 0) {
        // Over the top, into the top of the target's value cell.
        const top = cellsY - Math.min(ARC_TOP - 6, 12 + span * 4);
        const ex = tColumn === column ? tx + valueW / 2 - 6 : tx + valueW / 2;
        d = `M${cx},${cellsY} C${cx},${top} ${ex},${top} ${ex},${cellsY - 2}`;
      } else {
        // A second link (e.g. right) goes underneath.
        const bottom = cellsY + CELL_H + Math.min(ARC_BOTTOM + POINTER_H - 6, 14 + span * 4);
        // Land left of center, clear of the pointer markers under the node.
        const ex = tx + Math.min(8, valueW / 4);
        d = `M${cx},${cellsY + CELL_H} C${cx},${bottom} ${ex},${bottom} ${ex},${cellsY + CELL_H + 2}`;
      }
      arrowLayer.append(s("path", {
        d,
        class: ["link-arrow", linkChanged && "is-changed"].filter(Boolean).join(" "),
        "marker-end": linkChanged ? "url(#arrow-change)" : "url(#arrow-ref)",
      }));
    });
    trackG.append(nodeG);
  });

  // Variables that point at nodes, as markers under the node they point at.
  const pointers = state.pointers.map((p) => {
    const was = prev?.pointers.find((q) => q.name === p.name);
    return { ...p, changed: !!prev && was?.index !== p.index };
  });
  if (pointers.length) {
    trackG.append(pointerMarkers(pointers, columnX, valueW, cellsY + CELL_H, track.order.length));
  }
  g.append(trackG);
}

export interface LoopViewOptions {
  hideQuiet: boolean;
}

export function renderLoopHistory(trace: Trace, history: LoopHistory, options: LoopViewOptions): SVGSVGElement {
  const { rows } = history;
  const track = findLinkedTrack(rows.map((row) => ({ locals: row.frame.locals, heap: row.heap })));
  const trackRows: (LinkedRow | null)[] = rows.map((row) =>
    track ? linkedRow(track, { locals: row.frame.locals, heap: row.heap }) : null);
  const { containers, scalars } = pickVariables(trace, rows, !!track);

  // Column layout is shared by every row, so cells line up vertically.
  const columns: ContainerColumn[] = [];
  let x = MARGIN + GUTTER_W;
  for (const name of containers) {
    let cellW = CELL_MIN_W;
    let maxCells = 1;
    let hasPointers = false;
    for (const row of rows) {
      const obj = containerIn(row, name);
      if (!obj) continue;
      const cells = cellsOf(obj);
      maxCells = Math.max(maxCells, cells.length);
      for (const cell of cells) cellW = Math.max(cellW, cellWidth(cell.value), textWidth(cell.label, 11) + 10);
      if (pointersFor(name, trace.indexNames, new Map(row.frame.locals)).length) hasPointers = true;
    }
    const labelW = textWidth(name) + 12;
    columns.push({ name, x: x + labelW, cellW, hasPointers });
    x += labelW + maxCells * cellW + CONTAINER_GAP;
  }
  // The linked track goes after the containers, with nodes in fixed columns.
  let trackLayout: TrackLayout | null = null;
  if (track) {
    let valueW = CELL_MIN_W;
    for (const state of trackRows) {
      for (const node of state!.nodes.values()) if (node.value) valueW = Math.max(valueW, cellWidth(node.value));
    }
    const nodeW = valueW + track.links.length * SLOT_W;
    const labelW = textWidth(track.typeName) + 12;
    trackLayout = { track, x: x + labelW, valueW, nodeW };
    x += labelW + track.order.length * (nodeW + NODE_GAP) - NODE_GAP + CONTAINER_GAP;
  }
  const hasContent = columns.length > 0 || !!track;

  const scalarsX = hasContent ? x - CONTAINER_GAP + SCALARS_GAP : MARGIN + GUTTER_W;
  const scalarsW = Math.max(0, ...rows.map((row) => scalarText(row, scalars).length)) * 12.5 * 0.6;
  const contentW = scalarsX + scalarsW;
  const anyPointers = columns.some((c) => c.hasPointers) || trackRows.some((r) => !!r?.pointers.length);
  // Space above the cells: index labels, or arcs for links that jump over nodes.
  const rowTop = track ? ARC_TOP : INDEX_H;
  const rowH = rowTop + CELL_H + (anyPointers ? POINTER_H : 6) + (track && track.links.length > 1 ? ARC_BOTTOM : 0);

  // Which rows changed something compared with the row before?
  const trackSignature = (i: number) => (trackRows[i] ? linkedSignature(trackRows[i]!) : "");
  const changed = rows.map((row, i) =>
    i === 0 ||
    containers.some((name) => signature(containerIn(row, name)) !== signature(containerIn(rows[i - 1], name))) ||
    trackSignature(i) !== trackSignature(i - 1));

  // Collapse runs of quiet iterations into a single band, but only for loops
  // that mutate data. In a read-only loop (a search, a scan) the moving
  // indices are the story, so every row stays.
  const mutates = changed.some((c, i) => c && i > 0);
  const items: Item[] = [];
  rows.forEach((row, index) => {
    const isLast = index === rows.length - 1;
    if (!options.hideQuiet || !mutates || changed[index] || isLast || !hasContent) {
      items.push({ kind: "row", row, index });
      return;
    }
    const prev = items[items.length - 1];
    if (prev?.kind === "band") prev.to = row.iteration;
    else items.push({ kind: "band", from: row.iteration, to: row.iteration });
  });
  let hiddenRows = 0;
  const rowItems = items.filter((item) => item.kind === "row").length;
  if (rowItems > MAX_ROWS) {
    let toDrop = rowItems - MAX_ROWS;
    while (toDrop > 0 && items.length) {
      const dropped = items.shift()!;
      if (dropped.kind === "row") { toDrop--; hiddenRows++; }
    }
  }

  const svg = s("svg", { class: "loop-svg", xmlns: "http://www.w3.org/2000/svg" });
  svg.append(arrowMarkers());
  const rowLayer = s("g", { class: "loop-rows" });
  const arrowLayer = s("g", { class: "arrows" });
  svg.append(rowLayer, arrowLayer);

  let y = MARGIN;
  if (hiddenRows) {
    rowLayer.append(s("text", { class: "loop-note", x: MARGIN, y: y + 12 }, `${hiddenRows} earlier iterations not shown`));
    y += 28;
  }

  let prevDrawn: { row: LoopRow; y: number; index: number } | null = null;
  for (const item of items) {
    if (item.kind === "band") {
      const text = item.from === item.to ? `#${item.from}: nothing changed` : `#${item.from} to #${item.to}: nothing changed`;
      const textX = MARGIN + GUTTER_W;
      rowLayer.append(s("g", { class: "quiet-band" },
        s("line", { x1: MARGIN, x2: contentW, y1: y + BAND_H / 2, y2: y + BAND_H / 2 }),
        s("rect", { x: textX - 8, y: y + 4, width: uiTextWidth(text, 12.5) + 16, height: BAND_H - 8, rx: 4 }),
        s("text", { x: textX, y: y + BAND_H / 2, "dominant-baseline": "central" }, text)));
      y += BAND_H + 6;
      continue;
    }

    const { row, index } = item;
    const isCurrent = history.running && index === rows.length - 1;
    const prevRow = index > 0 ? rows[index - 1] : null;
    const g = s("g", { class: ["loop-row", isCurrent && "is-current"].filter(Boolean).join(" ") });
    if (isCurrent) {
      g.append(s("rect", { class: "current-band", x: MARGIN - 8, y: y - 6, width: contentW - MARGIN + 16, height: rowH + 10, rx: 6 }));
    }
    const cellsY = y + rowTop;
    const labelsY = cellsY - INDEX_H;
    const midY = cellsY + CELL_H / 2;
    g.append(s("text", { class: "iteration-label", x: MARGIN, y: midY, "dominant-baseline": "central" },
      row.iteration === 0 ? "before" : `#${row.iteration}`));

    // Scalars to the right of the cells: "i = 2   j = 0", changes emphasized.
    const scalarLine = s("text", { class: "scalars", x: scalarsX, y: midY, "dominant-baseline": "central" });
    let first = true;
    for (const name of scalars) {
      const value = scalarIn(row, name);
      if (value?.kind !== "prim") continue;
      const before = prevRow ? scalarIn(prevRow, name) : undefined;
      const isChanged = !!prevRow && (!before || valueKey(before) !== valueKey(value));
      scalarLine.append(s("tspan", { class: isChanged ? "is-changed" : null, dx: first ? 0 : 22 }, `${name} = ${value.repr}`));
      first = false;
    }
    g.append(scalarLine);
    const changedNames = new Set(scalars.filter((name) => {
      const a = scalarIn(row, name);
      const b = prevRow ? scalarIn(prevRow, name) : undefined;
      return !!prevRow && (!a || !b || valueKey(a) !== valueKey(b));
    }));

    for (const column of columns) {
      const obj = containerIn(row, column.name);
      g.append(s("text", { class: "container-name", x: column.x - 8, y: midY, "text-anchor": "end", "dominant-baseline": "central" }, column.name));
      if (!obj) continue;
      const cells = cellsOf(obj);
      const prevObj = prevDrawn ? containerIn(prevDrawn.row, column.name) : undefined;
      const replaced = !!prevObj && prevObj.id !== obj.id;
      const prevCells = prevObj && !replaced ? cellsOf(prevObj) : [];
      const prevByKey = new Map(prevCells.map((c) => [c.key, c]));
      const prevIndexOf = new Map(prevCells.map((c, i) => [c.key, i]));

      const changedKeys = new Set(cells.filter((c) => {
        const p = prevByKey.get(c.key);
        return !!prevObj && (!p || valueKey(p.value) !== valueKey(c.value));
      }).map((c) => c.key));

      const containerG = s("g", { class: ["loop-container", replaced && "is-new"].filter(Boolean).join(" ") });
      if (!cells.length) {
        containerG.append(s("g", { class: "cell is-empty" },
          s("rect", { x: column.x, y: cellsY, width: column.cellW, height: CELL_H, rx: 3 }),
          s("text", { class: "value v-none", x: column.x + column.cellW / 2, y: cellsY + CELL_H / 2, "text-anchor": "middle", "dominant-baseline": "central" }, "∅")));
      }
      cells.forEach((cell, i) => {
        const cx = column.x + i * column.cellW;
        if (cell.label) containerG.append(s("text", { class: "index", x: cx + column.cellW / 2, y: labelsY + 9, "text-anchor": "middle" }, cell.label));
        const { el } = valueCell(cell.value, { x: cx, y: cellsY, w: column.cellW, changed: changedKeys.has(cell.key) });
        containerG.append(el);
      });
      if (obj.kind !== "dict" && obj.kind !== "set") {
        const pointers = pointersFor(column.name, trace.indexNames, new Map(row.frame.locals), changedNames);
        if (pointers.length) containerG.append(pointerMarkers(pointers, (i) => column.x + i * column.cellW, column.cellW, cellsY + CELL_H, cells.length));
      }
      g.append(containerG);

      // Change arrows from the previous drawn row. For lists, a value that
      // moved from another changed index (a swap) gets a crossing arrow.
      if (prevDrawn && prevObj && !replaced) {
        const fromY = prevDrawn.y + rowTop + CELL_H + (column.hasPointers ? POINTER_H - 2 : 2);
        const toY = labelsY - 3;
        const used = new Set<string>();
        const prevByValue = (c: Cell) => prevCells.find((p) =>
          p.key !== c.key && changedKeys.has(p.key) && !used.has(p.key) && valueKey(p.value) === valueKey(c.value));
        cells.forEach((cell, i) => {
          if (!changedKeys.has(cell.key)) return;
          const toX = column.x + i * column.cellW + column.cellW / 2;
          const moved = obj.kind === "list" || obj.kind === "tuple" ? prevByValue(cell) : undefined;
          const sourceKey = moved?.key ?? (prevByKey.has(cell.key) ? cell.key : undefined);
          if (sourceKey === undefined) return;
          if (moved) used.add(moved.key);
          const fromX = column.x + prevIndexOf.get(sourceKey)! * column.cellW + column.cellW / 2;
          arrowLayer.append(changeArrow({ x: fromX, y: fromY }, { x: toX, y: toY }));
        });
      }
    }

    if (trackLayout) {
      // Highlights compare with the row drawn just above, like the containers.
      const prevState = prevDrawn ? trackRows[prevDrawn.index] : null;
      drawTrack(g, arrowLayer, trackLayout, trackRows[index]!, prevState, cellsY);
    }

    rowLayer.append(g);
    prevDrawn = { row, y, index };
    y += rowH + ROW_GAP;
  }

  const width = contentW + MARGIN;
  const height = y - ROW_GAP + MARGIN;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return svg;
}
