// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { emptyOverlay, type GraphData } from "../trace/graph";
import { computeLayout } from "../trace/graphLayout";
import { graphPicture, sidewaysFits } from "./graphView";

/** A root with `n` children: one very wide layer. */
function star(n: number, sideways = false): GraphData {
  const kids = Array.from({ length: n }, (_, i) => `s:k${i}`);
  return {
    id: "obj:1",
    name: "tree",
    kind: "adjacency",
    hostId: "1",
    nodes: new Map(["s:root", ...kids].map((k) => [k, k.slice(2)])),
    edges: kids.map((k) => ({ from: "s:root", to: k })),
    directed: true,
    members: new Set(),
    objectNodes: false,
    layout: "auto",
    edgeStyle: "auto",
    sideways,
    names: [],
    flags: new Map(),
  };
}

const layoutOf = (g: GraphData) =>
  computeLayout([...g.nodes.keys()], g.edges, { directed: g.directed, mode: g.layout });

describe("very wide layers", () => {
  it("run left to right in a tall window, and top to bottom in a wide one", () => {
    const g = star(12);
    const layout = layoutOf(g);
    expect(layout.mode).toBe("layered");
    expect(sidewaysFits(g, layout, 80, 76, false)).toBe(false);
    expect(sidewaysFits(g, layout, 80, 76, true)).toBe(true);
    // A narrow graph stays top to bottom wherever it is.
    expect(sidewaysFits(star(3), layoutOf(star(3)), 80, 76, true)).toBe(false);
  });

  it("run left to right whenever a hint asks", () => {
    const g = star(3, true);
    expect(sidewaysFits(g, layoutOf(g), 80, 76, false)).toBe(true);
  });

  it("draw the layer as a column, beside the node above it", () => {
    const g = star(12);
    const picture = graphPicture(g, layoutOf(g), emptyOverlay(), { flipKey: "g", tall: true });
    const kids = [...g.nodes.keys()].slice(1).map((k) => picture.centers.get(k)!);
    expect(new Set(kids.map((c) => c.x)).size).toBe(1);
    expect(kids[0].x).toBeGreaterThan(picture.centers.get("s:root")!.x);
    expect(picture.h).toBeGreaterThan(picture.w);
    const wide = graphPicture(g, layoutOf(g), emptyOverlay(), { flipKey: "g" });
    expect(wide.w).toBeGreaterThan(wide.h);
  });
});
