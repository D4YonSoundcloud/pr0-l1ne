import { describe, expect, it } from "vitest";
import { compareGrowth, findSizes, fitGrowth, ladder, modelLabel, staticGrowth, type Fit } from "./growth";
import type { Estimate } from "./complexity";

describe("size hints", () => {
  it("finds hinted variables set to a number at the top level", () => {
    const { vars, problems } = findSizes("# viz: size n, k\nn = 40_000\nk: int = 10000\nnums = list(range(n))\n");
    expect(problems).toEqual([]);
    expect(vars).toEqual([
      { name: "n", base: 40000, codeValue: 40000, line: 2 },
      { name: "k", base: 10000, codeValue: 10000, line: 3 },
    ]);
  });

  it("takes the full size from the hint, so a small traced size can grow to it", () => {
    const { vars } = findSizes("// viz: size n = 40000\nconst n = 200;\n");
    expect(vars[0]).toMatchObject({ base: 40000, codeValue: 200 });
  });

  it("says when there's nothing to change", () => {
    const { vars, problems } = findSizes("# viz: size n\ndef f(n):\n    n = 3\n");
    expect(vars).toEqual([]);
    expect(problems[0]).toMatch(/no "n = <number>" at the top level/);
  });

  it("builds a ladder of sizes, scaling the chosen variables only", () => {
    const vars = findSizes("# viz: size n, k\nn = 40000\nk = 10000\n").vars;
    expect(ladder(vars, ["n", "k"]).map((r) => r.sizes)).toEqual([
      { n: 625, k: 156 }, { n: 2500, k: 625 }, { n: 10000, k: 2500 }, { n: 40000, k: 10000 },
    ]);
    expect(ladder(vars, ["n"]).map((r) => r.sizes.k)).toEqual([10000, 10000, 10000, 10000]);
    // Too small to scale down: duplicate sizes are dropped.
    expect(ladder(findSizes("# viz: size n\nn = 3\n").vars, ["n"]).map((r) => r.x)).toEqual([1, 3]);
  });
});

describe("fitting growth", () => {
  const points = (f: (x: number) => number) => [625, 2500, 10000, 40000].map((x) => ({ x, y: f(x) }));
  const label = (fit: Fit | null) => (fit ? modelLabel(fit.model) : null);

  it("recognizes the usual curves, with some constant overhead", () => {
    expect(label(fitGrowth(points(() => 50)))).toBe("1");
    expect(label(fitGrowth(points((x) => 3 * Math.log2(x) + 4)))).toBe("log n");
    expect(label(fitGrowth(points((x) => 2 * x + 30)))).toBe("n");
    expect(label(fitGrowth(points((x) => x * Math.log2(x) + 100)))).toBe("n log n");
    expect(label(fitGrowth(points((x) => 0.5 * x * x + 3 * x)))).toBe("n²");
    expect(label(fitGrowth(points((x) => x ** 3 / 1000)))).toBe("n³");
  });

  it("reports the log-log slope", () => {
    expect(fitGrowth(points((x) => x * x))!.exponent).toBeCloseTo(2, 5);
  });

  it("needs two sizes", () => {
    expect(fitGrowth([{ x: 10, y: 5 }])).toBeNull();
  });
});

describe("comparing with the code's estimate", () => {
  // O(n·k): n is len(nums), k is k.
  const estimate = {
    time: "O(n·k)",
    raw: { time: [{ pow: { "nums:len": 1, "k:value": 1 }, log: {}, exp: {}, fact: {} }], space: [] },
    symbols: [
      { key: "nums:len", letter: "n", name: "nums", meaning: "len(nums)", value: 200 },
      { key: "k:value", letter: "k", name: "k", meaning: "k", value: 30 },
    ],
  } as unknown as Estimate;
  const vars = findSizes("# viz: size n = 40000, k = 10000\nn = 200\nk = 30\n").vars;

  it("ties the estimate's sizes to the scaled variables by name or value", () => {
    expect(staticGrowth(estimate, vars, ["n", "k"])).toMatchObject({ model: { degree: 2, log: 0 }, letters: ["n", "k"] });
    expect(staticGrowth(estimate, vars, ["n"])).toMatchObject({ model: { degree: 1, log: 0 }, letters: ["n"] });
  });

  it("flags measured growth that doesn't match", () => {
    const est = staticGrowth(estimate, vars, ["n", "k"])!;
    const linear: Fit = { model: { degree: 1, log: 0 }, scale: 1, exponent: 1, error: 0 };
    const verdict = compareGrowth(linear, est, "n");
    expect(verdict.kind).toBe("lower");
    expect(verdict.text).toMatch(/O\(n·k\).*like n²/);
    expect(compareGrowth({ ...linear, model: { degree: 2, log: 0 } }, est, "n").kind).toBe("agree");
  });
});
