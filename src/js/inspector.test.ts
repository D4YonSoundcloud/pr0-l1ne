/** The value inspector, driven directly: how values look in the heap and in console.log. */
import { describe, expect, it } from "vitest";
import type { HeapObject, Value } from "../trace/types";
import {
  errorMessage,
  errorName,
  type Getter,
  inspect,
  MAX_ITEMS,
  parseParams,
  Serializer,
  windowStart,
} from "./inspector";

/** Serialize one value; returns it and the heap it reached. */
function serialize(
  value: unknown,
  options: { focus?: Map<object, number[]>; closures?: WeakMap<object, { name: string; captured: Getter }> } = {},
) {
  let n = 0;
  // biome-ignore lint/complexity/noBannedTypes: the serializer's own closure map type
  const closures = (options.closures ?? new WeakMap()) as WeakMap<Function, { name: string; captured: Getter }>;
  const s = new Serializer(new WeakMap(), () => `o${++n}`, closures, options.focus);
  const v = s.value(value);
  return { v, heap: s.heap, obj: (v.kind === "ref" ? s.heap[v.id] : undefined) as HeapObject };
}
const repr = (value: unknown) => (serialize(value).v as Extract<Value, { kind: "prim" }>).repr;

describe("plain values", () => {
  it("are shown the way you'd write them", () => {
    expect([1.5, -0, "hi", true, undefined, null, 10n, Symbol("s")].map(repr)).toEqual([
      "1.5",
      "-0",
      '"hi"',
      "true",
      "undefined",
      "null",
      "10n",
      "Symbol(s)",
    ]);
  });

  it("shortens long strings but keeps their real length", () => {
    const { v } = serialize("x".repeat(100));
    expect(v).toMatchObject({ kind: "prim", type: "string", length: 100 });
    expect((v as { repr: string }).repr).toHaveLength(48);
    expect(serialize("short").v).not.toHaveProperty("length");
  });
});

describe("lists", () => {
  it("show their first cells, and a strip of samples when they hold numbers", () => {
    const { obj } = serialize(Array.from({ length: 1000 }, (_, i) => i % 7));
    expect(obj).toMatchObject({ kind: "list", typeName: "Array", length: 1000 });
    expect((obj as { items: Value[] }).items).toHaveLength(MAX_ITEMS);
    expect(obj).not.toHaveProperty("offset");
    expect((obj as { strip: { values: number[]; min: number; max: number } }).strip).toMatchObject({ min: 0, max: 6 });
  });

  it("follow the index variables into the middle of a long list", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const { obj } = serialize(xs, { focus: new Map([[xs, [500]]]) });
    expect(obj).toMatchObject({ offset: 470 });
    const typed = new Int32Array(1000);
    const t = serialize(typed, { focus: new Map([[typed, [990]]]) }).obj;
    expect(t).toMatchObject({ kind: "list", typeName: "Int32Array", offset: 940, length: 1000 });
    expect(t).toHaveProperty("strip");
  });

  it("have no strip unless every sample is a finite number (true and false count as 1 and 0)", () => {
    expect(serialize(Array.from({ length: 100 }, (_, i) => i % 2 === 0)).obj).toHaveProperty("strip");
    expect(serialize(Array.from({ length: 100 }, () => "a")).obj).not.toHaveProperty("strip");
    expect(serialize(Array.from({ length: 100 }, () => Number.NaN)).obj).not.toHaveProperty("strip");
    const withGetter: number[] = Array.from({ length: 100 }, () => 1);
    Object.defineProperty(withGetter, 0, { get: () => 1 });
    const g = serialize(withGetter).obj as { items: Value[] };
    expect(g.items[0]).toMatchObject({ type: "getter", repr: "(getter)" });
    expect(g).not.toHaveProperty("strip");
    const typed = new Float64Array(100).fill(Number.POSITIVE_INFINITY);
    expect(serialize(typed).obj).not.toHaveProperty("strip");
  });

  it("put the window where it shows every index, in steps of 10", () => {
    expect(windowStart([5], 1000)).toBe(0);
    expect(windowStart([500], 1000)).toBe(470);
    expect(windowStart([100, 110], 1000)).toBe(70);
    expect(windowStart([0, 900], 1000)).toBe(0); // too far apart: start at the first
    expect(windowStart([995], 1000)).toBe(940); // never past the end
  });
});

describe("maps, sets and objects", () => {
  it("draw Maps and Sets with their first items and their size", () => {
    const big = new Map(Array.from({ length: 100 }, (_, i) => [i, i]));
    expect(serialize(big).obj).toMatchObject({ kind: "dict", typeName: "Map", length: 100 });
    expect((serialize(big).obj as { entries: unknown[] }).entries).toHaveLength(MAX_ITEMS);
    const set = serialize(new Set(Array.from({ length: 100 }, (_, i) => i))).obj;
    expect(set).toMatchObject({ kind: "set", length: 100 });
    expect((set as { items: unknown[] }).items).toHaveLength(MAX_ITEMS);
  });

  it("draw plain objects as dictionaries, and others with their class name", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    expect(serialize({ a: 1 }).obj).toMatchObject({ kind: "dict", typeName: "Object", length: 1 });
    expect(serialize(Object.create(null)).obj).toMatchObject({ kind: "dict", typeName: "Object" });
    expect(serialize(new Point(1, 2)).obj).toMatchObject({ kind: "object", typeName: "Point" });
    const noName = Object.create({ constructor: 5 });
    expect(serialize(noName).obj).toMatchObject({ kind: "object", typeName: "Object" });
  });

  it("show getters without calling them", () => {
    let called = false;
    const obj = {
      get x() {
        called = true;
        return 1;
      },
    };
    expect((serialize(obj).obj as { entries: [Value, Value][] }).entries[0][1]).toMatchObject({ repr: "(getter)" });
    expect(called).toBe(false);
  });

  it("draw a cycle once", () => {
    const a: { self?: unknown } = {};
    a.self = a;
    const { heap } = serialize(a);
    expect(Object.keys(heap)).toEqual(["o1"]);
  });

  it("stop drawing new objects past the limit", () => {
    const many = Array.from({ length: 50 }, () => Array.from({ length: 10 }, () => ({})));
    const { heap } = serialize(many);
    const cut = Object.values(heap).filter((o) => o.kind === "opaque" && o.repr === "…");
    expect(Object.keys(heap).length - cut.length).toBe(400); // drawn in full
    expect(cut.length).toBeGreaterThan(0); // named only, and what they hold isn't reached
  });
});

