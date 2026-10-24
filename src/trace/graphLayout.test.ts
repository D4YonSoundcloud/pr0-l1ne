import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { legacyLayered } from "../testing/legacyGraphLayout";
import { findGraphs, type GraphEdge, layoutFor, stepScopes } from "./graph";
import { computeLayout, type GraphLayout, layeredCrossings, placeInOrder, ringOrder } from "./graphLayout";
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
  for (const [key, bends] of layout.routes) {
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
    expect(layeredCrossings(layout, edges)).toBe(0);
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
    const square = e("a>b b>c c>d d>a a>c");
    expect(computeLayout(["a", "b", "c", "d"], square, { directed: false }).mode).toBe("force");
    // ...unless a hint asks: then edges within a layer are fine.
    const asked = computeLayout(["a", "b", "c", "d"], square, { directed: false, mode: "layered" });
    expect(asked.mode).toBe("layered");
    expectTidy(asked);
  });

  it("leaves a graph with many cycles to force", () => {
    const nodes = ["a", "b", "c", "d", "e"];
    const edges = nodes.flatMap((n) => nodes.filter((m) => m !== n).map((m) => ({ from: n, to: m })));
    expect(computeLayout(nodes, edges, { directed: true }).mode).toBe("force");
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
        if (layout.mode !== "layered") continue;
        const before = legacyLayered(nodes, edges, directed);
        if (before) {
          const old: GraphLayout = { pos: before, mode: "layered", routes: new Map(), back: new Set() };
          expect(layeredCrossings(layout, edges)).toBeLessThanOrEqual(layeredCrossings(old, edges));
        }
      }
    },
  );
});
