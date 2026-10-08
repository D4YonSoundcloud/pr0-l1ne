import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { computeLayout, findGraphs, graphOverlay, layoutFor, primNodeKey, stepScopes } from "./graph";
import { applyHints, parseHints } from "./hints";
import type { Trace } from "./types";

const js = async (code: string) => applyHints(await traceJavaScript(code));

function py(code: string): Trace | null {
  try {
    const json = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read(), 3000))"],
      { input: code, encoding: "utf8" });
    return applyHints(JSON.parse(json) as Trace);
  } catch {
    return null;
  }
}

const last = (t: Trace) => t.steps[t.steps.length - 1];
const graphsAtEnd = (t: Trace) => findGraphs(t, stepScopes(last(t)), last(t).heap);
const labels = (keys: Iterable<string>) => [...keys].map((k) => k.slice(2)).sort();

describe("node keys", () => {
  it("treats a dict key and a list item naming the same node as equal", () => {
    expect(primNodeKey({ kind: "prim", type: "key", repr: "A" })).toBe(primNodeKey({ kind: "prim", type: "string", repr: '"A"' }));
    expect(primNodeKey({ kind: "prim", type: "key", repr: "3" })).toBe(primNodeKey({ kind: "prim", type: "number", repr: "3" }));
    expect(primNodeKey({ kind: "prim", type: "str", repr: "'A'" })).toBe("s:A");
    expect(primNodeKey({ kind: "prim", type: "bool", repr: "True" })).toBeNull();
  });
});

describe("finding graphs", () => {
  it("finds an adjacency object, and knows it's undirected when every edge goes both ways", async () => {
    const t = await js(`const graph = { A: ["B", "C"], B: ["A"], C: ["A"] };`);
    const [g] = graphsAtEnd(t);
    expect(g).toMatchObject({ name: "graph", kind: "adjacency", directed: false });
    expect(labels(g.nodes.keys())).toEqual(["A", "B", "C"]);
  });

  it("finds a directed, weighted Map", async () => {
    const t = await js(`const g = new Map([["a", new Map([["b", 4]])], ["b", new Map([["c", 1]])], ["c", new Map()]]);`);
    const [graph] = graphsAtEnd(t);
    expect(graph.directed).toBe(true);
    expect(graph.edges).toContainEqual({ from: "s:a", to: "s:b", label: "4" });
  });

  it("doesn't mistake an ordinary dict of lists for a graph", async () => {
    const t = await js(`const groups = { fruit: ["apple", "pear"], veg: ["leek"] };`);
    expect(graphsAtEnd(t)).toEqual([]);
  });

  it("reads lists of lists only when a hint asks: by index, a matrix, or an edge list", async () => {
    const adj = await js(`// viz: graph adj\nconst adj = [[1, 2], [0], [0]];`);
    expect(graphsAtEnd(adj)[0]).toMatchObject({ kind: "adjacency", directed: false });
    const m = await js(`// viz: graph m\nconst m = [[0, 5, 0], [0, 0, 2], [0, 0, 0]];`);
    expect(graphsAtEnd(m)[0]).toMatchObject({ kind: "matrix", directed: true });
    expect(graphsAtEnd(m)[0].edges).toContainEqual({ from: "n:0", to: "n:1", label: "5" });
    const e = await js(`// viz: graph edges edgelist\nconst edges = [[0, 1], [1, 2]];`);
    expect(graphsAtEnd(e)[0]).toMatchObject({ kind: "edgelist" });
    expect(graphsAtEnd(await js(`const adj = [[1], [0]];`))).toEqual([]); // no hint: it's a grid
  });

  it("finds objects that hold lists of each other, and dict links with their keys", async () => {
    const t = await js(`
class Trie { constructor() { this.children = {}; this.end = false; } }
const root = new Trie();
root.children.a = new Trie();
root.children.a.children.t = new Trie();
root.children.a.children.t.end = true;`);
    const [g] = graphsAtEnd(t);
    expect(g).toMatchObject({ kind: "objects", name: "Trie", directed: true, objectNodes: true });
    expect(g.edges.map((e) => e.label)).toEqual(["a", "t"]);
    expect([...g.flags.values()]).toEqual([["end"]]);
  });

  it("finds a graph inside an object (this.adj)", async () => {
    const t = await js(`
class Graph { constructor() { this.adj = {}; } add(a, b) { (this.adj[a] ??= []).push(b); (this.adj[b] ??= []).push(a); } }
const g = new Graph();
g.add(1, 2); g.add(2, 3);`);
    expect(graphsAtEnd(t)[0]).toMatchObject({ name: "g.adj", directed: false });
  });

  it("can be told not to draw a graph", async () => {
    const t = await js(`// viz: plain graph\nconst graph = { A: ["B"], B: ["A"] };`);
    expect(graphsAtEnd(t)).toEqual([]);
  });
});

