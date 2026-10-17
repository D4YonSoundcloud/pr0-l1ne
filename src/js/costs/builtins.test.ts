import { describe, expect, it } from "vitest";
import { ARRAY_METHODS } from "./arrays";
import { BUILTIN_CALLS, METHODS } from "./builtins";
import { mergeTables } from "./table";
import { costOf } from "./tableTests";

describe("built-in functions", () => {
  for (const name of Object.keys(BUILTIN_CALLS)) {
    it(`${name}(xs) is as long as xs`, () => {
      const nodes = costOf(`function f(xs) {\n  ${name}(xs);\n  for (const y of ${name}(xs)) {}\n}`);
      expect(nodes).toEqual([
        expect.objectContaining({
          kind: "loop",
          bound: expect.objectContaining({ sizes: [{ name: "xs", len: true }] }),
        }),
      ]);
    });
  }

  it("Array.from(xs) is as long as xs", () => {
    expect(costOf("function f(xs) {\n  for (const x of Array.from(xs)) {}\n}")[0]).toMatchObject({
      bound: { kind: "size", sizes: [{ name: "xs", len: true }] },
    });
  });

  it("Array.from({ length: n }) makes n items", () => {
    expect(costOf("function f(n) {\n  for (const x of Array.from({ length: n })) {}\n}")[0]).toMatchObject({
      bound: { kind: "size", sizes: [{ name: "n" }] },
    });
  });

  it("Math keeps sizes, and rounding halves them", () => {
    const [loop] = costOf("function f(n) {\n  for (let i = 0; i < Math.max(n, 1); i++) {}\n}");
    expect(loop).toMatchObject({ bound: { kind: "size", sizes: [{ name: "n" }] } });
    const nodes = costOf("function f(n) {\n  let k = n;\n  while (k > 1) k = Math.floor(k / 2);\n}");
    expect(nodes.at(-1)).toMatchObject({ bound: { kind: "log" } });
  });
});

describe("the method tables", () => {
  it("merge into one lookup by name", () => {
    expect(METHODS.get("slice")).toEqual(ARRAY_METHODS.slice);
    expect(METHODS.get("has")).toEqual({ cost: "const" });
    expect(METHODS.get("constructor")).toBeUndefined();
  });

  it("must agree on a name they share", () => {
    expect(() => mergeTables({ slice: { cost: "linear" } }, { slice: { cost: "const" } })).toThrow(/slice costs/);
  });
});
