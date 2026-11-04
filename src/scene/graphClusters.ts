/**
 * Graph clusters: a graph with more nodes than the detail budget (see
 * summaries.ts) is drawn as clusters of nodes instead, each one node of
 * its own with a count, laid out again for the clusters.
 *
 *     ( 31 nodes )────( 24 nodes )        a cluster: dense groups of nodes,
 *          │      ╲        │              each drawn as one, its edges to
 *     ( 27 nodes )  ( 7 )──( 18 nodes )   the others gathered into one
 *
 * Clusters come from the graph over the whole run (trace/graph.ts
 * unionFor), so they're the same at every step, as the layout is:
 *
 *   1. communities, by the Louvain method: nodes move to the neighboring
 *      community that raises the modularity most, in a fixed order (so the
 *      same graph always splits the same way), then communities merge;
 *   2. a community bigger than the budget is cut into pieces of at most
 *      the budget in breadth-first order, so one opened cluster is never
 *      more than the budget either;
 *   3. while there are more clusters than the budget, the smallest joins
 *      the neighboring cluster it has the most edges to (or, with none,
 *      the next smallest without neighbors).
 *
 * A cluster's key is its first node: a cluster the person opened (clicked)
 * is drawn as its nodes, by key, step after step, and at another budget
 * the cluster holding that node is open too. What the algorithm marks
 * (visited, queued, on a path, a variable pointing in) is gathered onto
 * each cluster: a count of nodes seen, the next queued node's place, the
 * names pointing in.
 */
import {
  computeLayout,
  emptyOverlay,
  type GraphData,
  type GraphEdge,
  type GraphLayout,
  type GraphOverlay,
  type GraphUnion,
  unionFor,
} from "../trace/graph";
import type { Trace } from "../trace/types";

/** Cluster keys start with this (a click on a cluster opens it: summaries' expanded set). */
export const CLUSTER_PREFIX = "gcl:";

/** One cluster drawn in a graph, by its key there. */
export interface Cluster {
  /** Its key: what opens it. */
  key: string;
  /** Every node in it over the run, in the order first seen. */
  members: string[];
}

/** A graph as drawn: clusters for the parts not opened, nodes for the rest. */
export interface ClusteredGraph {
  /** The graph to draw: clusters are nodes (by their keys), with edges between them gathered. */
  graph: GraphData;
  layout: GraphLayout;
  /** Each cluster drawn, by its key (the node it is in `graph`). */
  clusters: ReadonlyMap<string, Cluster>;
  /** Each node of the real graph -> what it's drawn as: its cluster's key, or itself. */
  drawnAs: ReadonlyMap<string, string>;
}

/** Sweeps of moving nodes between communities, at most, at each level: enough to settle graphs of hundreds of nodes. */
const SWEEPS = 20;

/** Partitions by graph and budget, for the run (a WeakMap by trace). */
const partitions = new WeakMap<Trace, Map<string, string[][]>>();

/** Neighbors of each node, both ways, in the union's node order. */
function neighbors(union: GraphUnion): Map<string, string[]> {
  const out = new Map<string, string[]>(union.nodes.map((n) => [n, []]));
  for (const e of union.edges) {
    if (e.from === e.to || !out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from)!.push(e.to);
    out.get(e.to)!.push(e.from);
  }
  return out;
}

/**
 * Communities by the Louvain method: each node moves to the neighboring
 * community that raises the modularity most (more edges inside
 * communities than chance would put there), sweep after sweep in a fixed
 * order until none moves; then each community becomes one node (its edges
 * weighted) and that graph is done again, until nothing merges.
 */
