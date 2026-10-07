import { describe, expect, it } from "vitest";
import type { HeapObject, Step, Value } from "../trace/types";
import { MAX_NEST_DEPTH, chooseNested } from "./memory";

const ref = (id: string): Value => ({ kind: "ref", id });
const num = (n: number): Value => ({ kind: "prim", type: "int", repr: String(n) });
const none: Value = { kind: "prim", type: "none", repr: "None" };

const list = (id: string, items: Value[]): HeapObject => ({ kind: "list", id, typeName: "list", items, length: items.length });
const node = (id: string, next: Value): HeapObject => ({ kind: "object", id, typeName: "Node", fields: [["val", num(1)], ["next", next]] });

function step(locals: [string, Value][], objects: HeapObject[]): Step {
  return {
    event: "line",
    line: 1,
    stack: [{ id: "f1", func: "Global", line: 1, locals }],
    heap: Object.fromEntries(objects.map((o) => [o.id, o])),
    stdoutLength: 0,
    loops: [],
  };
}

describe("chooseNested", () => {
  it("nests an object referenced from exactly one place", () => {
    expect(chooseNested(step([["arr", ref("o1")]], [list("o1", [num(1)])]))).toEqual(new Set(["o1"]));
  });

  it("keeps a shared object separate, so arrows can show the sharing", () => {
    const s = step([["a", ref("o1")], ["b", ref("o1")]], [list("o1", [])]);
    expect(chooseNested(s)).toEqual(new Set());
  });

  it("nests a chain until it reaches a shared node", () => {
    // head -> o1 -> o2 -> o3, and curr also points at o2
    const s = step(
      [["head", ref("o1")], ["curr", ref("o2")]],
      [node("o1", ref("o2")), node("o2", ref("o3")), node("o3", none)],
    );
    expect(chooseNested(s)).toEqual(new Set(["o1", "o3"]));
  });

  it("keeps cycles as arrows", () => {
    // a -> o1 -> o2 -> o1
    const s = step([["a", ref("o1")]], [node("o1", ref("o2")), node("o2", ref("o1"))]);
    expect(chooseNested(s)).toEqual(new Set(["o2"])); // o1 has two references
  });

  it("starts a new box past the depth limit, and nests again inside it", () => {
    const count = MAX_NEST_DEPTH + 3;
    const nodes = Array.from({ length: count }, (_, i) => node(`o${i + 1}`, i + 1 < count ? ref(`o${i + 2}`) : none));
    const nested = chooseNested(step([["head", ref("o1")]], nodes));
    const separate = nodes.map((n) => n.id).filter((id) => !nested.has(id));
    // A long chain becomes boxes of bounded depth joined by arrows.
    expect(separate).toEqual([`o${MAX_NEST_DEPTH + 1}`]);
  });

  it("nests inside a shared object", () => {
    // Two variables share o1, which alone holds o2.
    const s = step([["a", ref("o1")], ["b", ref("o1")]], [list("o1", [ref("o2")]), list("o2", [])]);
    expect(chooseNested(s)).toEqual(new Set(["o2"]));
  });

  it("never nests dict keys", () => {
    const dict: HeapObject = { kind: "dict", id: "o1", typeName: "dict", entries: [[ref("o2"), num(1)]], length: 1 };
    const key: HeapObject = { kind: "tuple", id: "o2", typeName: "tuple", items: [], length: 0 };
    expect(chooseNested(step([["d", ref("o1")]], [dict, key]))).toEqual(new Set(["o1"]));
  });
});
