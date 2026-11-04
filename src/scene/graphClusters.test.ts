// @vitest-environment jsdom
/**
 * Graph clusters (graphClusters.ts): a graph with more nodes than the
 * detail budget is drawn as clusters, found from the run's whole graph and
 * the same at every step; a cluster opens by its key; what the algorithm
 * marks is gathered onto the clusters; and both windows draw them, a click
 * on one asking for it to open.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { s } from "../render/draw";
import { graphPicture } from "../render/graphView";
import { memoryDrawing } from "../render/memory";
import { SVG_RENDERERS } from "../render/svgRenderers";
import { diffSteps } from "../trace/diff";
import { emptyOverlay, type GraphData, graphsAt } from "../trace/graph";
import { applyHints } from "../trace/hints";
import { buildLoopHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { CLUSTER_PREFIX, clusterGraph, clusterOverlay, realNodes } from "./graphClusters";
import { loopScene } from "./loopScene";
import { loopGraphBudget } from "./loopSummaries";
import { memoryScene } from "./memoryScene";

/** 48 people in 4 friend groups of 12 (each linked to the next three in their group), then a walk from person 0. */
const GROUPS = `class Person {
  constructor(id) { this.id = id; this.friends = []; }
}
const people = [];
for (let i = 0; i < 48; i++) people.push(new Person(i));
for (const p of people) {
  const g = Math.floor(p.id / 12);
  for (let k = 1; k <= 3; k++) {
    const q = people[g * 12 + ((p.id % 12) + k) % 12];
    if (!p.friends.includes(q)) { p.friends.push(q); q.friends.push(p); }
  }
}
people[11].friends.push(people[12]);
people[12].friends.push(people[11]);
const seen = new Set([people[0]]);
const queue = [people[0]];
for (let n = 0; n < 6; n++) {
  const p = queue.shift();
  for (const f of p.friends) if (!seen.has(f)) { seen.add(f); queue.push(f); }
}
`;

const traced = async () => applyHints(await traceJavaScript(GROUPS, 5000));
const lastGraph = (t: Trace): GraphData => graphsAt(t, t.steps.at(-1)!)[0];
const none = new Set<string>();

