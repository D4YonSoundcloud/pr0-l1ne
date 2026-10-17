/** costAnalysis: one CostFunction per named function, with its parameters and how its recursion shrinks. */
import { describe, expect, it } from "vitest";
import type { CostFunction } from "../trace/types";
import { instrument } from "./instrument";
import { instrumentTypeScript } from "./typescript";

const functions = (source: string) => instrument(source).cost!.functions;
const fn = (source: string, name: string) => functions(source).find((f) => f.name === name) as CostFunction;

describe("costAnalysis", () => {
  it("has the program, then each named function, but not inline callbacks", () => {
    expect(functions("function a() {}\nconst b = () => 1;\n[1].map((x) => x);\n").map((f) => f.name)).toEqual([
      "Global",
      "a",
      "b",
    ]);
  });

  it("knows parameters by name, defaults included (patterns have none)", () => {
    expect(fn("function f(a, b = 2, { c }, ...rest) {}", "f").params).toEqual(["a", "b", "", ""]);
    const ts = instrumentTypeScript("class P {\n  constructor(public x: number, y = 1) {}\n}\n").cost!;
    expect(ts.functions.find((f) => f.name === "P.constructor")?.params).toEqual(["x", "y"]);
  });

  it("says how each recursive call shrinks its input", () => {
    const shrink = (source: string, name = "f") =>
      JSON.stringify(fn(source, name).body)
        .match(/"shrink":"(\w+)"/g)
        ?.map((s) => s.slice(10, -1));
    expect(shrink("function f(n) {\n  if (n < 1) return 0;\n  return f(n - 1);\n}")).toEqual(["minus"]);
    expect(
      shrink("function f(xs) {\n  const mid = Math.floor(xs.length / 2);\n  return f(xs.slice(0, mid));\n}"),
    ).toEqual(["half"]);
    expect(shrink("function f(node) {\n  if (!node) return 0;\n  return f(node.left) + f(node.right);\n}")).toEqual([
      "child",
      "child",
    ]);
    // r + 1 and r - 1: a search over a grid, not a shrink
    expect(shrink("function f(r) {\n  for (let i = 0; i < 2; i++) {\n    f(r + 1);\n    f(r - 1);\n  }\n}")).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  it("notices memoization", () => {
    expect(
      fn("function f(n, memo) {\n  if (memo.has(n)) return memo.get(n);\n  memo.set(n, f(n - 1));\n}", "f").memo,
    ).toBe(true);
    expect(fn("function f(n, memo) {\n  if (n in memo) return memo[n];\n  memo[n] = f(n - 1);\n}", "f").memo).toBe(
      true,
    );
    expect(fn("function f(n) {\n  return f(n - 1);\n}", "f").memo).toBe(false);
  });
});