function communities(union: GraphUnion, adj: Map<string, string[]>): string[][] {
  const order = new Map(union.nodes.map((n, i) => [n, i]));
  // The graph at this level: weighted edges between its nodes (numbers), and what each stands for.
  let members: string[][] = union.nodes.map((n) => [n]);
  let weights: Map<number, number>[] = union.nodes.map(() => new Map());
  for (const [node, near] of adj) {
    const i = order.get(node)!;
    for (const n of near) {
      const j = order.get(n)!;
      weights[i].set(j, (weights[i].get(j) ?? 0) + 0.5); // each edge is in both lists: half from each end
    }
  }
  for (let level = 0; level < 10; level++) {
    const count = members.length;
    const degree = weights.map((w) => [...w.values()].reduce((a, b) => a + b, 0));
    const total = degree.reduce((a, b) => a + b, 0); // 2m
    if (total === 0) break;
    const community = members.map((_, i) => i);
    const sum = [...degree]; // each community's total degree
    let moved = true;
    let sweeps = 0;
    while (moved && sweeps++ < SWEEPS) {
      moved = false;
      for (let i = 0; i < count; i++) {
        const own = community[i];
        // Edges from i to each neighboring community.
        const links = new Map<number, number>();
        for (const [j, w] of weights[i]) if (j !== i) links.set(community[j], (links.get(community[j]) ?? 0) + w);
        sum[own] -= degree[i];
        const gain = (c: number) => (links.get(c) ?? 0) - (sum[c] * degree[i]) / total;
        let best = own;
        let bestGain = gain(own);
        for (const c of links.keys())
          if (gain(c) > bestGain + 1e-12 || (Math.abs(gain(c) - bestGain) <= 1e-12 && c < best)) {
            best = c;
            bestGain = gain(c);
          }
        sum[best] += degree[i];
        if (best !== own) {
          community[i] = best;
          moved = true;
        }
      }
    }
    // One node per community, in the order of their first nodes.
    const ids = [...new Set(community)];
    if (ids.length === count) break;
    const index = new Map(ids.map((c, k) => [c, k]));
    const nextMembers: string[][] = ids.map(() => []);
    const nextWeights: Map<number, number>[] = ids.map(() => new Map());
    for (let i = 0; i < count; i++) {
      const a = index.get(community[i])!;
      nextMembers[a].push(...members[i]);
      for (const [j, w] of weights[i]) {
        const b = index.get(community[j])!;
        nextWeights[a].set(b, (nextWeights[a].get(b) ?? 0) + w);
      }
    }
    members = nextMembers;
    weights = nextWeights;
  }
  return members
    .map((m) => m.sort((a, b) => order.get(a)! - order.get(b)!))
    .sort((a, b) => order.get(a[0])! - order.get(b[0])!);
}

/** A group cut into pieces of about `size` nodes, each grown breadth-first from its earliest node left. */
function cut(group: string[], size: number, adj: Map<string, string[]>): string[][] {
  const left = new Set(group);
  const pieces: string[][] = [];
  for (const start of group) {
    if (!left.has(start)) continue;
    const piece: string[] = [];
    const queue = [start];
    left.delete(start);
    while (queue.length && piece.length < size) {
      const node = queue.shift()!;
      piece.push(node);
      for (const n of adj.get(node)!)
        if (left.has(n)) {
          left.delete(n);
          queue.push(n);
        }
    }
    // What was queued but didn't fit goes back for the next piece.
    for (const n of queue) left.add(n);
    pieces.push(piece);
  }
  return pieces;
}

/** The union's nodes in at most `budget` clusters (see the top of this file). */
function partition(union: GraphUnion, budget: number): string[][] {
  const adj = neighbors(union);
  const order = new Map(union.nodes.map((n, i) => [n, i]));
  let groups = communities(union, adj).flatMap((g) => (g.length > budget ? cut(g, budget, adj) : [g]));
  // Joining the smallest into its best neighbor, until few enough.
  const clusterOf = new Map<string, number>();
  const sets = groups.map((g) => new Set(g));
  groups.forEach((g, i) => {
    for (const n of g) clusterOf.set(n, i);
  });
  let count = groups.length;
  const alive = groups.map(() => true);
  const firsts = groups.map((g) => Math.min(...g.map((n) => order.get(n)!)));
  const first = (i: number) => firsts[i];
  while (count > budget) {
    let smallest = -1;
    for (let i = 0; i < sets.length; i++) {
      if (!alive[i]) continue;
      if (
        smallest < 0 ||
        sets[i].size < sets[smallest].size ||
        (sets[i].size === sets[smallest].size && first(i) < first(smallest))
      )
        smallest = i;
    }
    const links = new Map<number, number>();
    for (const n of sets[smallest])
      for (const m of adj.get(n)!) {
        const c = clusterOf.get(m)!;
        if (c !== smallest) links.set(c, (links.get(c) ?? 0) + 1);
      }
    let into = -1;
    for (const [c, k] of links) {
      const best = into < 0 ? -1 : links.get(into)!;
      if (k > best || (k === best && (sets[c].size < sets[into].size || first(c) < first(into)))) into = c;
    }
    if (into < 0) {
      // No neighbors: with the next smallest cluster that has none either, or else the next smallest.
      for (let i = 0; i < sets.length; i++) {
        if (!alive[i] || i === smallest) continue;
        if (into < 0 || sets[i].size < sets[into].size) into = i;
      }
    }
    for (const n of sets[smallest]) {
      sets[into].add(n);
      clusterOf.set(n, into);
    }
    firsts[into] = Math.min(firsts[into], firsts[smallest]);
    sets[smallest].clear();
    alive[smallest] = false;
    count--;
  }
  groups = sets
    .filter((s, i) => alive[i] && s.size)
    .map((s) => [...s].sort((a, b) => order.get(a)! - order.get(b)!))
    .sort((a, b) => order.get(a[0])! - order.get(b[0])!);
  return groups;
}

