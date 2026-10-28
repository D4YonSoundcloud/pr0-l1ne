/**
 * Two ways a hint draws a list instead of a row of cells:
 *
 *   recordsShape    `viz: table people`: a list (or dict) of dicts or
 *                   objects as one table, a row per item and a column per
 *                   key, like a spreadsheet
 *   intervalsShape  `viz: intervals meetings`: a list of pairs (or of
 *                   objects with a start and an end) as bars along a number
 *                   line, one row each, so overlaps and gaps show
 *
 * The items are drawn inside (the scene nests them, scene/memoryScene.ts),
 * and each row keeps its item's id from step to step, so sorting the list
 * slides its rows.
 */
import type { DrawAs } from "../../scene/memoryScene";
import { valueKey } from "../../trace/diff";
import { intervalOf } from "../../trace/hints";
import type { HeapObject, SequenceObject, Value } from "../../trace/types";
import {
  CELL_H,
  CELL_MIN_W,
  INDEX_H,
  LABEL_H,
  rowPointerMarkers,
  rowPointersWidth,
  s,
  textWidth,
  uiTextWidth,
  valueCell,
} from "../draw";
import {
  type Ctx,
  labelWithSize,
  markCell,
  NEST_PAD,
  type Pointers,
  type Shape,
  sizedLabelWidth,
  sizeLabel,
  type View,
} from "./shapes";

/** At most this many columns: a wider table is hard to read. */
const MAX_COLUMNS = 12;
const HEAD_H = 20;

interface Item {
  /** Its index, or its key in a dict. */
  label: string;
  /** The slot it's in, as the diff names it. */
  slot: string;
  value: Value;
}

