import { describe, expect, it } from "vitest";
import { ARRAY_METHODS } from "./arrays";
import { checkTable, costOf } from "./tableTests";

describe("array methods cost what the table says", () => {
  checkTable(ARRAY_METHODS, "xs", "", { name: "xs", len: true });
});

describe("arrays", () => {
  it("a callback loop's body is the callback's", () => {
    const [loop] = costOf(
      "function g(x) {}\nfunction f(xs) {\n  xs.forEach((x) => { xs.indexOf(x); });\n  xs.map(g);\n}",
    );
    expect(loop).toMatchObject({ kind: "loop", body: [{ kind: "op", cost: "linear" }] });
    const named = costOf("function g(x) {}\nfunction f(xs) {\n  xs.map(g);\n}");
    expect(named[0]).toMatchObject({ kind: "loop", body: [{ kind: "call", callee: "g", shrink: "same" }] });
  });

  it("a method of the program's own isn't a built-in", () => {
    const source = "class Q {\n  push(x) {}\n}\nfunction f(xs) {\n  const q = new Q();\n  q.push(1);\n  xs.push(1);\n}";
    const nodes = costOf(source).filter((n) => n.line > 5);
    expect(nodes).toEqual([
      expect.objectContaining({ kind: "call", callee: "Q.push" }),
      expect.objectContaining({ kind: "alloc", into: "xs" }),
    ]);
  });

  it("sorting a temporary is still n log n", () => {
    expect(costOf("function f(xs) {\n  [...xs].sort();\n}")).toContainEqual(
      expect.objectContaining({ kind: "op", what: "sort()", cost: "nlogn" }),
    );
  });

  it("nested arrays allocate rows times columns", () => {
    const nodes = costOf("function f(n, m) {\n  const grid = Array.from({ length: n }, () => Array(m).fill(0));\n}");
    expect(nodes).toContainEqual(expect.objectContaining({ kind: "alloc", sizes: [{ name: "n" }, { name: "m" }] }));
    const mapped = costOf("function f(n, m) {\n  const grid = Array(n).fill(0).map(() => new Array(m));\n}");
    expect(mapped).toContainEqual(expect.objectContaining({ kind: "alloc", sizes: [{ name: "n" }, { name: "m" }] }));
  });
});
