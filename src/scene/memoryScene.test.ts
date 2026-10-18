/**
 * The memory scene: what a step shows, before anything is drawn. These tests
 * don't care how a scene is drawn, so they stay valid for any renderer.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { SIZE_MODELS } from "../trace/memory";
import type { Trace } from "../trace/types";
import { boxValues, type MemorySceneOptions, memoryScene, nodeKey } from "./memoryScene";

/** The scene at a step (the last, by default) of a JavaScript program. */
async function sceneOf(code: string, options: MemorySceneOptions = {}, at?: (t: Trace) => number) {
  const trace = applyHints(await traceJavaScript(code));
  const i = at ? at(trace) : trace.steps.length - 1;
  return { trace, scene: memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]), options) };
}

const pairs = (links: { from: string; to: string }[]) => links.map((l) => `${l.from} -> ${l.to}`);

describe("frames", () => {
  it("are the call stack, the running one last, then paused generators, each with a stable key", async () => {
    const { scene } = await sceneOf(
      `function* gen() { yield 1; yield 2; }
const g = gen();
g.next();
function f(n) {
  return n;
}
f(1);
`,
      {},
      (t) => t.steps.findIndex((s) => s.stack.some((fr) => fr.func === "f")),
    );
    expect(scene.frames.map((f) => [f.key, f.active])).toEqual([
      ["frame:0:Global", false],
      ["frame:1:f", true],
      [nodeKey.paused(scene.frames[2].frame.id), false],
    ]);
    expect(scene.frames[1].isNew).toBe(true);
  });
});

describe("objects", () => {
  it("are every object reachable from the stack, with its distance from it", async () => {
    const { scene } = await sceneOf(`const a = { next: { next: { next: null } } };\nconst unused = [1];\n`);
    expect(scene.objects.map((o) => o.depth)).toEqual([0, 0, 1, 2]);
    expect(scene.objects.every((o) => o.key === nodeKey.object(o.id))).toBe(true);
  });

  it("in nested mode, an object only one thing refers to is drawn inside it: no box, no arrow", async () => {
    const code = `const grid = [[1, 2], [3, 4]];\nconst shared = [0];\nconst x = [shared, shared];\n`;
    const arrows = (await sceneOf(code)).scene;
    const nested = (await sceneOf(code, { mode: "nested" })).scene;
    expect(arrows.nested.size).toBe(0);
    expect(arrows.objects).toHaveLength(5); // grid, its two rows, shared, x
    expect(nested.nested.size).toBe(4); // grid, its two rows, and x
    expect(nested.objects.map((o) => o.id)).toEqual(
      [...arrows.objects.map((o) => o.id)].filter((id) => !nested.nested.has(id)),
    );
    // x is drawn inside Global, so its two arrows to shared start there.
    expect(pairs(nested.links)).toEqual([
      "frame:0:Global -> obj:" + nested.objects[0].id,
      "frame:0:Global -> obj:" + nested.objects[0].id,
      "frame:0:Global -> obj:" + nested.objects[0].id,
    ]);
  });
});

describe("links", () => {
  it("are every reference from a box to another box, keys of dicts included", async () => {
    const { scene } = await sceneOf(`const k = [1];\nconst m = new Map([[k, "v"]]);\n`);
    const [list, map] = [
      scene.objects.find((o) => scene.step.heap[o.id].kind === "list")!,
      scene.objects.find((o) => scene.step.heap[o.id].kind === "dict")!,
    ];
    expect(pairs(scene.links).sort()).toEqual(
      [`frame:0:Global -> ${list.key}`, `frame:0:Global -> ${map.key}`, `${map.key} -> ${list.key}`].sort(),
    );
    expect(boxValues(scene, map.key)[0]).toEqual({ kind: "ref", id: list.id });
    expect(boxValues(scene, "nowhere")).toEqual([]);
  });

  it("include what a function is returning", async () => {
    const { scene } = await sceneOf(`function make() {\n  return [1];\n}\nmake();\n`, {}, (t) =>
      t.steps.findIndex((s) => s.event === "return" && s.stack.at(-1)?.func === "make"),
    );
    const list = scene.objects.find((o) => scene.step.heap[o.id].kind === "list")!;
    expect(scene.frames[1].frame.locals).toEqual([]); // nothing but what it returns
    expect(pairs(scene.links)).toContain(`frame:1:make -> ${list.key}`);
  });
});

