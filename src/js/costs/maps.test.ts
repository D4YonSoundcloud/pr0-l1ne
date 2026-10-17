import { describe, expect, it } from "vitest";
import { MAP_METHODS } from "./maps";
import { checkTable, costOf } from "./tableTests";

describe("Map and Set methods cost what the table says", () => {
  // m measures what it was made from.
  checkTable(MAP_METHODS, "m", "const m = new Map(xs);", { name: "xs", len: true });
});

describe("maps, sets and dictionaries", () => {
  it("are hashed: lookups are constant time, even on names arrays would walk", () => {
    const nodes = costOf(
      "function f(xs) {\n  const seen = new Set();\n  const d = {};\n  seen.includes(1);\n  d.indexOf(1);\n  'k' in d;\n}",
    );
    expect(nodes.filter((n) => n.kind === "op")).toEqual([]);
  });

  it("grow when a key is set", () => {
    const nodes = costOf(
      "function f(xs) {\n  const d = {};\n  for (const x of xs) d[x] = 1;\n  const w = new WeakMap();\n}",
    );
    expect(nodes.find((n) => n.kind === "loop")).toMatchObject({ body: [{ kind: "alloc", into: "d" }] });
  });

  it("a Map's item is one item of what it holds", () => {
    const nodes = costOf(
      "function f(graph, node) {\n  const g = new Map(graph);\n  for (const next of g.get(node) ?? []) {}\n}",
    );
    expect(nodes.at(-1)).toMatchObject({ bound: { kind: "size", sizes: [{ name: "graph", inner: true }] } });
  });
});
