/**
 * The loop history's scene: what the loop view shows about a loop's passes,
 * before anything is drawn. Valid for any renderer.
 */
import { describe, expect, it } from "vitest";
import { liveRows } from "../app/loopController";
import { traceJavaScript } from "../js/trace";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory, type LoopHistory } from "../trace/loopHistory";
import { SIZE_MODELS } from "../trace/memory";
import type { Trace } from "../trace/types";
import { type LoopSceneOptions, loopScene } from "./loopScene";

/** The scene of the loop running at a step (the last step inside a loop, by default). */
async function sceneOf(
  code: string,
  options: Partial<LoopSceneOptions> = {},
  pick: (t: Trace) => number = (t) => lastInLoop(t),
  nested = false,
) {
  const trace = applyHints(await traceJavaScript(code, 5000));
  const at = pick(trace);
  const history = (nested ? buildNestedHistory(trace, at) : buildLoopHistory(trace, at, null)) as LoopHistory;
  return { trace, history, at, scene: loopScene(trace, history, { hideQuiet: false, ...options }) };
}

/** The last step inside a loop (or with `n` loops running). */
const lastInLoop = (t: Trace, n = 1) => {
  for (let i = t.steps.length - 1; i >= 0; i--) if (t.steps[i].loops.length >= n) return i;
  return -1;
};

const kinds = (scene: { items: { kind: string }[] }) => scene.items.map((i) => i.kind);

describe("what to show", () => {
  it("containers that change or are indexed, and the scalars that change or index them", async () => {
    const { scene } = await sceneOf(`const nums = [3, 1, 2];
const fixed = { a: 1 };
const out = [];
let label = "x";
for (let i = 0; i < nums.length; i++) {
  out.push(nums[i] * 2);
}
`);
    expect(scene.containers).toEqual(["nums", "out"]); // nums is indexed; fixed never changes
    expect(scene.scalars).toEqual(["i"]); // label never changes
    expect(scene.hasContent).toBe(true);
  });

  it("a hinted variable is always shown", async () => {
    const { scene } = await sceneOf(`// viz: show fixed
const fixed = { a: 1 };
let t = 0;
for (let i = 0; i < 3; i++) t += i;
`);
    expect(scene.containers).toContain("fixed");
  });

  it("a list of lists is a grid", async () => {
    const { scene } = await sceneOf(`const grid = [[0, 0], [0, 0]];
for (let r = 0; r < 2; r++) grid[r][r] = 1;
`);
    expect([...scene.grids]).toEqual(["grid"]);
  });
});

describe("rows, bands, gaps and headers", () => {
  const quiet = `const a = [0, 0, 0, 0, 0, 0];
for (let i = 0; i < 6; i++) {
  if (i === 4) a[i] = 1;
}
`;

  it("passes that change nothing collapse into one band when asked, in a loop that changes data", async () => {
    const shown = await sceneOf(quiet);
    const collapsed = await sceneOf(quiet, { hideQuiet: true });
    expect(kinds(shown.scene).filter((k) => k === "row")).toHaveLength(shown.scene.rows.length);
    expect(kinds(collapsed.scene)).toContain("band");
    expect(collapsed.scene.changed.filter(Boolean).length).toBeLessThan(collapsed.scene.rows.length);
  });

  it("a read-only loop keeps every row: its moving index is the story", async () => {
    const { scene } = await sceneOf(
      `const a = [1, 2, 3];\nlet found = -1;\nfor (let i = 0; i < 3; i++) {\n  if (a[i] === 9) found = i;\n}\n`,
      { hideQuiet: true },
    );
    expect(kinds(scene)).not.toContain("band");
  });

  it("a sampled loop shows a gap where passes weren't recorded", async () => {
    const { scene } = await sceneOf(`let t = 0;\nfor (let i = 0; i < 3000; i++) {\n  t += i;\n}\n`);
    expect(kinds(scene)).toContain("gap");
  });

  it("a run's header has its values, and every row its header line", async () => {
    const { scene } = await sceneOf(`let t = 0;\nfor (let j = 0; j < 3; j++) {\n  t += j;\n}\n`);
    expect(scene.items[0]).toMatchObject({ kind: "header", call: "j = 0; j < 3; j++" });
    expect(scene.header(scene.rows[1])).toBe("for (let j = 0; j < 3; j++)  →  for (j = 0; j < 3; j++)");
    expect(scene.info()?.line).toBe(2);
  });

  it("a very long history leaves out its first rows", async () => {
    const { scene } = await sceneOf(`const a = [];\nfor (let i = 0; i < 150; i++) a.push(i);\n`, {}, (t) =>
      lastInLoop(t),
    );
    expect(scene.items.filter((i) => i.kind === "row")).toHaveLength(120);
    expect(scene.hiddenRows).toBe(scene.rows.length - 120);
  });
});