describe("graphs and trees", () => {
  it("a graph of objects is one box: arrows to any of its nodes go to it", async () => {
    const { scene } = await sceneOf(`class Node {
  constructor(name) { this.name = name; this.neighbors = []; }
}
const a = new Node("a"), b = new Node("b"), c = new Node("c");
a.neighbors.push(b, c); b.neighbors.push(c); c.neighbors.push(a);
`);
    expect(scene.graphs.size).toBe(1);
    const [host] = scene.graphs.keys();
    // One box for the graph (and one for the class Node itself), however many node objects.
    expect(scene.objects.map((o) => scene.step.heap[o.id].kind).sort()).toEqual(["class", "object"]);
    expect(scene.objects.map((o) => o.id)).toContain(host);
    expect(pairs(scene.links).filter((l) => l.endsWith(`obj:${host}`))).toEqual([
      "frame:0:Global -> obj:" + host,
      "frame:0:Global -> obj:" + host,
      "frame:0:Global -> obj:" + host,
    ]);
    expect([...scene.graphAlias.values()].every((id) => id === host)).toBe(true);
  });

  it("a graph knows itself at the step before, for animating what changed", async () => {
    const code = `const g = { a: ["b"], b: ["a"] };\ng.a.push("c");\ng.c = [];\n`;
    const first = (await sceneOf(code, {}, (t) => t.steps.findIndex((s) => Object.keys(s.heap).length > 0))).scene;
    const last = (await sceneOf(code)).scene;
    expect([...first.graphs.values()][0]?.previous ?? null).toBeNull();
    expect([...last.graphs.values()][0].previous).not.toBeNull();
  });

  it("a binary tree is one block, in order, with each node's depth (not in nested mode)", async () => {
    const code = `class T {
  constructor(v, l = null, r = null) { this.v = v; this.left = l; this.right = r; }
}
const root = new T(2, new T(1), new T(3));
`;
    const { scene } = await sceneOf(code);
    expect(scene.trees).toHaveLength(1);
    const [tree] = scene.trees;
    expect(
      tree.inOrder.map((id) => (scene.step.heap[id] as { fields: [string, { repr: string }][] }).fields[0][1].repr),
    ).toEqual(["1", "2", "3"]);
    expect([...tree.nodes.values()].map((n) => n.depth).sort()).toEqual([0, 1, 1]);
    expect(new Set(scene.objects.filter((o) => tree.nodes.has(o.id)).map((o) => o.depth))).toEqual(new Set([0]));
    expect((await sceneOf(code, { mode: "nested" })).scene.trees).toEqual([]);
  });
});

describe("pointers and grid focus", () => {
  it("a list's index variables, from the frame that holds it, the running one first", async () => {
    const { scene } = await sceneOf(`const nums = [5, 6, 7];\nlet i = 1;\nnums[i];\nlet lo = 0;\n`);
    const list = scene.objects[0].id;
    expect(scene.pointers(list).map((p) => [p.name, p.index])).toEqual([
      ["i", 1],
      ["lo", 0],
    ]);
    expect(scene.pointers("o999")).toEqual([]);
    expect(scene.gridFocus("o999", { rows: 1, cols: () => 1 })).toBeNull();
  });

  it("the grid cell a step reads", async () => {
    const { scene } = await sceneOf(
      `const grid = [[1, 2], [3, 4]];\nlet r = 1, c = 0;\nconst x = grid[r][c];\n`,
      {},
      (t) => t.steps.findIndex((s) => s.line === 3),
    );
    const grid = scene.objects[0].id;
    expect(scene.gridFocus(grid, { rows: 2, cols: () => 2 })).toMatchObject({ row: 1, col: 0 });
    expect(scene.pointers(grid, 1).map((p) => p.name)).toEqual(["c"]);
  });
});

describe("output", () => {
  const code = `const a = [1];\nconsole.log(a, a);\nlet b = 2;\n`;
  const printing = (t: Trace) => t.steps.findIndex((s) => s.output);

  it("is what the step printed, with an arrow to each object it printed, once", async () => {
    const { scene } = await sceneOf(code, {}, printing);
    expect(scene.output?.printed.line).toBe(2);
    expect(scene.output?.targets).toEqual([scene.objects[0].id]);
    expect(scene.links.filter((l) => l.printed)).toEqual([{ from: "output", to: scene.objects[0].key, printed: true }]);
    expect(scene.longestOutputLine).toBeGreaterThan(0);
  });

  it("can be turned off", async () => {
    const { scene } = await sceneOf(code, { output: false }, printing);
    expect(scene.output).toBeNull();
    expect(scene.longestOutputLine).toBeNull();
    expect(scene.links.some((l) => l.printed)).toBe(false);
  });

  it("dims the rest while it's shown: in on the step that prints, out on the step after", async () => {
    const at = async (offset: number) =>
      (await sceneOf(code, { dimForOutput: true }, (t) => printing(t) + offset)).scene.dim;
    expect(await at(0)).toEqual({ on: true, entering: true, leaving: false });
    expect(await at(1)).toEqual({ on: false, entering: false, leaving: true });
    expect((await sceneOf(code, {}, printing)).scene.dim).toEqual({ on: false, entering: false, leaving: false });
  });

  it("a program that never prints has no output column", async () => {
    expect((await sceneOf("let a = 1;\n")).scene.longestOutputLine).toBeNull();
  });
});

describe("what changed, and sizes", () => {
  it("carries the step's changes, and sizes only when asked", async () => {
    const { scene } = await sceneOf(`const a = [1];\na.push(2);\n`);
    expect(scene.changes.changedSlots.size).toBeGreaterThan(0);
    expect(scene.sizes).toBeNull();
    const sized = (await sceneOf(`const a = [1];\n`, { sizes: SIZE_MODELS.javascript[0].value })).scene;
    expect(sized.sizes?.own(sized.objects[0].id)).toBeGreaterThan(0);
    expect(sized.functionKeyword).toBe("function");
    expect(sized.mode).toBe("arrows");
  });
});