describe("reading the algorithm's state", () => {
  it("shows BFS: visited set, queue order, distances, parents and the current node", async () => {
    const t = await js(`
const graph = { A: ["B", "C"], B: ["A", "D"], C: ["A", "D"], D: ["B", "C"] };
const visited = new Set(["A", "B"]);
const queue = ["C", "D"];
const dist = { A: 0, B: 1 };
const parent = { B: "A" };
const node = "B";`);
    const [g] = graphsAtEnd(t);
    const o = graphOverlay(t, g, stepScopes(last(t)), last(t).heap);
    expect(labels(o.visited.keys())).toEqual(["A", "B"]);
    expect([...o.frontier]).toEqual([["s:C", 0], ["s:D", 1]]);
    expect(o.labels.get("s:B")).toBe("1");
    expect([...o.treeEdges]).toEqual(["s:A>s:B"]);
    expect(o.pointers.get("s:B")).toEqual(["node"]);
  });

  it("numbers a stack from its top and a heap by priority", async () => {
    const t = await js(`
const graph = { a: ["b"], b: ["c"], c: ["a"] };
const stack = ["a", "b"];`);
    const [g] = graphsAtEnd(t);
    expect(Object.fromEntries(graphOverlay(t, g, stepScopes(last(t)), last(t).heap).frontier)).toEqual({ "s:b": 0, "s:a": 1 });
    const h = await js(`
const graph = { a: ["b"], b: ["c"], c: ["a"] };
const heap = [[5, "a"], [1, "c"]];`);
    const [g2] = graphsAtEnd(h);
    expect(Object.fromEntries(graphOverlay(h, g2, stepScopes(last(h)), last(h).heap).frontier)).toEqual({ "s:c": 0, "s:a": 1 });
  });

  it("reads per-node arrays for graphs numbered 0..n-1", async () => {
    const t = await js(`
// viz: graph adj
const adj = [[1], [2], []];
const visited = [true, true, false];
const dist = [0, 1, Infinity];
const parent = [-1, 0, -1];`);
    const [g] = graphsAtEnd(t);
    const o = graphOverlay(t, g, stepScopes(last(t)), last(t).heap);
    expect(labels(o.visited.keys())).toEqual(["0", "1"]);
    expect(o.labels.get("n:2")).toBe("Infinity");
    expect([...o.treeEdges]).toEqual(["n:0>n:1"]);
  });

  it("highlights a path list", async () => {
    const t = await js(`const graph = { a: ["b"], b: ["c"], c: [] };\nconst path = ["a", "b", "c"];`);
    const [g] = graphsAtEnd(t);
    expect([...graphOverlay(t, g, stepScopes(last(t)), last(t).heap).pathEdges]).toEqual(["s:a>s:b", "s:b>s:c"]);
  });

  it("works the same in Python, including deques and heap tuples", () => {
    const t = py(`from collections import deque
graph = {"A": ["B"], "B": ["A", "C"], "C": ["B"]}
seen = {"A"}
q = deque(["B"])
pq = [(3, "C")]
u = "A"
`);
    if (!t) return;
    const [g] = graphsAtEnd(t);
    const o = graphOverlay(t, g, stepScopes(last(t)), last(t).heap);
    expect(labels(o.visited.keys())).toEqual(["A"]);
    expect(o.frontierName).toBe("q");
    expect(o.pointers.get("s:A")).toEqual(["u"]);
  });
});

describe("layout", () => {
  it("puts a tree in layers, parents above children", () => {
    const edges = [{ from: "r", to: "a" }, { from: "r", to: "b" }, { from: "a", to: "c" }];
    const { pos, mode } = computeLayout(["r", "a", "b", "c"], edges, true);
    expect(mode).toBe("layered");
    expect(pos.get("r")!.y).toBe(0);
    expect(pos.get("c")!.y).toBe(2);
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
  });

  it("spreads a cyclic graph out without overlaps, the same way every time", () => {
    const nodes = ["a", "b", "c", "d", "e"];
    const edges = nodes.map((n, i) => ({ from: n, to: nodes[(i + 1) % 5] }));
    const one = computeLayout(nodes, edges, true);
    const two = computeLayout(nodes, edges, true);
    expect(one.mode).toBe("force");
    expect([...one.pos]).toEqual([...two.pos]);
    const points = [...one.pos.values()];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThanOrEqual(0.85);
      }
    }
  });

  it("keeps nodes in place while the graph is built", async () => {
    const t = await js(`
const graph = {};
for (const [a, b] of [["A", "B"], ["B", "C"], ["C", "A"]]) {
  (graph[a] ??= []).push(b);
  (graph[b] ??= []).push(a);
}`);
    const early = t.steps.map((step) => findGraphs(t, stepScopes(step), step.heap)[0]).find(Boolean)!;
    const final = graphsAtEnd(t)[0];
    expect(layoutFor(t, early)).toBe(layoutFor(t, final));
  });
});

describe("graph hints", () => {
  it("parses targets, fields, options and names", () => {
    const h = parseHints([
      { line: 1, text: "graph adj directed layered: seen, queue" },
      { line: 2, text: "graph Node(neighbors)" },
      { line: 3, text: "plain grid, self.adj" },
    ]);
    expect(h.graphs).toEqual([
      { target: "adj", options: ["directed", "layered"], names: ["seen", "queue"], line: 1 },
      { target: "Node", fields: ["neighbors"], options: [], names: [], line: 2 },
    ]);
    expect(h.plain).toEqual(["grid", "self.adj"]);
    expect(h.warnings).toEqual([]);
  });

  it("explains a bad option", () => {
    const h = parseHints([{ line: 4, text: "graph adj sideways" }]);
    expect(h.warnings[0]).toMatchObject({ line: 4 });
    expect(h.warnings[0].message).toContain("Unknown graph option");
  });
});