function partitionFor(trace: Trace, graph: GraphData, union: GraphUnion, budget: number): string[][] {
  let byKey = partitions.get(trace);
  if (!byKey) {
    byKey = new Map();
    partitions.set(trace, byKey);
  }
  const key = `${graph.id}|${union.nodes.length}|${budget}`;
  let groups = byKey.get(key);
  if (!groups) {
    groups = partition(union, budget);
    byKey.set(key, groups);
  }
  return groups;
}

const clusterKey = (graph: GraphData, first: string) => `${CLUSTER_PREFIX}${graph.id}|${first}`;

/**
 * A graph as drawn at this detail budget: null when it fits (drawn as it
 * is, with layoutFor), else its clusters, with the ones in `expanded` drawn
 * as their nodes.
 */
export function clusterGraph(
  trace: Trace,
  graph: GraphData,
  budget: number,
  expanded: ReadonlySet<string>,
): ClusteredGraph | null {
  const union = unionFor(trace, graph);
  if (union.nodes.length <= budget) return null;
  const groups = partitionFor(trace, graph, union, budget);
  // Open: a cluster's key, or the key of a cluster at another budget whose first node is in it.
  const open = groups
    .filter((members) => members.some((m) => expanded.has(clusterKey(graph, m))))
    .map((members) => clusterKey(graph, members[0]));
  let byKey = views.get(trace);
  if (!byKey) {
    byKey = new Map();
    views.set(trace, byKey);
  }
  const key = `${graph.id}|${union.nodes.length}|${budget}|${open.join(",")}`;
  let view = byKey.get(key);
  if (!view) {
    view = viewOf(graph, union, groups, new Set(open));
    byKey.set(key, view);
  }
  return { ...view, graph: drawnGraph(view, graph) };
}

/** Views made, by graph, budget and what's open: the same view object, so what's drawn from it can be kept. */
const views = new WeakMap<Trace, Map<string, View>>();
type View = Omit<ClusteredGraph, "graph">;

function viewOf(graph: GraphData, union: GraphUnion, groups: string[][], open: ReadonlySet<string>): View {
  const drawnAs = new Map<string, string>();
  const clusters = new Map<string, Cluster>();
  for (const members of groups) {
    const key = clusterKey(graph, members[0]);
    if (open.has(key)) {
      for (const m of members) drawnAs.set(m, m);
      continue;
    }
    clusters.set(key, { key, members });
    for (const m of members) drawnAs.set(m, key);
  }
  // The units drawn, in the union's order (a cluster where its first node is).
  const units: string[] = [];
  const placed = new Set<string>();
  for (const node of union.nodes) {
    const unit = drawnAs.get(node)!;
    if (placed.has(unit)) continue;
    placed.add(unit);
    units.push(unit);
  }
  const unitEdges = gatherEdges(union.edges, drawnAs, union.directed);
  const layout = clusterLayout(units, unitEdges, union);
  return { layout, clusters, drawnAs };
}

/**
 * What's been drawn from each view: the same graph or overlay gives the
 * same object (loop rows are kept by them). By the view's `drawnAs`, which
 * every copy of the view shares.
 */
const drawnGraphs = new WeakMap<object, WeakMap<GraphData, GraphData>>();
const drawnOverlays = new WeakMap<object, WeakMap<GraphOverlay, GraphOverlay>>();

function remembered<K extends object, V>(memo: WeakMap<object, WeakMap<K, V>>, view: View, key: K, make: () => V): V {
  let inner = memo.get(view.drawnAs);
  if (!inner) {
    inner = new WeakMap();
    memo.set(view.drawnAs, inner);
  }
  let value = inner.get(key);
  if (value === undefined) {
    value = make();
    inner.set(key, value);
  }
  return value;
}

/**
 * A step's graph, drawn as `view` draws it: a cluster is there if any of
 * its nodes is (the step before's graph too, to animate what changed).
 */
export function drawnGraph(view: View, graph: GraphData): GraphData {
  return remembered(drawnGraphs, view, graph, () => drawGraph(view, graph));
}

function drawGraph(view: View, graph: GraphData): GraphData {
  const nodes = new Map<string, string>();
  for (const [node, label] of graph.nodes) {
    const unit = view.drawnAs.get(node) ?? node;
    if (nodes.has(unit)) continue;
    const cluster = view.clusters.get(unit);
    nodes.set(unit, cluster ? clusterLabel(cluster) : label);
  }
  return {
    ...graph,
    nodes,
    edges: gatherEdges(graph.edges, view.drawnAs, graph.directed),
    clusters: view.clusters,
  };
}

