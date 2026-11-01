/**
 * Summaries (summaries.ts): long chains, big trees and deep recursion
 * drawn in part, around whatever the program holds; expanded by key; and
 * never at all in the examples at full detail.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { memoryDrawing } from "../render/memory";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { fieldsOf } from "../trace/linked";
import { liveFrames, type Trace } from "../trace/types";
import { memoryScene } from "./memoryScene";
import { detailBudget, SUMMARY_PREFIX, summarize, summaryBoxes, summaryOf } from "./summaries";

const trace = async (code: string) => applyHints(await traceJavaScript(code, 5000));
const lastStep = (t: Trace) => t.steps.length - 1;
const at = (t: Trace, line: number) => {
  for (let i = t.steps.length - 1; i >= 0; i--) if (t.steps[i].line === line) return i;
  return -1;
};
const linkOf = (t: { heap: Record<string, unknown> }, id: string, link: string) => {
  const v = fieldsOf((t.heap as never)[id])?.find(([n]) => n === link)?.[1];
  return v?.kind === "ref" ? v.id : null;
};
const detail = (budget: number, expanded: string[] = []) => ({ budget, expanded: new Set(expanded) });

const LIST = `class Node { constructor(val, next) { this.val = val; this.next = next; } }
let head = null;
for (let i = 200; i > 0; i--) head = new Node(i, head);
let cur = head;
for (let k = 0; k < 100; k++) cur = cur.next;
let done = 1;
`;

describe("summaries: a long linked list", () => {
  it("keeps its first nodes, the cursor and around it, and its last, with a summary between each", async () => {
    const t = await trace(LIST);
    const i = at(t, 6);
    const { step, summaries } = summarize(t, t.steps[i], detail(16));
    const chains = [...summaries.values()].filter((s) => s.kind === "chain");
    expect(chains.length).toBe(2); // head … cursor, cursor … tail
    // Every node drawn is reachable along `next` from head, through summaries, ending at the tail.
    const headId = (liveFrames(step)[0].locals.find(([n]) => n === "head")![1] as { id: string }).id;
    const curId = (liveFrames(step)[0].locals.find(([n]) => n === "cur")![1] as { id: string }).id;
    const walk: string[] = [];
    for (let id: string | null = headId; id; id = linkOf(step, id, "next")) walk.push(id);
    const hidden = chains.reduce((n, s) => n + s.count, 0);
    expect(walk.filter((id) => !id.startsWith(SUMMARY_PREFIX)).length + hidden).toBe(200);
    expect(walk).toContain(curId);
    expect(walk.filter((id) => id.startsWith(SUMMARY_PREFIX))).toHaveLength(2);
    for (const id of walk.filter((x) => x.startsWith(SUMMARY_PREFIX))) {
      const obj = step.heap[id];
      expect(summaryOf(obj)?.kind).toBe("chain");
      expect(obj.typeName).toBe("Node");
    }
    // The trace's own step is untouched.
    expect(Object.keys(t.steps[i].heap).some((id) => id.startsWith(SUMMARY_PREFIX))).toBe(false);
  });

  it("keeps the same key while it's the same chain, and draws it all once expanded", async () => {
    const t = await trace(LIST);
    const a = summarize(t, t.steps[at(t, 6)], detail(16));
    const b = summarize(t, t.steps[lastStep(t)], detail(16));
    const keys = (s: typeof a) => [...new Set([...s.summaries.values()].map((x) => x.key))];
    expect(keys(a)).toEqual(keys(b));
    const open = summarize(t, t.steps[at(t, 6)], detail(16, keys(a)));
    expect(open.summaries.size).toBe(0);
  });

  it("draws more as the budget grows, and nothing summarized under it", async () => {
    const t = await trace(LIST);
    const step = t.steps[at(t, 6)];
    const count = (budget: number) => Object.keys(summarize(t, step, detail(budget)).step.heap).length;
    expect(count(8)).toBeLessThan(count(32));
    expect(count(32)).toBeLessThan(count(64));
    expect(summarize(t, step, detail(500)).summaries.size).toBe(0);
    expect(summarize(t, step, undefined).step).toBe(step);
  });

  it("summarizes a doubly linked list too, its back links pointing at the summary", async () => {
    const t = await trace(`class Node { constructor(v) { this.v = v; this.next = null; this.prev = null; } }
let head = new Node(0), tail = head;
for (let i = 1; i < 120; i++) { const n = new Node(i); n.prev = tail; tail.next = n; tail = n; }
let done = 1;
`);
    const { step, summaries } = summarize(t, t.steps[lastStep(t)], detail(16));
    expect(summaries.size).toBe(1);
    const [id] = summaries.keys();
    const pointingIn = Object.values(step.heap).filter((o) =>
      fieldsOf(o)?.some(([, v]) => v.kind === "ref" && v.id === id),
    );
    expect(pointingIn.length).toBe(2); // next from before it, prev from after it
  });
});

describe("summaries: a big tree", () => {
  const TREE = `class T { constructor(v) { this.v = v; this.left = null; this.right = null; } }
function build(lo, hi) { if (lo > hi) return null; const m = (lo + hi) >> 1; const t = new T(m); t.left = build(lo, m - 1); t.right = build(m + 1, hi); return t; }
const root = build(1, 255);
let node = root;
while (node.left) node = node.left;
let done = 1;
`;
  it("keeps the levels that fit, each subtree below as one leaf with its count, and the path to what's held", async () => {
    const t = await trace(TREE);
    const { step, summaries } = summarize(t, t.steps[lastStep(t)], detail(16));
    const trees = [...summaries.values()].filter((s) => s.kind === "tree");
    expect(trees.length).toBeGreaterThan(1);
    const shown = Object.values(step.heap).filter((o) => o.typeName === "T" && !summaryOf(o)).length;
    expect(shown + trees.reduce((n, s) => n + s.count, 0)).toBe(255);
    // `node` (the leftmost leaf, at the bottom) is still drawn, and the path to it.
    const nodeId = (liveFrames(step)[0].locals.find(([n]) => n === "node")![1] as { id: string }).id;
    expect(step.heap[nodeId]).toBeDefined();
    // Leaves are of the tree's class with no links, so the tree's layout places them as leaves.
    for (const id of summaries.keys()) {
      expect(fieldsOf(step.heap[id])?.every(([, v]) => v.kind === "prim")).toBe(true);
    }
  });
});

describe("summaries: deep recursion", () => {
  const DEEP = `function down(n) { if (n === 0) return 0; return 1 + down(n - 1); }
down(120);
`;
  it("keeps the outermost and innermost calls and one frame for the rest, with a key that stays", async () => {
    const t = await trace(DEEP);
    let deepest = 0;
    t.steps.forEach((s, i) => {
      if (s.stack.length > t.steps[deepest].stack.length) deepest = i;
    });
    const { step, summaries, stackIndex } = summarize(t, t.steps[deepest], detail(16));
    const frames = [...summaries.values()].filter((s) => s.kind === "frames");
    expect(frames).toHaveLength(1);
    expect(step.stack.length).toBe(1 + 16 + 1); // Global, 16 calls kept, one summary
    expect(frames[0].count).toBe(t.steps[deepest].stack.length - 1 - 16);
    expect(step.stack.at(-1)).toBe(t.steps[deepest].stack.at(-1)); // the running call is kept
    // Kept frames keep their place on the real stack (their boxes' keys).
    expect(stackIndex.get(step.stack.at(-1)!)).toBe(t.steps[deepest].stack.length - 1);
    const later = summarize(t, t.steps[deepest - 3], detail(16));
    expect([...later.summaries.values()].map((s) => s.key)).toEqual(frames.map((s) => s.key));
  });

  it("draws the summary frame and marks it to open", async () => {
    const t = await trace(DEEP);
    let deepest = 0;
    t.steps.forEach((s, i) => {
      if (s.stack.length > t.steps[deepest].stack.length) deepest = i;
    });
    const scene = memoryScene(t, deepest, diffSteps(t.steps[deepest - 1], t.steps[deepest]), { detail: detail(16) });
    const boxes = summaryBoxes(scene);
    expect(boxes.size).toBe(1);
    const drawing = memoryDrawing(scene);
    const summaryNode = drawing.querySelector(".node.is-summary");
    expect(summaryNode?.getAttribute("data-summary")).toBe([...boxes.values()][0]);
    expect(summaryNode?.getAttribute("data-node-key")).toBe([...boxes.keys()][0]);
  });
});

describe("summaries in the scene and the drawing", () => {
  it("draws summaries in both modes, as boxes that open by their key", async () => {
    const t = await trace(LIST);
    const i = at(t, 6);
    for (const mode of ["arrows", "nested"] as const) {
      const scene = memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { mode, detail: detail(16) });
      const drawing = memoryDrawing(scene);
      if (mode === "arrows") {
        const marked = drawing.querySelectorAll(".node.is-summary");
        expect(marked.length).toBe(2);
        expect(new Set(marked.map((m) => m.getAttribute("data-summary"))).size).toBe(1);
      }
      expect(drawing.signature()).toContain("more Nodes");
    }
  });

  it("never summarizes anything in the examples at full detail", async () => {
    for (const [name, run] of [
      ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 2000)] as const),
      ...TYPESCRIPT_EXAMPLES.map((e) => [e.name, () => traceTypeScript(e.code, 2000)] as const),
    ]) {
      const t = applyHints(await run());
      for (let i = 0; i < t.steps.length; i += 3) {
        expect(summarize(t, t.steps[i], detail(detailBudget(0, false))).summaries.size, `${name}, step ${i}`).toBe(0);
      }
    }
  }, 120_000);

  it("summarizes sooner zoomed out, and as at full detail with Auto-fit on", () => {
    expect(detailBudget(0, false)).toBeGreaterThan(detailBudget(2, false));
    expect(detailBudget(2, false)).toBeGreaterThan(detailBudget(4, false));
    expect(detailBudget(4, true)).toBe(detailBudget(0, false));
  });
});