describe("labels", () => {
  it('"before", then each pass by number; with every loop together, the loop\'s variable and its depth', async () => {
    const code = `const g = [[0, 0], [0, 0]];
for (let i = 0; i < 2; i++) {
  for (let j = 0; j < 2; j++) {
    g[i][j] = i + j;
  }
}
`;
    const single = (await sceneOf(code)).scene;
    expect(single.label(single.rows[0])).toBe("before");
    expect(single.label(single.rows[1])).toBe("#1");
    expect(single.depth(single.rows[1])).toBe(0);
    const together = (await sceneOf(code, {}, (t) => lastInLoop(t, 2), true)).scene;
    const inner = together.rows.find((r) => (r.depth ?? 0) > 0)!;
    expect(together.label(inner)).toMatch(/^j #\d$/);
    expect(together.depth(inner)).toBe(1);
  });

  it("the running row is the last one, or in animated mode the live one", async () => {
    const { scene, trace, history, at } = await sceneOf(
      `const a = [0, 0];\nfor (let i = 0; i < 2; i++) a[i] = 1;\nlet done = 1;\n`,
      {},
      (t) => t.steps.findIndex((s) => s.loops.some((c) => c.iteration === 2)),
    );
    expect(scene.isCurrent(scene.rows.length - 1)).toBe(history.running);
    expect(scene.isCurrent(0)).toBe(false);
    const live = loopScene(trace, history, { hideQuiet: false, live: liveRows(trace, at, history) });
    expect(live.items).toEqual([{ kind: "row", row: live.live!.current, index: live.all.length - 1 }]);
    expect(live.before?.row).toBe(live.live!.prev);
    expect(live.isCurrent(0)).toBe(true);
  });
});

describe("graphs, linked structures, pointers and sizes", () => {
  it("a graph in view is in every row, and its container isn't repeated as cells", async () => {
    const { scene } = await sceneOf(`const g = { a: ["b"], b: [] };
const seen = [];
for (const node of ["a", "b"]) seen.push(node);
`);
    expect(scene.graph?.rows.every(Boolean)).toBe(true);
    expect(scene.containers).not.toContain("g");
  });

  it("a linked list is a track, with its separate lists as chains", async () => {
    const { scene } = await sceneOf(`class N { constructor(v) { this.v = v; this.next = null; } }
const a = new N(1), b = new N(2), c = new N(3);
let head = a;
for (const n of [b, c]) { head.next = n; head = n; }
`);
    expect(scene.track?.track.shape).toBe("list");
    expect(scene.track?.rows).toHaveLength(scene.all.length);
    expect(scene.track?.chains().flat().sort()).toEqual([...scene.track!.track.order].sort());
  });

  it("pointers come from the row's own variables, and sizes from its own step", async () => {
    const { scene } = await sceneOf(`const nums = [5, 6, 7];\nfor (let i = 0; i < 3; i++) nums[i] += 1;\n`, {
      sizes: SIZE_MODELS.javascript[0].value,
    });
    const row = scene.rows[2];
    expect(scene.pointers(row, "nums")).toEqual([{ name: "i", index: 1, changed: false }]);
    expect(scene.sizes(row)).not.toBeNull();
    expect((await sceneOf("const a = [1];\nfor (let i = 0; i < 2; i++) a.push(i);\n")).scene.sizes(row)).toBeNull();
  });

  it("the grid cell a row's step reads", async () => {
    const { scene } = await sceneOf(`const g = [[1, 2], [3, 4]];
let s = 0;
for (let r = 0; r < 2; r++) {
  s += g[r][1];
}
`);
    const row = scene.rows[2];
    expect(scene.gridFocus(row, "g", { rows: 2, cols: () => 2 })).toMatchObject({ row: 1, col: 1 });
  });
});