/** A dict key as a column heading: a string without its quotes. */
const keyName = (key: Value) => (key.kind === "prim" ? key.repr.replace(/^(["'`])(.*)\1$/, "$2") : "(object)");

/** An item's fields, if it's a dict or object drawn inside the table: [heading, slot, value]. */
function fieldsOf(item: Value, ctx: Ctx): [string, string, Value][] | null {
  if (item.kind !== "ref" || !ctx.nested.has(item.id)) return null;
  const obj = ctx.step.heap[item.id];
  if (obj?.kind === "dict") return obj.entries.map(([k, v]) => [keyName(k), valueKey(k), v]);
  if (obj?.kind === "object") return obj.fields.map(([name, v]) => [name, name, v]);
  return null;
}

/** The items of a list, or a dict's values under their keys. */
function itemsOf(obj: SequenceObject | HeapObject): Item[] {
  if (obj.kind === "dict") return obj.entries.map(([k, v]) => ({ label: keyName(k), slot: valueKey(k), value: v }));
  if (obj.kind === "list" || obj.kind === "tuple") {
    const offset = obj.offset ?? 0;
    return obj.items.map((value, i) => ({ label: String(offset + i), slot: String(offset + i), value }));
  }
  return [];
}

/**
 * `viz: table`: a row per item, a column per key (in the order they're
 * first seen). Null when no item is a dict or object drawn inside it, so
 * the list is drawn as usual.
 */
export function recordsShape(
  obj: SequenceObject | HeapObject,
  ctx: Ctx,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape | null {
  const items = itemsOf(obj);
  const fields = items.map((item) => fieldsOf(item.value, ctx));
  if (!fields.some(Boolean)) return null;
  const headings: string[] = [];
  for (const row of fields) for (const [name] of row ?? []) if (!headings.includes(name)) headings.push(name);
  const columns = headings.slice(0, MAX_COLUMNS);
  const more = headings.length - columns.length;
  // Each cell's view, by row and column (null: the row has no such key).
  const views: (View | null)[][] = items.map((item, r) => {
    const row = fields[r];
    if (!row) return [ctx.view(item.value, CELL_H)];
    return columns.map((name) => {
      const field = row.find(([n]) => n === name);
      return field ? ctx.view(field[2], CELL_H) : null;
    });
  });
  const pad = views.flat().some((v) => v?.nested) ? NEST_PAD : 0;
  const colW = columns.map((name, c) =>
    Math.max(
      CELL_MIN_W,
      textWidth(name, 11.5) + 14,
      ...views.map((row, r) => (fields[r] ? (row[c]?.w ?? 0) + 2 * pad : 0)),
    ),
  );
  const tableW = colW.reduce((a, b) => a + b, 0) + (more ? 28 : 0);
  const rowHs = views.map((row) => Math.max(CELL_H, ...row.map((v) => (v?.nested ? v.h + 2 * pad : CELL_H))));
  const labelW = Math.max(...items.map((i) => textWidth(i.label, 10.5)), 6) + 10;
  const pointersW = rowPointersWidth(opts.pointers);
  const total = obj.kind === "dict" ? obj.entries.length : obj.kind === "list" || obj.kind === "tuple" ? obj.length : 0;
  const truncated = obj.kind !== "dict" && total > items.length;
  const size = sizeLabel(ctx, obj.id);
  const label = `${obj.typeName}, ${total} ${total === 1 ? "row" : "rows"}${truncated ? ` (first ${items.length})` : ""}`;
  const headY = LABEL_H;
  const bodyY = headY + HEAD_H;
  const bodyH = rowHs.reduce((a, b) => a + b, 0);
  const w = Math.max(labelW + tableW + pointersW, sizedLabelWidth(label, size) + 8);
  const h = bodyY + bodyH + 4;

  return {
    w,
    h,
    inY: LABEL_H / 2,
    draw(x, y, layer, refs) {
      const g = s("g", {
        class: ["seq", "records", obj.kind, opts.isNew && "is-new", opts.nested && "is-nested"]
          .filter(Boolean)
          .join(" "),
      });
      g.append(labelWithSize(x, y + 11, label, size));
      const x0 = x + labelW;
      let cx = x0;
      columns.forEach((name, c) => {
        g.append(
          s("rect", { class: "records-head-bg", x: cx, y: y + headY, width: colW[c], height: HEAD_H - 2, rx: 3 }),
          s(
            "text",
            {
              class: "records-head",
              x: cx + colW[c] / 2,
              y: y + headY + (HEAD_H - 2) / 2,
              "text-anchor": "middle",
              "dominant-baseline": "central",
            },
            name,
          ),
        );
        cx += colW[c];
      });
      if (more)
        g.append(
          s(
            "text",
            { class: "index", x: cx + 6, y: y + headY + (HEAD_H - 2) / 2, "dominant-baseline": "central" },
            `+${more}`,
          ),
        );
      let ry = y + bodyY;
      items.forEach((item, r) => {
        const rowH = rowHs[r];
        const replaced = opts.changed.has(item.slot);
        const itemId = item.value.kind === "ref" ? item.value.id : null;
        const inner = itemId ? (ctx.diff.changedSlots.get(itemId) ?? new Set<string>()) : new Set<string>();
        const isNewRow = !!itemId && ctx.diff.newObjects.has(itemId);
        // Keyed by the item, so a row slides when the list is sorted.
        const key = itemId ?? `slot:${item.slot}`;
        const rowG = s("g", {
          class: ["records-row", replaced && "is-changed", isNewRow && "is-new"].filter(Boolean).join(" "),
          "data-flip": `rec:${obj.id}:${key}`,
          "data-x": Math.round(x0 - x),
          "data-y": Math.round(ry - y),
        });
        rowG.append(
          s(
            "text",
            { class: "index", x: x0 - 6, y: ry + CELL_H / 2, "text-anchor": "end", "dominant-baseline": "central" },
            item.label,
          ),
        );
        const row = fields[r];
        if (!row) {
          // Not a record (or drawn elsewhere): the value itself, in the first column.
          const view = views[r][0]!;
          const el = view.draw(x0, ry, Math.max(colW[0] ?? CELL_MIN_W, view.w), CELL_H, rowG, refs, replaced);
          markCell(el, obj.id, item.slot, item.value, x0 - x, 0);
        } else {
          let fx = x0;
          columns.forEach((name, c) => {
            const view = views[r][c];
            const field = row.find(([n]) => n === name);
            if (!view || !field) {
              rowG.append(
                s("g", { class: "cell is-empty" }, s("rect", { x: fx, y: ry, width: colW[c], height: CELL_H, rx: 3 })),
              );
            } else if (view.nested) {
              rowG.append(
                s(
                  "g",
                  { class: ["cell", "is-holder", inner.has(field[1]) && "is-changed"].filter(Boolean).join(" ") },
                  s("rect", { x: fx, y: ry, width: colW[c], height: rowH, rx: 3 }),
                ),
              );
              view.draw(fx + pad, ry + pad, view.w, view.h, rowG, refs, replaced || inner.has(field[1]));
            } else {
              const changed = replaced || inner.has(field[1]);
              const el = view.draw(fx, ry, colW[c], CELL_H, rowG, refs, changed);
              markCell(el, itemId!, field[1], field[2], fx - x0, 0);
            }
            fx += colW[c];
          });
        }
        g.append(rowG);
        ry += rowH;
      });
      if (opts.pointers.length) {
        const tops = rowHs.map((_, r) => rowHs.slice(0, r).reduce((a, b) => a + b, 0));
        const offset = obj.kind === "dict" ? 0 : ((obj as SequenceObject).offset ?? 0);
        g.append(
          rowPointerMarkers(
            opts.pointers.map((p) => ({ ...p, index: p.index - offset })),
            (r) => y + bodyY + tops[r] + CELL_H / 2,
            x0 + tableW,
            items.length,
            { key: `ptr:${obj.id}`, originX: x, originY: y },
          ),
        );
      }
      layer.append(g);
    },
  };
}

// ---------------------------------------------------------------- intervals

const AXIS_W = 320;
const BAR_ROW_H = 22;
const BAR_H = 12;
const AXIS_H = 22;

/** Round steps for an axis (1, 2 or 5 times a power of ten), about `count` of them. */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

const show = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6))));

/**
 * `viz: intervals`: each item a bar from its start to its end, on one axis
 * for the whole run (from the smallest start to the largest end it ever
 * has), so a bar's place means the same on every step. Null when no item is
 * an interval, so the list is drawn as usual.
 */
export function intervalsShape(
  obj: SequenceObject,
  ctx: Ctx,
  range: Extract<DrawAs, { kind: "intervals" }>,
  opts: { changed: Set<string>; isNew: boolean; pointers: Pointers; nested: boolean },
): Shape | null {
  const items = itemsOf(obj);
  const spans = items.map((item) => intervalOf(item.value, ctx.step.heap, range.fields));
  if (!spans.some(Boolean)) return null;
  const min = Math.min(range.min, ...spans.flatMap((sp) => sp ?? []));
  const max = Math.max(range.max, ...spans.flatMap((sp) => sp ?? []));
  const scale = AXIS_W / (max - min || 1);
  const at = (v: number) => (v - min) * scale;
  const labelW = Math.max(...items.map((i) => textWidth(i.label, 10.5)), 6) + 10;
  const textOf = (sp: [number, number] | null, item: Item) =>
    sp ? `${show(sp[0])}–${show(sp[1])}` : item.value.kind === "prim" ? item.value.repr : "?";
  const textsW = Math.max(...items.map((item, r) => uiTextWidth(textOf(spans[r], item), 11)));
  const pointersW = rowPointersWidth(opts.pointers);
  const size = sizeLabel(ctx, obj.id);
  const truncated = obj.length > items.length;
  const label = `${obj.typeName}, ${obj.length} ${obj.length === 1 ? "interval" : "intervals"}${truncated ? ` (first ${items.length})` : ""}`;
  const barsY = LABEL_H + 4;
  const w = Math.max(labelW + AXIS_W + 10 + textsW + 8 + pointersW, sizedLabelWidth(label, size) + 8);
  const h = barsY + items.length * BAR_ROW_H + AXIS_H + INDEX_H / 2;

  return {
    w,
    h,
    inY: LABEL_H / 2,
    draw(x, y, layer, refs) {
      const g = s("g", {
        class: ["seq", "intervals", opts.isNew && "is-new", opts.nested && "is-nested"].filter(Boolean).join(" "),
      });
      g.append(labelWithSize(x, y + 11, label, size));
      const x0 = x + labelW;
      const axisY = y + barsY + items.length * BAR_ROW_H + 4;
      // The axis, with round numbers, and faint lines up through the rows.
      const axis = s("g", { class: "interval-axis" });
      axis.append(s("line", { x1: x0, y1: axisY, x2: x0 + AXIS_W, y2: axisY }));
      for (const tick of niceTicks(min, max)) {
        const tx = x0 + at(tick);
        axis.append(
          s("line", { class: "interval-grid", x1: tx, y1: y + barsY, x2: tx, y2: axisY }),
          s("line", { x1: tx, y1: axisY, x2: tx, y2: axisY + 4 }),
          s("text", { class: "index", x: tx, y: axisY + 13, "text-anchor": "middle" }, show(tick)),
        );
      }
      g.append(axis);
      const pointed = new Set(opts.pointers.map((p) => p.index - (obj.offset ?? 0)));
      items.forEach((item, r) => {
        const sp = spans[r];
        const ry = y + barsY + r * BAR_ROW_H;
        const itemId = item.value.kind === "ref" ? item.value.id : null;
        const changed = opts.changed.has(item.slot) || (!!itemId && (ctx.diff.changedSlots.get(itemId)?.size ?? 0) > 0);
        const isNewRow = !!itemId && ctx.diff.newObjects.has(itemId);
        const rowG = s("g", {
          class: ["interval-row", changed && "is-changed", isNewRow && "is-new", pointed.has(r) && "is-pointed"]
            .filter(Boolean)
            .join(" "),
          "data-flip": `iv:${obj.id}:${itemId ?? `slot:${item.slot}`}`,
          "data-x": Math.round(x0 - x),
          "data-y": Math.round(ry - y),
        });
        rowG.append(
          s(
            "text",
            {
              class: "index",
              x: x0 - 6,
              y: ry + BAR_ROW_H / 2,
              "text-anchor": "end",
              "dominant-baseline": "central",
            },
            item.label,
          ),
        );
        let endX = x0;
        if (sp) {
          const [a, b] = sp[0] <= sp[1] ? sp : [sp[1], sp[0]];
          const bx = x0 + at(a);
          const bw = Math.max(3, at(b) - at(a));
          rowG.append(
            s("rect", {
              class: ["interval-bar", sp[0] > sp[1] && "is-reversed"].filter(Boolean).join(" "),
              x: bx,
              y: ry + (BAR_ROW_H - BAR_H) / 2,
              width: bw,
              height: BAR_H,
              rx: 3,
            }),
          );
          endX = bx + bw;
        }
        rowG.append(
          s(
            "text",
            { class: "interval-text", x: endX + 6, y: ry + BAR_ROW_H / 2, "dominant-baseline": "central" },
            textOf(sp, item),
          ),
        );
        // An item drawn as a box of its own (something else points to it too): an arrow to it.
        if (item.value.kind === "ref" && !ctx.nested.has(item.value.id)) {
          const { el, dot } = valueCell(item.value, {
            x: x0 + AXIS_W + 10 + textsW + 4,
            y: ry + 3,
            w: 16,
            h: BAR_ROW_H - 6,
            variant: "key",
          });
          rowG.append(el);
          if (dot) refs.push({ from: dot, target: item.value.id, changed });
        }
        g.append(rowG);
      });
      if (opts.pointers.length) {
        g.append(
          rowPointerMarkers(
            opts.pointers.map((p) => ({ ...p, index: p.index - (obj.offset ?? 0) })),
            (r) => y + barsY + r * BAR_ROW_H + BAR_ROW_H / 2,
            x0 + AXIS_W + 10 + textsW + 24,
            items.length,
            { key: `ptr:${obj.id}`, originX: x, originY: y },
          ),
        );
      }
      layer.append(g);
    },
  };
}