/**
 * Edges between what's drawn: edges inside one cluster are left out, and
 * those between the same two (a cluster and anything) become one, labelled
 * with how many when it's more than one. Edges between two nodes stay as
 * they are.
 */
function gatherEdges(
  edges: readonly GraphEdge[],
  drawnAs: ReadonlyMap<string, string>,
  directed: boolean,
): GraphEdge[] {
  const out: GraphEdge[] = [];
  const gathered = new Map<string, { edge: GraphEdge; count: number }>();
  // Undirected, an edge is listed from both ends: counted once.
  const counted = new Set<string>();
  for (const e of edges) {
    const from = drawnAs.get(e.from) ?? e.from;
    const to = drawnAs.get(e.to) ?? e.to;
    if (from === e.from && to === e.to) {
      out.push(e);
      continue;
    }
    if (from === to) continue;
    if (!directed) {
      const pair = e.from < e.to ? `${e.from}>${e.to}` : `${e.to}>${e.from}`;
      if (counted.has(pair)) continue;
      counted.add(pair);
    }
    // Undirected: one edge whichever way it was listed.
    const key = directed || from < to ? `${from}>${to}` : `${to}>${from}`;
    const known = gathered.get(key);
    if (known) known.count++;
    else {
      const edge = directed || from < to ? { from, to } : { from: to, to: from };
      gathered.set(key, { edge, count: 1 });
      out.push(edge);
    }
  }
  for (const { edge, count } of gathered.values()) if (count > 1) edge.label = `×${count}`;
  return out;
}

function clusterLayout(units: string[], edges: GraphEdge[], union: GraphUnion): GraphLayout {
  const start = union.start ? units.find((u) => u === union.start) : undefined;
  // Clusters of a ring or a chain don't ring or chain: the layout chooses, unless the graph asked for one.
  return computeLayout(units, edges, {
    directed: union.directed,
    mode: union.layout === "circle" ? "circle" : union.layout === "layered" ? "layered" : "force",
    angled: union.angled,
    start: start ?? null,
  });
}

/** What the algorithm marks, gathered onto each cluster (see the top of this file). */
export function clusterOverlay(view: View, overlay: GraphOverlay): GraphOverlay {
  return remembered(drawnOverlays, view, overlay, () => gatherOverlay(view, overlay));
}

function gatherOverlay(view: View, overlay: GraphOverlay): GraphOverlay {
  const unit = (node: string) => view.drawnAs.get(node) ?? node;
  const edgeKey = (key: string) => {
    const [from, to] = key.split(">");
    const a = unit(from);
    const b = unit(to);
    return a === b ? null : `${a}>${b}`;
  };
  const out: GraphOverlay = {
    ...emptyOverlay(),
    visitedNames: overlay.visitedNames,
    frontierName: overlay.frontierName,
    labelNames: overlay.labelNames,
    treeName: overlay.treeName,
    chosenName: overlay.chosenName,
    pathName: overlay.pathName,
  };
  const seen = new Map<string, number>();
  for (const [node, by] of overlay.visited) {
    const u = unit(node);
    if (u === node) out.visited.set(node, by);
    else seen.set(u, (seen.get(u) ?? 0) + 1);
  }
  for (const [key, cluster] of view.clusters) {
    const n = seen.get(key) ?? 0;
    if (n === cluster.members.length) out.visited.set(key, overlay.visitedNames[0] ?? "");
    else if (n) out.labels.set(key, `${n} seen`);
  }
  for (const [node, rank] of overlay.frontier) {
    const u = unit(node);
    const known = out.frontier.get(u);
    if (known === undefined || rank < known) out.frontier.set(u, rank);
  }
  for (const [node, text] of overlay.labels) if (unit(node) === node) out.labels.set(node, text);
  for (const set of ["treeEdges", "chosenEdges", "pathEdges"] as const)
    for (const key of overlay[set]) {
      const k = edgeKey(key);
      if (k) out[set].add(k);
    }
  for (const node of overlay.pathNodes) out.pathNodes.add(unit(node));
  for (const [node, names] of overlay.pointers) {
    const u = unit(node);
    out.pointers.set(u, [...new Set([...(out.pointers.get(u) ?? []), ...names])]);
  }
  return out;
}

/** A drawn graph's real nodes: its nodes, with each cluster's in place of it (for their sizes). */
export function realNodes(graph: GraphData): string[] {
  return [...graph.nodes.keys()].flatMap((key) => graph.clusters?.get(key)?.members ?? [key]);
}

/** What a cluster says on it: how many nodes it stands for. */
const clusterLabel = (cluster: Cluster) => `${cluster.members.length} node${cluster.members.length === 1 ? "" : "s"}`;
