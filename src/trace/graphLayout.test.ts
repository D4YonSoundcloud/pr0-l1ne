import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { legacyForce, legacyLayered } from "../testing/legacyGraphLayout";
import { findGraphs, type GraphEdge, layoutFor, stepScopes } from "./graph";
import { computeLayout, edgeCrossings, type GraphLayout, placeInOrder, ringOrder } from "./graphLayout";
import { applyHints } from "./hints";
import type { Trace } from "./types";

const e = (spec: string) =>
  spec
    .split(" ")
    .filter(Boolean)
    .map((pair) => {
      const [from, to] = pair.split(">");
      return { from, to };
    });
const nodesOf = (edges: { from: string; to: string }[], extra: string[] = []) => [
  ...new Set([...edges.flatMap((x) => [x.from, x.to]), ...extra]),
];

/** Nothing overlaps: nodes in a layer at least a node apart, bends clear of nodes. */
function expectTidy(layout: GraphLayout): void {
  const points = [...layout.pos.entries()];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const [a, b] = [points[i][1], points[j][1]];
      if (layout.mode === "layered" && a.y !== b.y) continue;
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${points[i][0]} and ${points[j][0]}`).toBeGreaterThanOrEqual(0.85);
    }
  }
  for (const [key, bends] of layout.mode === "layered" ? layout.routes : []) {
    for (const bend of bends) {
      for (const [node, p] of points) {
        if (p.y === bend.y) expect(Math.abs(p.x - bend.x), `${key} by ${node}`).toBeGreaterThanOrEqual(0.7);
      }
    }
  }
  for (const p of layout.pos.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
}

describe("layered layout", () => {
  it("puts the start on top of a directed graph with cycles, and points the edges that close them up", () => {
    // BFS on a directed graph: S -> A -> B -> S closes a cycle.
    const edges = e("S>A A>B B>S A>C C>D D>A");
    const layout = computeLayout(nodesOf(edges), edges, { directed: true, start: "S" });
    expect(layout.mode).toBe("layered");
    expect(layout.pos.get("S")!.y).toBe(0);
    expect([...layout.back].sort()).toEqual(["B>S", "D>A"]);
    for (const key of layout.back) {
      const [from, to] = key.split(">");
      expect(layout.pos.get(from)!.y).toBeGreaterThan(layout.pos.get(to)!.y);
    }
    expectTidy(layout);
  });

  it("starts the walk where the algorithm does, so a different start turns different edges", () => {
    const edges = e("A>B B>C C>A");
    const fromB = computeLayout(["A", "B", "C", "D"], [...edges, ...e("D>A")], { directed: true, start: "B" });
    expect(fromB.pos.get("B")!.y).toBe(0);
    expect([...fromB.back]).toEqual(["A>B"]);
  });

  it("bends a long edge around the nodes between", () => {
    // A -> B -> C -> D, and A -> D skips two layers.
    const edges = e("A>B B>C C>D A>D");
    const layout = computeLayout(nodesOf(edges), edges, { directed: true });
    expect(layout.routes.get("A>D")).toHaveLength(2);
    expect(layout.routes.get("D>A")).toEqual([...layout.routes.get("A>D")!].reverse());
    expectTidy(layout);
  });

  it("removes crossings by reordering layers", () => {
    // In first-seen order, a->d and b->c cross; reordered, nothing does.
    const edges = e("r>a r>b a>d b>c c>x d>x");
    const layout = computeLayout(nodesOf(edges), edges, { directed: true });
    expect(edgeCrossings(layout, edges)).toBe(0);
  });

  it("keeps a tree's children in program order, left to right", () => {
    const edges = e("root>right root>left right>r1 left>l1");
    const layout = computeLayout(nodesOf(edges), edges, { directed: true });
    expect(layout.pos.get("right")!.x).toBeLessThan(layout.pos.get("left")!.x);
    expect(layout.pos.get("r1")!.x).toBeLessThan(layout.pos.get("l1")!.x);
    expect(layout.back.size).toBe(0);
  });

  it("treats a self-loop, a repeated edge and a two-way pair as one connection", () => {
    const edges = [...e("A>A A>B A>B B>A B>C"), { from: "A", to: "B" }];
    const layout = computeLayout(nodesOf(edges), edges, { directed: true, start: "A" });
    expect(layout.mode).toBe("layered");
    expect(layout.pos.get("A")!.y).toBe(0);
    expect(layout.pos.get("B")!.y).toBe(1);
    expect(layout.pos.get("C")!.y).toBe(2);
    expectTidy(layout);
  });

  it("puts separate pieces side by side, the start's first, and lone nodes in a block on the right", () => {
    const edges = e("a>b c>d d>e");
    const layout = computeLayout(nodesOf(edges, ["x", "y", "z"]), edges, { directed: true, start: "c" });
    const right = (n: string) => layout.pos.get(n)!.x;
    expect(right("c")).toBeLessThan(right("a"));
    expect(Math.min(right("x"), right("y"), right("z"))).toBeGreaterThan(right("a"));
    expect(Math.max(...["x", "y", "z"].map((n) => layout.pos.get(n)!.y))).toBeLessThanOrEqual(2);
    expectTidy(layout);
  });

  it("layers an undirected tree from the start, and leaves an undirected graph with cycles to force", () => {
    const tree = e("a>b b>a b>c c>b b>d d>b");
    const layout = computeLayout(["a", "b", "c", "d"], tree, { directed: false, start: "c" });
    expect(layout.mode).toBe("layered");
    expect(layout.pos.get("c")!.y).toBe(0);
    expect(layout.back.size).toBe(0);
    // A square with a tail: cycles, not dense.
    const square = e("a>b b>c c>d d>a d>t t>u u>v v>w");
    expect(computeLayout(nodesOf(square), square, { directed: false }).mode).toBe("force");
    // ...unless a hint asks: then edges within a layer are fine.
    const asked = computeLayout(nodesOf(square), square, { directed: false, mode: "layered" });
    expect(asked.mode).toBe("layered");
    expectTidy(asked);
  });

  it("leaves a graph with many cycles to stress, and draws a small dense one in a circle", () => {
    const nodes = ["a", "b", "c", "d", "e"];
    const edges = nodes.flatMap((n) => nodes.filter((m) => m !== n).map((m) => ({ from: n, to: m })));
    expect(computeLayout(nodes, edges, { directed: true }).mode).toBe("circle");
    const many = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const tangle = many.flatMap((n, i) => [
      { from: n, to: many[(i + 1) % 10] },
      { from: n, to: many[(i + 3) % 10] },
      { from: n, to: many[(i + 7) % 10] },
    ]);
    expect(computeLayout(many, tangle, { directed: true }).mode).toBe("force");
  });

  it("is the same every time, and quick on a big graph", () => {
    // A deterministic jumble: 200 nodes, each pointing at two later ones and one earlier.
    const nodes = Array.from({ length: 200 }, (_, i) => `n${i}`);
    const edges = nodes.flatMap((n, i) => [
      { from: n, to: nodes[(i * 7 + 3) % 200] },
      { from: n, to: nodes[(i * 13 + 11) % 200] },
    ]);
    const started = performance.now();
    const one = computeLayout(nodes, edges, { directed: true, mode: "layered" });
    const ms = performance.now() - started;
    const two = computeLayout(nodes, edges, { directed: true, mode: "layered" });
    expect([...one.pos]).toEqual([...two.pos]);
    expect([...one.routes]).toEqual([...two.routes]);
    expectTidy(one);
    // Generous for a slow test machine: graphs drawn are 60 nodes at most.
    expect(ms).toBeLessThan(3000);
  });
});

/** No edge runs through a node it doesn't touch (straight edges, and edges with bends). */
function expectClear(layout: GraphLayout, edges: { from: string; to: string }[]): void {
  if (layout.mode === "layered") return; // layers keep edges clear by construction (placeholders)
  for (const { from, to } of edges) {
    if (from === to) continue;
    const points = [layout.pos.get(from)!, ...(layout.routes.get(`${from}>${to}`) ?? []), layout.pos.get(to)!];
    for (const [node, c] of layout.pos) {
      if (node === from || node === to) continue;
      for (let i = 0; i + 1 < points.length; i++) {
        const [a, b] = [points[i], points[i + 1]];
        const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1e-12;
        const t = Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / len2));
        const dist = Math.hypot(c.x - (a.x + (b.x - a.x) * t), c.y - (a.y + (b.y - a.y) * t));
        expect(dist, `${from}>${to} by ${node}`).toBeGreaterThanOrEqual(0.3);
      }
    }
  }
}

/** An undirected graph from "a-b b-c" pairs, listed from both ends as an adjacency list would. */
const both = (spec: string) => e(spec.replace(/-/g, ">")).flatMap((x) => [x, { from: x.to, to: x.from }]);
const gridGraph = (size: number) => {
  const pairs: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (c + 1 < size) pairs.push(`${r}_${c}-${r}_${c + 1}`);
      if (r + 1 < size) pairs.push(`${r}_${c}-${r + 1}_${c}`);
    }
  }
  return both(pairs.join(" "));
};
const CUBE = both("000-001 000-010 000-100 001-011 001-101 010-011 010-110 100-101 100-110 011-111 101-111 110-111");
const PETERSEN = both("o0-o1 o1-o2 o2-o3 o3-o4 o4-o0 o0-i0 o1-i1 o2-i2 o3-i3 o4-i4 i0-i2 i2-i4 i4-i1 i1-i3 i3-i0");

describe("stress layout (undirected graphs with cycles)", () => {
  it("draws a grid as a grid: no crossings, every edge about the same length", () => {
    const edges = gridGraph(4);
    const layout = computeLayout(nodesOf(edges), edges, { directed: false });
    expect(layout.mode).toBe("force");
    expect(edgeCrossings(layout, edges)).toBe(0);
    const lengths = edges.map(({ from, to }) => {
      const [a, b] = [layout.pos.get(from)!, layout.pos.get(to)!];
      return Math.hypot(a.x - b.x, a.y - b.y);
    });
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.3);
    expectTidy(layout);
    expectClear(layout, edges);
  });

  it("crosses no more edges than the old force layout on classic graphs", () => {
    for (const edges of [gridGraph(5), CUBE, PETERSEN]) {
      const nodes = nodesOf(edges);
      const layout = computeLayout(nodes, edges, { directed: false });
      const old: GraphLayout = { pos: legacyForce(nodes, edges), mode: "force", routes: new Map(), back: new Set() };
      expect(edgeCrossings(layout, edges)).toBeLessThanOrEqual(edgeCrossings(old, edges));
      expectTidy(layout);
      expectClear(layout, edges);
    }
  });

  it("puts where the algorithm starts at the top left", () => {
    const edges = gridGraph(4);
    for (const start of ["0_0", "3_3", "0_3"]) {
      const layout = computeLayout(nodesOf(edges), edges, { directed: false, start });
      const points = [...layout.pos.values()];
      const mid = {
        x: points.reduce((s, q) => s + q.x, 0) / points.length,
        y: points.reduce((s, q) => s + q.y, 0) / points.length,
      };
      expect(layout.pos.get(start)!.x).toBeLessThanOrEqual(mid.x);
      expect(layout.pos.get(start)!.y).toBeLessThanOrEqual(mid.y);
    }
  });

  it("bends an edge around a node it would run through", () => {
    // A long cycle with a chord across it: stress puts nodes on the chord's line.
    const edges = both("a-b b-c c-d d-e e-f f-a a-d b-g g-h h-i i-b");
    const layout = computeLayout(nodesOf(edges), edges, { directed: false });
    expectClear(layout, edges);
  });

  it("packs separate pieces in rows, the start's first, lone nodes last", () => {
    const pieces = [CUBE, both("a-b b-c c-a"), both("p-q q-r r-s s-p"), both("x-y y-z z-x x-w")];
    const edges = pieces.flat();
    const layout = computeLayout(nodesOf(edges, ["lone1", "lone2"]), edges, { directed: false, start: "p" });
    expectTidy(layout);
    const box = (nodes: string[]) => {
      const ps = nodes.map((n) => layout.pos.get(n)!);
      return {
        x1: Math.min(...ps.map((q) => q.x)),
        x2: Math.max(...ps.map((q) => q.x)),
        y1: Math.min(...ps.map((q) => q.y)),
        y2: Math.max(...ps.map((q) => q.y)),
      };
    };
    const boxes = [...pieces.map((p) => box(nodesOf(p))), box(["lone1", "lone2"])];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        const apart = a.x2 + 0.5 < b.x1 || b.x2 + 0.5 < a.x1 || a.y2 + 0.5 < b.y1 || b.y2 + 0.5 < a.y1;
        expect(apart, `pieces ${i} and ${j}`).toBe(true);
      }
    }
    // The start's piece is first: top left.
    expect(boxes[2].x1).toBe(0);
    expect(boxes[2].y1).toBe(0);
    // Rows, not one long line.
    const all = box([...layout.pos.keys()]);
    expect(all.x2 - all.x1).toBeLessThan(4 * (all.y2 - all.y1 + 1));
  });

  it("is the same every time, and quick on a big graph", () => {
    const nodes = Array.from({ length: 150 }, (_, i) => `n${i}`);
    const edges = nodes.flatMap((n, i) => [
      { from: n, to: nodes[(i + 1) % 150] },
      { from: n, to: nodes[(i * 11 + 5) % 150] },
    ]);
    const started = performance.now();
    const one = computeLayout(nodes, edges, { directed: false });
    const ms = performance.now() - started;
    const two = computeLayout(nodes, edges, { directed: false });
    expect(one.mode).toBe("force");
    expect([...one.pos]).toEqual([...two.pos]);
    expect([...one.routes]).toEqual([...two.routes]);
    expectTidy(one);
    expect(ms).toBeLessThan(5000);
  });
});

describe("rings", () => {
  it("draws a ring as a circle, in ring order, from the start", () => {
    const edges = e("a>b b>c c>d d>e e>a");
    expect(ringOrder(["a", "b", "c", "d", "e"], edges, "c")).toEqual(["c", "d", "e", "a", "b"]);
    const layout = computeLayout(["e", "d", "c", "b", "a"], edges, { directed: true, start: "c" });
    expect(layout.mode).toBe("circle");
    // The start at the top.
    expect(layout.pos.get("c")!.y).toBe(Math.min(...[...layout.pos.values()].map((p) => p.y)));
  });

  it("isn't fooled by two separate rings or a ring with a spoke", () => {
    expect(ringOrder(["a", "b", "c", "d", "e", "f"], e("a>b b>c c>a d>e e>f f>d"))).toBeNull();
    expect(ringOrder(["a", "b", "c", "d"], e("a>b b>c c>a a>d"))).toBeNull();
  });
});

describe("nodes without edges", () => {
  it("go in rows", () => {
    const layout = computeLayout(["a", "b", "c", "d", "e", "f"], [], { directed: false });
    expect(new Set([...layout.pos.values()].map((p) => p.y)).size).toBeGreaterThan(1);
    expectTidy(layout);
  });
});

describe("placeInOrder", () => {
  it("is as close as the gaps allow, keeping the order", () => {
    expect(placeInOrder([0, 0, 0], [1, 1, 1], [1, 1])).toEqual([-1, 0, 1]);
    expect(placeInOrder([0, 5], [1, 1], [1])).toEqual([0, 5]);
    // A heavy node stays put; a light one moves.
    const [a, b] = placeInOrder([0, 0.5], [9, 1], [1]);
    expect(b - a).toBeCloseTo(1);
    expect(a).toBeCloseTo(-0.05);
  });
});

// ---------------------------------------------------------------------------
// Every graph in the JavaScript and TypeScript examples
// ---------------------------------------------------------------------------

async function graphsOf(code: string): Promise<{
  trace: Trace;
  graphs: Map<
    string,
    { nodes: string[]; edges: GraphEdge[]; directed: boolean; last: ReturnType<typeof findGraphs>[number] }
  >;
}> {
  const trace = applyHints(await traceJavaScript(code));
  const graphs = new Map<
    string,
    { nodes: string[]; edges: GraphEdge[]; directed: boolean; last: ReturnType<typeof findGraphs>[number] }
  >();
  for (const step of trace.steps) {
    for (const g of findGraphs(trace, stepScopes(step), step.heap)) {
      const entry = graphs.get(g.id) ?? { nodes: [], edges: [], directed: false, last: g };
      for (const n of g.nodes.keys()) if (!entry.nodes.includes(n)) entry.nodes.push(n);
      for (const edge of g.edges)
        if (!entry.edges.some((x) => x.from === edge.from && x.to === edge.to)) entry.edges.push(edge);
      entry.directed ||= g.directed;
      entry.last = g;
      graphs.set(g.id, entry);
    }
  }
  return { trace, graphs };
}

const examples = [...JAVASCRIPT_EXAMPLES, ...TYPESCRIPT_EXAMPLES].filter((x) =>
  /graph|search|dijkstra|topolog|trie|cities|route|tree/i.test(x.name),
);

describe("the examples' graphs", () => {
  it.each(examples.map((x) => [x.name, x.code] as const))(
    "%s: tidy, and no more crossings than before",
    async (_name, code) => {
      const { trace, graphs } = await graphsOf(code);
      for (const { nodes, edges, directed, last } of graphs.values()) {
        const layout = layoutFor(trace, last);
        expectTidy(layout);
        expectClear(layout, edges);
        const before =
          layout.mode === "layered"
            ? legacyLayered(nodes, edges, directed)
            : layout.mode === "force"
              ? legacyForce(nodes, edges)
              : null;
        if (before) {
          const old: GraphLayout = { pos: before, mode: layout.mode, routes: new Map(), back: new Set() };
          expect(edgeCrossings(layout, edges)).toBeLessThanOrEqual(edgeCrossings(old, edges));
        }
      }
    },
  );
});