describe("functions, classes and opaque values", () => {
  it("name functions and their parameters, and what a closure captured", () => {
    const add = (a: number, b: number) => a + b;
    const closures = new WeakMap([[add, { name: "add", captured: (() => [["total", () => 3]]) as Getter }]]);
    expect(serialize(add, { closures }).obj).toMatchObject({
      kind: "function",
      name: "add",
      params: ["a", "b"],
      builtin: false,
    });
    expect((serialize(add, { closures }).obj as { fields: unknown[] }).fields).toEqual([
      ["total", { kind: "prim", type: "number", repr: "3" }],
    ]);
    expect(serialize(Math.max).obj).toMatchObject({ name: "max", params: [], builtin: true });
    expect(
      serialize(
        (
          () => () =>
            1
        )(),
      ).obj,
    ).toMatchObject({ name: "anonymous" });
  });

  it("draw classes as classes", () => {
    expect(serialize(class Thing {}).obj).toMatchObject({ kind: "class", name: "Thing" });
    expect(serialize((() => class {})()).obj).toMatchObject({ kind: "class", name: "anonymous" });
  });

  it("name what has no visible state", () => {
    function* gen() {}
    async function* agen() {}
    const reprs = [
      gen(),
      agen(),
      new Date(0),
      new Date(Number.NaN),
      /a+/g,
      new TypeError("bad"),
      Promise.resolve(),
      new WeakMap(),
      new WeakSet(),
      new ArrayBuffer(8),
    ].map((v) => (serialize(v).obj as { repr: string }).repr);
    expect(reprs).toEqual([
      "generator object",
      "async generator object",
      "1970-01-01T00:00:00.000Z",
      "Invalid Date",
      "/a+/g",
      "TypeError: bad",
      "Promise",
      "WeakMap",
      "WeakSet",
      "ArrayBuffer(8)",
    ]);
  });

  it("skip variables read before they're declared", () => {
    const s = new Serializer(new WeakMap(), () => "o1", new WeakMap());
    const getter: Getter = () => [
      [
        "early",
        () => {
          throw new ReferenceError("Cannot access before initialization");
        },
      ],
      ["ok", () => 1],
    ];
    expect(s.locals(getter).map(([name]) => name)).toEqual(["ok"]);
  });

  it("read parameter names from source text", () => {
    expect(parseParams("async x => x")).toEqual(["x"]);
    expect(parseParams("function f({ a = [1, 2] }, b) {}")).toEqual(["{ a", "b"]);
    expect(parseParams("no parens")).toEqual([]);
  });
});

describe("errors", () => {
  it("name what was thrown, whatever it is", () => {
    class Oops {}
    expect([new RangeError("x"), new Oops(), "text", 5, null].map(errorName)).toEqual([
      "RangeError",
      "Oops",
      "string",
      "number",
      "object",
    ]);
    expect([new Error("why"), "text", { code: 1 }, 5].map(errorMessage)).toEqual(["why", "text", "{ code: 1 }", "5"]);
  });

  it("fall back to String() when a thrown object can't be inspected", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no");
        },
      },
    );
    expect(errorMessage(hostile)).toBe("[object Object]");
  });
});

describe("console.log formatting", () => {
  it("prints each kind of value like Node does", () => {
    class Box {
      v = 1;
    }
    expect(
      [
        "top",
        5n,
        Symbol("s"),
        () => 1,
        function named() {},
        class Named {},
        (() => class {})(),
        null,
        undefined,
        new Date(0),
        new Date(Number.NaN),
        /x/,
        new Error("e"),
        [],
        new Map([[1, "a"]]),
        new Map(),
        new Set([1]),
        new Set(),
        {},
        { "a-b": 1, ok: 2 },
        new Box(),
      ].map((v) => inspect(v)),
    ).toEqual([
      "top",
      "5n",
      "Symbol(s)",
      "[Function (anonymous)]",
      "[Function: named]",
      "[class Named]",
      "[class (anonymous)]",
      "null",
      "undefined",
      "1970-01-01T00:00:00.000Z",
      "Invalid Date",
      "/x/",
      "Error: e",
      "[]",
      "Map(1) { 1 => 'a' }",
      "Map(0) {}",
      "Set(1) { 1 }",
      "Set(0) {}",
      "{}",
      "{ 'a-b': 1, ok: 2 }",
      "Box { v: 1 }",
    ]);
  });

  it("stops at depth 3, after 100 items, and at getters", () => {
    expect(inspect([[[[1]]], { a: { b: { c: {} } } }])).toBe("[ [ [ [Array] ] ], { a: { b: [Object] } } ]");
    expect(inspect(Array.from({ length: 102 }, () => 0))).toMatch(/, 0, \.\.\. 2 more items \]$/);
    expect(
      inspect({
        get x() {
          return 1;
        },
      }),
    ).toBe("{ x: [Getter] }");
  });
});
