/**
 * Any heap object as a shape (lists and the like in sequences.ts, the rest
 * as tables), and what goes in a value slot: a cell, or in nested mode the
 * whole shape of the object it refers to.
 */
import { valueKey } from "../../trace/diff";
import type { HeapObject, Value } from "../../trace/types";
import { cellWidth, valueCell } from "../draw";
import { sequenceShape } from "./sequences";
import { type Ctx, type Shape, sizeLabel, type View } from "./shapes";
import { tableShape } from "./tables";

export function viewOf(value: Value, ctx: Ctx, cellH: number): View {
  if (value.kind === "ref" && ctx.nested.has(value.id) && ctx.step.heap[value.id]) {
    const shape = objectShape(ctx.step.heap[value.id], ctx, true);
    return {
      w: shape.w,
      h: shape.h,
      nested: true,
      draw(x, y, _w, _h, layer, refs) {
        shape.draw(x, y, layer, refs);
      },
    };
  }
  return {
    w: cellWidth(value),
    h: cellH,
    nested: false,
    draw(x, y, w, h, layer, refs, changed) {
      const { el, dot } = valueCell(value, { x, y, w, h, changed });
      layer.append(el);
      if (dot && value.kind === "ref") refs.push({ from: dot, target: value.id, changed });
      return el;
    },
  };
}

/** An object's shape, with each arrow leaving its cells marked as starting in it (for its arrow's kind). */
export function objectShape(obj: HeapObject, ctx: Ctx, nested = false): Shape {
  const shape = shapeOf(obj, ctx, nested);
  return {
    ...shape,
    draw(x, y, layer, refs, ...rest) {
      const before = refs.length;
      const result = shape.draw(x, y, layer, refs, ...rest);
      for (let k = before; k < refs.length; k++) refs[k].owner ??= obj.id;
      return result;
    },
  };
}

function shapeOf(obj: HeapObject, ctx: Ctx, nested: boolean): Shape {
  const changed = ctx.diff.changedSlots.get(obj.id) ?? new Set<string>();
  const isNew = ctx.diff.newObjects.has(obj.id);
  switch (obj.kind) {
    case "list":
    case "tuple":
    case "set":
      return sequenceShape(obj, ctx, { changed, isNew, pointers: ctx.pointersFor(obj.id), nested });
    case "dict":
      return tableShape(
        obj.typeName,
        obj.entries.map(([key, value]) => ({ label: key, value, changed: changed.has(valueKey(key)) })),
        ctx,
        { variant: "dict", isNew, emptyText: "empty", nested, sizeText: sizeLabel(ctx, obj.id) },
      );
    case "object":
      return tableShape(
        ctx.titleOf(obj),
        obj.fields.map(([name, value]) => ({ label: name, value, changed: changed.has(name) })),
        ctx,
        { variant: "instance", isNew, emptyText: "no fields", nested, sizeText: sizeLabel(ctx, obj.id) },
      );
    case "function": {
      const title = obj.builtin
        ? `builtin ${obj.name}`
        : `${ctx.functionKeyword} ${obj.name}(${obj.params.join(", ")})`;
      return tableShape(
        title,
        obj.fields.map(([name, value]) => ({ label: name, value, changed: changed.has(name) })),
        ctx,
        { variant: "function", isNew, nested, sizeText: sizeLabel(ctx, obj.id) },
      );
    }
    case "class":
      return tableShape(`class ${obj.name}`, [], ctx, {
        variant: "class",
        isNew,
        nested,
        sizeText: sizeLabel(ctx, obj.id),
      });
    case "opaque":
      return tableShape(
        obj.typeName,
        [{ label: "", value: { kind: "prim", type: "repr", repr: obj.repr }, changed: changed.has("*") }],
        ctx,
        { variant: "opaque", isNew, nested, sizeText: sizeLabel(ctx, obj.id) },
      );
  }
}