describe("graph clusters", () => {
  it("draws a graph over the budget as its dense groups, and one that fits as it is", async () => {
    const t = await traced();
    const graph = lastGraph(t);
    expect(graph.nodes.size).toBe(48);
    expect(clusterGraph(t, graph, 64, none)).toBeNull();
    const view = clusterGraph(t, graph, 16, none)!;
    expect([...view.clusters.values()].map((c) => c.members.length)).toEqual([12, 12, 12, 12]);
    expect(view.graph.nodes.size).toBe(4);
    expect([...view.graph.nodes.values()]).toEqual(["12 nodes", "12 nodes", "12 nodes", "12 nodes"]);
    for (const key of view.clusters.keys()) expect(key.startsWith(CLUSTER_PREFIX)).toBe(true);
    // The one link between groups 0 and 1, listed from both ends, is one edge; nothing links the others.
    expect(view.graph.edges).toHaveLength(1);
    expect(view.graph.edges[0].label).toBeUndefined();
    expect(realNodes(view.graph).sort()).toEqual([...graph.nodes.keys()].sort());
    // Every cluster is placed, and each node is drawn as its cluster.
    for (const key of view.clusters.keys()) expect(view.layout.pos.has(key)).toBe(true);
    for (const node of graph.nodes.keys()) expect(view.clusters.has(view.drawnAs.get(node)!)).toBe(true);
  });

  it("is the same at every step: the clusters come from the run's whole graph", async () => {
    const t = await traced();
    const keys = new Set<string>();
    let layouts = new Set<unknown>();
    t.steps.forEach((step, i) => {
      const graph = graphsAt(t, step)[0];
      if (!graph || i % 5) return;
      const view = clusterGraph(t, graph, 16, none);
      if (!view) return;
      for (const key of view.clusters.keys()) keys.add(key);
      layouts = new Set([...layouts, view.layout]);
    });
    expect(keys.size).toBe(4);
    expect(layouts.size).toBe(1);
  });

  it("opens a cluster by its key, its nodes drawn and laid out with the other clusters, and at another budget too", async () => {
    const t = await traced();
    const graph = lastGraph(t);
    const closed = clusterGraph(t, graph, 16, none)!;
    const [first] = closed.clusters.keys();
    const open = clusterGraph(t, graph, 16, new Set([first]))!;
    expect(open.clusters.size).toBe(3);
    expect(open.graph.nodes.size).toBe(3 + 12);
    for (const member of closed.clusters.get(first)!.members) {
      expect(open.drawnAs.get(member)).toBe(member);
      expect(open.layout.pos.has(member)).toBe(true);
    }
    // Edges between its nodes are drawn as they are.
    expect(
      open.graph.edges.filter((e) => !e.from.startsWith(CLUSTER_PREFIX) && !e.to.startsWith(CLUSTER_PREFIX)).length,
    ).toBeGreaterThan(12);
    // Zoomed out further, the cluster holding its first node is open too.
    const smaller = clusterGraph(t, graph, 2, new Set([first]))!;
    expect(smaller.drawnAs.get(closed.clusters.get(first)!.members[0])).toBe(closed.clusters.get(first)!.members[0]);
  });

  it("gathers what the algorithm marks onto each cluster", async () => {
    const t = await traced();
    const graph = lastGraph(t);
    const view = clusterGraph(t, graph, 16, none)!;
    const members = [...view.clusters.values()].map((c) => c.members);
    const overlay = {
      ...emptyOverlay(),
      visitedNames: ["seen"],
      visited: new Map([...members[0].map((m) => [m, "seen"] as [string, string]), [members[1][0], "seen"]]),
      frontier: new Map([
        [members[1][3], 2],
        [members[1][4], 0],
      ]),
      pointers: new Map([
        [members[2][0], ["p"]],
        [members[2][5], ["q"]],
      ]),
    };
    const gathered = clusterOverlay(view, overlay);
    const [a, b, c] = [...view.clusters.keys()];
    expect(gathered.visited.has(a)).toBe(true); // all 12 seen
    expect(gathered.visited.has(b)).toBe(false);
    expect(gathered.labels.get(b)).toBe("1 seen");
    expect(gathered.frontier.get(b)).toBe(0); // the next one out is in it
    expect(gathered.pointers.get(c)).toEqual(["p", "q"]);
    // The same overlay through the same view: the same object (loop rows are kept by it).
    expect(clusterOverlay(view, overlay)).toBe(gathered);
  });

  it("draws clusters as stacked nodes to click, and arrows to a node in one end at it", async () => {
    const t = await traced();
    const graph = lastGraph(t);
    const view = clusterGraph(t, graph, 16, none)!;
    const picture = graphPicture(view.graph, view.layout, emptyOverlay(), { flipKey: "g" });
    const [key, cluster] = [...view.clusters][0];
    expect(picture.centers.get(cluster.members[5])).toEqual(picture.centers.get(key));
    const layer = s("g");
    picture.draw(0, 0, layer);
    const drawn = layer.querySelectorAll(".graph-cluster");
    expect(drawn).toHaveLength(4);
    expect(drawn[0].getAttribute("data-click")).toBe(key);
    expect(drawn[0].querySelector(".cluster-back")).not.toBeNull();
  });

  it("is drawn in the memory view by the detail budget, its box titled with the whole graph", async () => {
    const t = await traced();
    const i = t.steps.length - 1;
    const scene = (budget: number, expanded = none) =>
      memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { detail: { budget, expanded } });
    const full = [...scene(64).graphs.values()][0];
    expect(full.graph.clusters).toBeUndefined();
    const small = [...scene(16).graphs.values()][0];
    expect(small.graph.clusters?.size).toBe(4);
    expect(small.real.nodes.size).toBe(48);
    const drawing = memoryDrawing(scene(16), { positions: new Map() });
    const titles = drawing.querySelectorAll(".box-title").map((title) => title.textContent);
    expect(titles.some((title) => title.includes("48 nodes in 4 clusters"))).toBe(true);
    expect(drawing.querySelectorAll(".graph-cluster")).toHaveLength(4);
  });

  it("is drawn the same in every loop row, rows kept between steps", async () => {
    const t = await traced();
    let at = -1;
    t.steps.forEach((s, i) => {
      if (s.line === 19) at = i; // the walk's inner loop
    });
    const history = buildLoopHistory(t, at, null)!;
    const scene = loopScene(t, history, { hideQuiet: false, detail: { cells: 20_000, expanded: none } });
    const rows = scene.graph!.rows.filter(Boolean);
    expect(rows.length).toBeGreaterThan(1);
    // As the memory view draws it at the loop's budget for that zoom.
    const clusters = clusterGraph(t, lastGraph(t), loopGraphBudget(20_000), none)!.clusters;
    for (const row of rows) expect([...row!.graph.clusters!.keys()]).toEqual([...clusters.keys()]);
    const again = loopScene(t, history, { hideQuiet: false, detail: { cells: 20_000, expanded: none } });
    expect(again.graph!.rows.filter(Boolean)[0]!.graph).toBe(rows[0]!.graph);
    // At full detail it fits: drawn as it is.
    const full = loopScene(t, history, { hideQuiet: false, detail: { cells: 40_000, expanded: none } });
    expect(full.graph!.first.clusters).toBeUndefined();
  });

  it("asks the app to open a cluster clicked in the memory window", async () => {
    const t = await traced();
    const el = document.createElement("div");
    el.setPointerCapture = () => {};
    el.releasePointerCapture = () => {};
    document.body.append(el);
    const opened: string[] = [];
    const r = SVG_RENDERERS.memory(el, { onExpand: (key) => opened.push(key) });
    const i = t.steps.length - 1;
    r.render(
      memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { detail: { budget: 16, expanded: none } }),
      null,
    );
    const cluster = el.querySelector<SVGGElement>(".graph-cluster")!;
    // jsdom has no PointerEvent: a mouse event with a pointer id.
    const press = (type: string, target: Element) => {
      const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 10 });
      Object.defineProperty(e, "pointerId", { value: 1 });
      target.dispatchEvent(e);
    };
    press("pointerdown", cluster.querySelector("text") ?? cluster);
    press("pointerup", el);
    expect(opened).toEqual([cluster.getAttribute("data-click")]);
    r.dispose();
    el.remove();
  });
});
