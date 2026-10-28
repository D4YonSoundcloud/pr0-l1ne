// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { renderLoopHistory } from "../render/loopView";
import { renderMemory } from "../render/memory";
import { expandHeaps } from "../trace/delta";
import { diffSteps } from "../trace/diff";
import { applyHints, parseHints } from "../trace/hints";
import { buildLoopHistory } from "../trace/loopHistory";
import type { Trace, Value } from "../trace/types";
import { loopScene } from "./loopScene";
import { memoryScene } from "./memoryScene";
import { evaluateBound, windowsFor } from "./windows";

const int = (n: number): Value => ({ kind: "prim", type: "int", repr: String(n) });
const locals = (entries: Record<string, number>) => new Map(Object.entries(entries).map(([k, v]) => [k, int(v)]));
const windows = (text: string) => parseHints([{ line: 1, text }]).windows;

describe("windowsFor", () => {
  it("covers both ends by default, and leaves out an end written with ( or )", () => {
    expect(windowsFor("s", windows("window s: [left, right]"), locals({ left: 2, right: 4 }))).toEqual([
      { label: "[left, right]", start: 2, end: 5, changed: false },
    ]);
    expect(windowsFor("nums", windows("window nums: [i, i + k)"), locals({ i: 1, k: 3 }))[0]).toMatchObject({
      start: 1,
      end: 4,
    });
    expect(windowsFor("nums", windows("window nums: (a, b)"), locals({ a: 1, b: 4 }))[0]).toMatchObject({
      start: 2,
      end: 4,
    });
  });

  it("is empty when the start passes the end, and missing when a name isn't a whole number here", () => {
    expect(windowsFor("s", windows("window s: [left, right]"), locals({ left: 3, right: 1 }))[0]).toMatchObject({
      start: 3,
      end: 3,
    });
    expect(windowsFor("s", windows("window s: [left, right]"), locals({ left: 3 }))).toEqual([]);
    const notWhole = new Map<string, Value>([
      ["a", { kind: "prim", type: "number", repr: "1.5" }],
      ["b", int(2)],
    ]);
    expect(windowsFor("s", windows("window s: [a, b]"), notWhole)).toEqual([]);
    // Another list's window isn't this one's.
    expect(windowsFor("t", windows("window s: [a, b]"), locals({ a: 0, b: 1 }))).toEqual([]);
  });

  it("is changed when one of its names changed", () => {
    const [w] = windowsFor("s", windows("window s: [left, right]"), locals({ left: 0, right: 2 }), new Set(["right"]));
    expect(w.changed).toBe(true);
  });

  it("adds up an end's names and numbers", () => {
    const [w] = windows("window s: [r - k + 1, r]") ?? [];
    expect(evaluateBound(w.start, locals({ r: 5, k: 3 }))).toBe(3);
  });
});

function tracePython(source: string): Trace | null {
  try {
    const json = execFileSync(
      "python3",
      [
        "-c",
        "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read(), 3000))",
      ],
      { input: source, encoding: "utf8" },
    );
    return expandHeaps(JSON.parse(json) as Trace);
  } catch {
    return null; // Python not installed
  }
}

describe("drawing windows", () => {
  const examples = (list: { name: string; code: string }[]) => list.filter((e) => e.name.includes("· window"));
  const cases: [string, string, (code: string) => Promise<Trace | null> | Trace | null][] = [
    ...examples(JAVASCRIPT_EXAMPLES).map(
      (e) =>
        [`JavaScript: ${e.name}`, e.code, (c: string) => traceJavaScript(c)] as [
          string,
          string,
          (c: string) => Promise<Trace>,
        ],
    ),
    ...examples(PYTHON_EXAMPLES).map(
      (e) => [`Python: ${e.name}`, e.code, tracePython] as [string, string, typeof tracePython],
    ),
  ];

  it("has examples in both languages", () => {
    expect(cases.length).toBe(4);
  });

  it.each(cases)("%s: a band over the list in the memory view and every loop row", async (_name, code, trace) => {
    const raw = await trace(code);
    if (!raw) return;
    const t = applyHints(raw);
    expect(t.viz?.warnings).toEqual([]);
    // Somewhere in the loop, with the window over more than one item.
    const at = t.steps.findIndex((step, i) => {
      if (!step.loops.length || i === 0) return false;
      const svg = renderMemory(memoryScene(t, i, diffSteps(t.steps[i - 1], step), { mode: "nested" }));
      const band = svg.querySelector(".window-band:not(.is-empty) rect");
      return !!band && Number(band.getAttribute("width")) > 60;
    });
    expect(at).toBeGreaterThan(0);
    const memory = renderMemory(memoryScene(t, at, diffSteps(t.steps[at - 1], t.steps[at]), { mode: "arrows" }));
    expect(memory.querySelectorAll(".window-band").length).toBe(1);
    expect(memory.querySelector(".window-band title")?.textContent).toMatch(
      /^\[(left, right\]|i, i \+ k\)): \d+ items?$/,
    );
    const history = buildLoopHistory(t, at, null)!;
    const loop = renderLoopHistory(loopScene(t, history, { hideQuiet: false }));
    // Every row where its names are set (a loop's first row can come before them).
    const rows = loop.querySelectorAll(".loop-row").length;
    const bands = loop.querySelectorAll(".window-band").length;
    expect(bands).toBeGreaterThanOrEqual(rows - 1);
    expect(bands).toBeLessThanOrEqual(rows);
  });
});
