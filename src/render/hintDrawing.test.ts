// @vitest-environment jsdom
/**
 * The hints that change what's drawn, drawn: regions and compares on a
 * list, rows labeled by a variable, watches and checks in loop rows, bits,
 * characters, formats and labels in the memory view, heatmaps, tables and
 * intervals, and arrows marked by the kind of link they are or colored as
 * they follow the program.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { setArrowStyle } from "./arrowStyle";
import { renderLoopHistory } from "./loopView";
import { renderMemory } from "./memory";

const example = (start: string) => JAVASCRIPT_EXAMPLES.find((e) => e.name.startsWith(start))!.code;
const memoryAt = (t: Trace, i: number, mode: "arrows" | "nested" = "nested") =>
  renderMemory(memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { mode }));
const loopAt = (t: Trace, i: number) => {
  const history = buildNestedHistory(t, i) ?? buildLoopHistory(t, i, null)!;
  return renderLoopHistory(loopScene(t, history, { hideQuiet: false }));
};
const texts = (root: Element, selector: string) => [...root.querySelectorAll(selector)].map((el) => el.textContent);

describe("region, compare and rows by", () => {
  it("draws labeled regions in their own colors, the compared cells, and rows labeled by i", async () => {
    const t = applyHints(await traceJavaScript(example("13 ·")));
    expect(t.viz?.warnings).toEqual([]);
    // Inside the inner loop, partway through.
    const at = t.steps.findIndex((s, i) => i > 30 && s.line === 15);
    const memory = memoryAt(t, at);
    expect(memory.querySelectorAll(".region-band").length).toBe(2);
    expect(memory.querySelector(".region-band.region-0")).not.toBeNull();
    expect(memory.querySelector(".region-band.region-1")).not.toBeNull();
    expect(texts(memory, ".region-label").join(" ")).toMatch(/sorted|sor…/);
    expect(memory.querySelectorAll(".compare-mark").length).toBe(2);

    const loop = loopAt(t, at);
    expect(texts(loop, ".iteration-label").some((l) => /^i = \d$/.test(l ?? ""))).toBe(true);
    // The inner loop's rows keep their own labels.
    expect(texts(loop, ".iteration-label").some((l) => /^#\d$/.test(l ?? ""))).toBe(true);
    expect(loop.querySelectorAll(".compare-mark").length).toBeGreaterThan(0);
  });
});

describe("watch and check", () => {
  it("shows a watch's value in each row, and turns a row red where a check is false", async () => {
    const good = applyHints(await traceJavaScript(example("14 ·")));
    const last = good.steps.length - 2;
    const loop = loopAt(good, last);
    expect(texts(loop, ".scalars .watch").some((w) => /^total - seen = -?\d+$/.test(w ?? ""))).toBe(true);
    expect(loop.querySelectorAll(".loop-row.is-failing").length).toBe(0);

    const broken = applyHints(
      await traceJavaScript(example("14 ·").replace("if (i > 0) total += nums[i - 1]", "if (i > 0) total += 1")),
    );
    const failing = loopAt(broken, broken.steps.length - 2);
    expect(failing.querySelectorAll(".loop-row.is-failing").length).toBeGreaterThan(0);
    expect(texts(failing, ".check-failed")[0]).toBe("✗ total == sum(nums[0:i])");
    expect(failing.querySelector(".loop-row.is-failing .failing-band")).not.toBeNull();
  });
});

describe("chars, bits, format and label", () => {
  it("draws a string as letters, a number as bits counted from the right, and names boxes by a field", async () => {
    const t = applyHints(await traceJavaScript(example("15 ·")));
    expect(t.viz?.warnings).toEqual([]);
    const svg = memoryAt(t, t.steps.length - 1);
    const seqs = [...svg.querySelectorAll(".seq")];
    const word = seqs.find((g) => texts(g, ".value").join("") === '"l""e""v""e""l"');
    expect(word).toBeDefined();
    const bits = seqs.find((g) => texts(g, ".index").join(",") === "4,3,2,1,0");
    expect(bits).toBeDefined();
    expect(texts(bits!, ".value").join("")).toBe("00011");
    expect(texts(svg, ".value")).toContain("40.0%");
    expect(texts(svg, ".box-title")).toEqual(expect.arrayContaining(["Node 1", "Node 2", "Node 3"]));
  });
});

describe("arrows by kind", () => {
  it("marks each arrow with the kind of link it is, and gives it that kind's arrowhead", async () => {
    const t = applyHints(
      await traceJavaScript(`class Node { constructor(v) { this.v = v; this.next = null; } }
const a = new Node(1);
a.next = new Node(2);
a.next.next = new Node(3);
a.next.next.next = a.next;
const list = [a];`),
    );
    const svg = memoryAt(t, t.steps.length - 1, "arrows");
    const kinds = [...svg.querySelectorAll(".ref-arrow")].map((p) => p.getAttribute("class")!.match(/kind-(\w+)/)?.[1]);
    expect(kinds).toEqual(expect.arrayContaining(["ref", "next", "cycle"]));
    const cycleHead = svg.querySelector(".ref-arrow-part.arrow-head.kind-cycle");
    expect(cycleHead?.getAttribute("marker-end")).toBe("url(#arrow-kind-cycle)");
    expect(svg.querySelector("marker#arrow-kind-cycle")).not.toBeNull();
  });
});

describe("links by kind in the loop history", () => {
  it("calls a reversed list's links next, and only a real loop of links a cycle", async () => {
    const reversed = applyHints(await traceJavaScript(example("Reverse a linked list")));
    const loop = loopAt(reversed, reversed.steps.length - 2);
    expect(loop.querySelectorAll(".link-arrow.kind-next").length).toBeGreaterThan(0);
    expect(loop.querySelectorAll(".link-arrow.kind-cycle").length).toBe(0);

    const cycle = applyHints(await traceJavaScript(example("Find a cycle")));
    const withCycle = loopAt(cycle, cycle.steps.length - 2);
    expect(withCycle.querySelectorAll(".link-arrow.kind-cycle").length).toBeGreaterThan(0);
  });
});

describe("heatmap", () => {
  it("colors a grid's cells by value, and draws the cells a line reads with arrows to the one worked on", async () => {
    const t = applyHints(await traceJavaScript(example("16 ·")));
    expect(t.viz?.warnings).toEqual([]);
    // dp[i][j] = dp[i - 1][j] + dp[i][j - 1] just ran, inside the grid.
    const at = t.steps.findIndex(
      (s, i) =>
        i > 0 && t.steps[i - 1].line === 13 && Number(new Map(s.stack[0].locals).get("i")?.kind === "prim") >= 0,
    );
    expect(at).toBeGreaterThan(0);
    const svg = memoryAt(t, at, "arrows");
    expect(svg.querySelectorAll(".grid .cell.heat").length).toBe(20);
    // The smallest (0) and the largest the run ever holds use the ends of the scale.
    expect(svg.querySelector(".cell.heat-0")).not.toBeNull();
    expect(svg.querySelectorAll(".grid-read")).toHaveLength(2);
    expect(svg.querySelectorAll(".grid-read-arrow")).toHaveLength(2);
    expect(svg.querySelector(".grid-read-arrow")?.getAttribute("marker-end")).toBe("url(#arrow-read)");
    expect(svg.querySelector(".grid-focus")).not.toBeNull();
    // The loop history's grid is colored too.
    expect(loopAt(t, at).querySelectorAll(".cell.heat").length).toBeGreaterThan(0);
  });
});

describe("table and intervals", () => {
  it("draws a list of objects as one table, and pairs as bars along one axis for the run", async () => {
    const t = applyHints(await traceJavaScript(example("17 ·")));
    expect(t.viz?.warnings).toEqual([]);
    const last = t.steps.length - 1;
    for (const mode of ["arrows", "nested"] as const) {
      const svg = memoryAt(t, last, mode);
      const records = svg.querySelector(".records")!;
      expect(records).not.toBeNull();
      expect(texts(records, ".records-head")).toEqual(["name", "age", "team"]);
      // Sorted by age: each row keeps its object's key, so it slides.
      expect(texts(records, ".records-row .v-str").filter((_, i) => i % 2 === 0)).toEqual([
        '"Linus"',
        '"Ada"',
        '"Grace"',
      ]);
      const [meetings, merged] = [...svg.querySelectorAll(".intervals")];
      expect(meetings.querySelectorAll(".interval-bar")).toHaveLength(5);
      expect(texts(merged, ".interval-text")).toEqual(["9–11", "13–16", "17–18"]);
      // One axis for the whole run: 9 is where it starts, in both.
      const left = (g: Element) => Number(g.querySelector(".interval-bar")!.getAttribute("x"));
      expect(left(meetings) - Number(meetings.querySelector(".interval-axis line")!.getAttribute("x1"))).toBe(0);
      expect(left(merged) - Number(merged.querySelector(".interval-axis line")!.getAttribute("x1"))).toBe(0);
      // The objects are drawn inside: no boxes of their own.
      expect(svg.querySelectorAll('.node[data-node-key^="obj:"]').length).toBeLessThanOrEqual(3);
    }
  });
});

describe("arrows colored by variable, with a legend and field names", () => {
  it("colors each chain by its variable, explains the colors, and names fields", async () => {
    const t = applyHints(
      await traceJavaScript(`class Node { constructor(v, next = null) { this.v = v; this.next = next; } }
const a = new Node(1, new Node(2));
const b = new Node(3);`),
    );
    setArrowStyle({ mode: "variable", legend: true, labels: true });
    try {
      const svg = memoryAt(t, t.steps.length - 1, "arrows");
      const groups = [...svg.querySelectorAll(".ref-arrow")].map(
        (p) => p.getAttribute("class")!.match(/group-(\d)/)?.[1] ?? null,
      );
      // The class, a (with its node's next) and b: three colors.
      expect(new Set(groups.filter(Boolean)).size).toBe(3);
      expect(svg.querySelector(".arrow-legend")).not.toBeNull();
      expect(texts(svg, ".legend-text")).toEqual(["Node", "a", "b"]);
      expect(texts(svg, ".arrow-label")).toEqual(["next"]);
      expect(svg.querySelector(".arrow-head.group-0")?.getAttribute("marker-end")).toMatch(/arrow-group-0/);
    } finally {
      setArrowStyle({ mode: "kind", legend: true, labels: false });
    }
    const plain = memoryAt(t, t.steps.length - 1, "arrows");
    expect(plain.querySelector(".arrow-legend")).toBeNull();
    expect(plain.querySelector(".arrow-label")).toBeNull();
  });
});
