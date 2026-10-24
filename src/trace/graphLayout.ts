/**
 * Laying out a graph: where each node goes, and the bends of edges that
 * span more than one layer. Pure: data in, data out (graph.ts calls it once
 * per graph per run; render/graphView.ts draws the result).
 *
 *   layered   trees, DAGs, and directed graphs with a few cycles: the
 *             classic layered ("Sugiyama") pipeline below
 *   circle    a ring (each node linked to two others, all in one loop), a
 *             graph of one or two nodes, or a hint asking for it
 *   force     everything else (undirected graphs with cycles, dense graphs)
 *   grid      nodes with no edges at all, in rows
 *
 * The layered pipeline:
 *
 *   1. Tidy the edges. Self-loops (A → A) take no part (they're drawn as a
 *      loop on the node); an undirected edge listed from both ends, a
 *      repeated edge and a two-way pair (A → B and B → A) are one
 *      connection for layout. graphView.ts draws each real edge.
 *   2. Break cycles. A depth-first walk from where the algorithm starts (the
 *      first node it queues or visits; see layoutFor), then from nodes
 *      nothing points to, in program order, reverses each edge that leads
 *      back to a node still on the walk. Those are drawn as back edges,
 *      pointing up. Undirected graphs are layered by breadth-first distance
 *      from the start instead.
 *   3. Layers. Longest path from the top; then a node nothing points to
 *      moves down to just above its highest child, so its edges are short.
 *      The start stays on top.
 *   4. Placeholders. An edge spanning several layers gets an invisible
 *      point in each layer it crosses, so it bends around nodes instead of
 *      going through them.
 *   5. Order within layers. Start from a depth-first order (subtrees stay
 *      together, children in program order), then sweep down and up,
 *      ordering each layer by the median position of its neighbors, and
 *      swap neighbors whenever that removes crossings. The order with the
 *      fewest crossings wins. A tree is already crossing-free in
 *      depth-first order, and keeps it, so a node's children stay in the
 *      program's order (left before right).
 *   6. Positions. Each node as close as it can be to the average of its
 *      neighbors above and below, keeping the order and a minimum gap. Each
 *      sweep is solved exactly (isotonic regression, pool adjacent
 *      violators). Placeholders weigh more, so long edges run straight.
 *
 * Separate pieces of a graph are laid out apart and put side by side in the
 * order they first appear; nodes with no edges sit in a block to the right.
 * Nothing here is random, and every tie is broken by program order, so the
 * same graph is laid out the same way every time, in every browser.
 */

export interface Point {
  x: number;
  y: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export type LayoutMode = "circle" | "layered" | "force";

export interface GraphLayout {
  /** Node key -> position in layout units (about one node apart; layered: y is the layer). */
  pos: Map<string, Point>;
  mode: LayoutMode;
  /**
   * Layered: the bends of an edge that spans more than one layer, in layout
   * units, from its first node to its last. Keyed "from>to" both ways (the
   * reverse key has the points reversed). Edges without an entry are straight.
   */
  routes: Map<string, Point[]>;
  /** Layered: edges ("from>to") that point against the layers (up): the ones cycle breaking turned. */
  back: Set<string>;
}

export interface LayoutOptions {
  directed: boolean;
  /** What a hint asked for; "auto" picks. */
  mode?: "auto" | "circle" | "layered" | "force";
  /** Where the algorithm starts: drawn on top (layered) or first (circle). */
  start?: string | null;
}

/** Above this many crossings' worth of sweeps, stop: graphs here are small. */
const SWEEPS = 24;
/** Gaps between neighbors in a layer, in units: a real node takes 1, a placeholder much less. */
const REAL_HALF = 0.5;
const DUMMY_HALF = 0.22;
/** How much more a placeholder pulls than a node, so long edges stay straight. */
const DUMMY_WEIGHT = 6;
const DUMMY = "\u0000d";

const emptyLayout = (mode: LayoutMode): GraphLayout => ({ pos: new Map(), mode, routes: new Map(), back: new Set() });

// ---------------------------------------------------------------------------
// The pieces of a graph
// ---------------------------------------------------------------------------

/** One connection for layout: deduplicated, no self-loops, nodes known. */
interface Link {
  from: string;
  to: string;
}

/** Edges as connections: each pair of nodes once (the first direction seen), no self-loops. */
function links(nodes: readonly string[], edges: readonly LayoutEdge[]): Link[] {
  const known = new Set(nodes);
  const seen = new Set<string>();
  const out: Link[] = [];
  for (const e of edges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue;
    const pair = e.from < e.to ? `${e.from}\u0001${e.to}` : `${e.to}\u0001${e.from}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({ from: e.from, to: e.to });
  }
  return out;
}

function neighborsOf(nodes: readonly string[], ls: readonly Link[]): Map<string, string[]> {
  const adj = new Map(nodes.map((n) => [n, [] as string[]]));
  for (const { from, to } of ls) {
    adj.get(from)!.push(to);
    adj.get(to)!.push(from);
  }
  return adj;
}

/** Connected pieces, each in program order, in the order their first node appears. */
function components(nodes: readonly string[], ls: readonly Link[]): string[][] {
  const adj = neighborsOf(nodes, ls);
  const piece = new Map<string, number>();
  const pieces: string[][] = [];
  for (const root of nodes) {
    if (piece.has(root)) continue;
    const id = pieces.length;
    const members = new Set<string>([root]);
    piece.set(root, id);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) {
        if (piece.has(m)) continue;
        piece.set(m, id);
        members.add(m);
        queue.push(m);
      }
    }
    pieces.push(nodes.filter((n) => members.has(n)));
  }
  return pieces;
}

/**
 * The nodes in ring order if the graph is one ring (three or more nodes,
 * each linked to exactly two others, all connected), starting at `start`.
 */
export function ringOrder(
  nodes: readonly string[],
  edges: readonly LayoutEdge[],
  start?: string | null,
): string[] | null {
  if (nodes.length < 3) return null;
  const ls = links(nodes, edges);
  if (ls.length !== nodes.length) return null;
  const adj = neighborsOf(nodes, ls);
  if ([...adj.values()].some((ns) => ns.length !== 2)) return null;
  const outOf = new Map<string, string>();
  for (const e of edges) if (e.from !== e.to && !outOf.has(e.from)) outOf.set(e.from, e.to);
  const first = start && adj.has(start) ? start : nodes[0];
  const order = [first];
  const seen = new Set(order);
  let at = first;
  while (order.length < nodes.length) {
    // Follow the way the edges point when they do; otherwise the first neighbor listed.
    const ahead = outOf.get(at);
    const next =
      ahead && !seen.has(ahead) && adj.get(at)!.includes(ahead) ? ahead : adj.get(at)!.find((m) => !seen.has(m));
    if (next === undefined) return null; // two separate rings
    order.push(next);
    seen.add(next);
    at = next;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface Layering {
  /** Directed links after cycle breaking: from is above to. */
  down: Link[];
  /** Links ("from>to", as given) turned to point down. */
  back: Set<string>;
  /** Undirected links within one layer (an undirected graph's odd cycles). */
  flat: Link[];
  layer: Map<string, number>;
  /** The first node of each tree, top first: the start, then program order. */
  roots: string[];
}

/** Directed: break cycles from the start, then longest-path layers, sources pulled down to their children. */
function layerDirected(nodes: string[], ls: Link[], start: string | null): Layering {
  const out = new Map(nodes.map((n) => [n, [] as Link[]]));
  const indegree = new Map(nodes.map((n) => [n, 0]));
  for (const l of ls) {
    out.get(l.from)!.push(l);
    indegree.set(l.to, indegree.get(l.to)! + 1);
  }
  const order = [
    ...(start && out.has(start) ? [start] : []),
    ...nodes.filter((n) => n !== start && indegree.get(n) === 0),
    ...nodes.filter((n) => n !== start && indegree.get(n) !== 0),
  ];
  // Depth-first, without recursion: an edge to a node still on the walk closes a cycle.
  const state = new Map<string, 1 | 2>(); // 1 on the walk, 2 done
  const back = new Set<string>();
  const roots: string[] = [];
  for (const root of order) {
    if (state.has(root)) continue;
    roots.push(root);
    const stack: { node: string; next: number }[] = [{ node: root, next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = out.get(top.node)!;
      if (top.next >= edges.length) {
        state.set(top.node, 2);
        stack.pop();
        continue;
      }
      const l = edges[top.next++];
      const s = state.get(l.to);
      if (s === 1) back.add(`${l.from}>${l.to}`);
      else if (s === undefined) {
        state.set(l.to, 1);
        stack.push({ node: l.to, next: 0 });
      }
    }
  }
  const down = ls.map((l) => (back.has(`${l.from}>${l.to}`) ? { from: l.to, to: l.from } : l));

  // Longest path, in topological order (Kahn, program order among ties).
  const succ = new Map(nodes.map((n) => [n, [] as string[]]));
  const pred = new Map(nodes.map((n) => [n, [] as string[]]));
  for (const l of down) {
    succ.get(l.from)!.push(l.to);
    pred.get(l.to)!.push(l.from);
  }
  const remaining = new Map(nodes.map((n) => [n, pred.get(n)!.length]));
  const ready = nodes.filter((n) => remaining.get(n) === 0);
  const topo: string[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    topo.push(n);
    for (const m of succ.get(n)!) {
      remaining.set(m, remaining.get(m)! - 1);
      if (remaining.get(m) === 0) ready.push(m);
    }
  }
  const layer = new Map(nodes.map((n) => [n, 0]));
  for (const n of topo) for (const m of succ.get(n)!) layer.set(m, Math.max(layer.get(m)!, layer.get(n)! + 1));
  // A source sits just above its highest child, so its edges are short (not the start: it stays on top).
  for (const n of [...topo].reverse()) {
    if (n === start || pred.get(n)!.length || !succ.get(n)!.length) continue;
    layer.set(n, Math.min(...succ.get(n)!.map((m) => layer.get(m)!)) - 1);
  }
  return { down, back, flat: [], layer, roots };
}

/** Undirected: breadth-first distance from the start (then from each piece's first node). */
function layerUndirected(nodes: string[], ls: Link[], start: string | null): Layering {
  const adj = neighborsOf(nodes, ls);
  const layer = new Map<string, number>();
  const roots: string[] = [];
  for (const root of [...(start && adj.has(start) ? [start] : []), ...nodes]) {
    if (layer.has(root)) continue;
    roots.push(root);
    layer.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) {
        if (layer.has(m)) continue;
        layer.set(m, layer.get(n)! + 1);
        queue.push(m);
      }
    }
  }
  // Undirected edges have no way to point: each simply goes down.
  const down: Link[] = [];
  const flat: Link[] = [];
  for (const l of ls) {
    const a = layer.get(l.from)!;
    const b = layer.get(l.to)!;
    if (a === b) flat.push(l);
    else down.push(a < b ? l : { from: l.to, to: l.from });
  }
  return { down, back: new Set(), flat, layer, roots };
}

/** Is the layered graph a forest: nothing turned, nothing within a layer, at most one parent each. */
function isForest(nodes: string[], lay: Layering): boolean {
  if (lay.back.size || lay.flat.length) return false;
  const parents = new Map(nodes.map((n) => [n, 0]));
  for (const l of lay.down) parents.set(l.to, parents.get(l.to)! + 1);
  return [...parents.values()].every((p) => p <= 1);
}

// ---------------------------------------------------------------------------
// Ordering within layers
// ---------------------------------------------------------------------------

interface Grid {
  layers: string[][];
  /** Each node's neighbors in the layer above and below (placeholders included). */
  up: Map<string, string[]>;
  below: Map<string, string[]>;
  /** For each link that spans layers, its placeholders top to bottom. */
  chains: Map<Link, string[]>;
}

const isDummy = (n: string) => n.startsWith(DUMMY);

/** Layers with placeholders, in a first, depth-first order. */
function buildGrid(nodes: string[], lay: Layering): Grid {
  const up = new Map<string, string[]>(nodes.map((n) => [n, []]));
  const below = new Map<string, string[]>(nodes.map((n) => [n, []]));
  const chains = new Map<Link, string[]>();
  const layerOf = new Map(lay.layer);
  let count = 0;
  for (const l of lay.down) {
    const top = layerOf.get(l.from)!;
    const bottom = layerOf.get(l.to)!;
    const chain: string[] = [];
    for (let y = top + 1; y < bottom; y++) {
      const d = `${DUMMY}${count++}`;
      layerOf.set(d, y);
      up.set(d, []);
      below.set(d, []);
      chain.push(d);
    }
    const path = [l.from, ...chain, l.to];
    for (let i = 0; i + 1 < path.length; i++) {
      below.get(path[i])!.push(path[i + 1]);
      up.get(path[i + 1])!.push(path[i]);
    }
    chains.set(l, chain);
  }
  // Depth-first from the roots, children in program order: subtrees stay together.
  const depth = Math.max(0, ...layerOf.values()) + 1;
  const layers: string[][] = Array.from({ length: depth }, () => []);
  const seen = new Set<string>();
  const visit = (root: string) => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      layers[layerOf.get(n)!].push(n);
      const kids = below.get(n)!;
      for (let i = kids.length - 1; i >= 0; i--) if (!seen.has(kids[i])) stack.push(kids[i]);
    }
  };
  for (const r of lay.roots) visit(r);
  for (const n of nodes) visit(n);
  for (const n of up.keys()) visit(n);
  return { layers, up, below, chains };
}

/** Crossings between two neighboring layers. */
function crossingsBetween(upper: string[], lower: string[], below: Map<string, string[]>): number {
  const at = new Map(lower.map((n, i) => [n, i]));
  const ends: number[][] = [];
  upper.forEach((n, i) => {
    for (const m of below.get(n)!) ends.push([i, at.get(m)!]);
  });
  let count = 0;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if ((ends[i][0] - ends[j][0]) * (ends[i][1] - ends[j][1]) < 0) count++;
    }
  }
  return count;
}

function crossings(g: Grid): number {
  let total = 0;
  for (let i = 0; i + 1 < g.layers.length; i++) total += crossingsBetween(g.layers[i], g.layers[i + 1], g.below);
  return total;
}

/** The median of neighbor positions (the mean of the middle two when even), or null with no neighbors. */
function median(positions: number[]): number | null {
  if (!positions.length) return null;
  const sorted = [...positions].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Order a layer by its neighbors' median positions in `fixed`; nodes with none keep their place. */
function orderByMedian(layer: string[], fixed: string[], neighbors: Map<string, string[]>): string[] {
  const at = new Map(fixed.map((n, i) => [n, i]));
  const keys = layer.map((n, i) => {
    const m = median(neighbors.get(n)!.map((x) => at.get(x)!));
    // Mean as a tie-breaker, then the current place.
    const ns = neighbors.get(n)!;
    const mean = ns.length ? ns.reduce((s, x) => s + at.get(x)!, 0) / ns.length : 0;
    return { n, i, m, mean };
  });
  const movable = keys.filter((k) => k.m !== null).sort((a, b) => a.m! - b.m! || a.mean - b.mean || a.i - b.i);
  const result = layer.slice();
  let next = 0;
  for (let i = 0; i < layer.length; i++) if (keys[i].m !== null) result[i] = movable[next++].n;
  return result;
}

/** Crossings among the edges of u and v (u left of v) toward one neighboring layer. */
function pairCrossings(u: string, v: string, at: Map<string, number>, neighbors: Map<string, string[]>): number {
  let count = 0;
  for (const a of neighbors.get(u)!) for (const b of neighbors.get(v)!) if (at.get(a)! > at.get(b)!) count++;
  return count;
}

/** Swap neighbors in each layer while that removes crossings with the layers above and below. */
function transpose(g: Grid): void {
  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 20) {
    improved = false;
    for (let y = 0; y < g.layers.length; y++) {
      const layer = g.layers[y];
      const above = new Map((g.layers[y - 1] ?? []).map((n, i) => [n, i]));
      const under = new Map((g.layers[y + 1] ?? []).map((n, i) => [n, i]));
      for (let i = 0; i + 1 < layer.length; i++) {
        const [u, v] = [layer[i], layer[i + 1]];
        const now = pairCrossings(u, v, above, g.up) + pairCrossings(u, v, under, g.below);
        const swapped = pairCrossings(v, u, above, g.up) + pairCrossings(v, u, under, g.below);
        if (swapped < now) {
          layer[i] = v;
          layer[i + 1] = u;
          improved = true;
        }
      }
    }
  }
}

/** Reorder the layers to remove crossings; the best order found wins. */
function reduceCrossings(g: Grid): void {
  let best = g.layers.map((l) => l.slice());
  let bestCount = crossings(g);
  for (let sweep = 0; sweep < SWEEPS && bestCount > 0; sweep++) {
    if (sweep % 2 === 0) {
      for (let y = 1; y < g.layers.length; y++) g.layers[y] = orderByMedian(g.layers[y], g.layers[y - 1], g.up);
    } else {
      for (let y = g.layers.length - 2; y >= 0; y--) g.layers[y] = orderByMedian(g.layers[y], g.layers[y + 1], g.below);
    }
    transpose(g);
    const count = crossings(g);
    if (count < bestCount) {
      bestCount = count;
      best = g.layers.map((l) => l.slice());
    }
  }
  g.layers = best;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * Positions for one layer, in its order: as close as possible (weighted
 * least squares) to `want`, with at least `gaps[i]` between node i and i+1.
 * Exact, by pool adjacent violators on the positions less their minimum
 * offsets.
 */
export function placeInOrder(want: number[], weight: number[], gaps: number[]): number[] {
  const offset = [0];
  for (let i = 1; i < want.length; i++) offset.push(offset[i - 1] + gaps[i - 1]);
  // Blocks of nodes that end up packed together: their weighted mean target.
  const blocks: { sum: number; w: number; n: number }[] = [];
  want.forEach((x, i) => {
    blocks.push({ sum: (x - offset[i]) * weight[i], w: weight[i], n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.w <= b.sum / b.w) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, w: a.w + b.w, n: a.n + b.n });
    }
  });
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.w + offset[out.length]);
  return out;
}

function assignX(g: Grid): Map<string, number> {
  const x = new Map<string, number>();
  const half = (n: string) => (isDummy(n) ? DUMMY_HALF : REAL_HALF);
  for (const layer of g.layers) {
    let cursor = 0;
    layer.forEach((n, i) => {
      if (i) cursor += half(layer[i - 1]) + half(n);
      x.set(n, cursor);
    });
  }
  const sweep = (layer: string[], neighbors: (n: string) => string[]) => {
    if (!layer.length) return;
    const want = layer.map((n) => {
      const ns = neighbors(n);
      return ns.length ? ns.reduce((s, m) => s + x.get(m)!, 0) / ns.length : x.get(n)!;
    });
    const weight = layer.map((n) => (neighbors(n).length ? (isDummy(n) ? DUMMY_WEIGHT : 1) : 0.05));
    const gaps = layer.slice(1).map((n, i) => half(layer[i]) + half(n));
    placeInOrder(want, weight, gaps).forEach((v, i) => {
      x.set(layer[i], v);
    });
  };
  const L = g.layers;
  for (let round = 0; round < 8; round++) {
    for (let y = 1; y < L.length; y++) sweep(L[y], (n) => g.up.get(n)!);
    for (let y = L.length - 2; y >= 0; y--) sweep(L[y], (n) => g.below.get(n)!);
  }
  for (let round = 0; round < 4; round++) {
    for (let y = 0; y < L.length; y++) sweep(L[y], (n) => [...g.up.get(n)!, ...g.below.get(n)!]);
  }
  const min = Math.min(...x.values());
  for (const [n, v] of x) x.set(n, round(v - min));
  return x;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// The layouts
// ---------------------------------------------------------------------------

/** One connected piece, layered: positions from x = 0, and the bends of long edges. */
function layeredPiece(
  nodes: string[],
  ls: Link[],
  directed: boolean,
  start: string | null,
): { pos: Map<string, Point>; routes: Map<string, Point[]>; back: Set<string>; width: number } {
  const lay = directed ? layerDirected(nodes, ls, start) : layerUndirected(nodes, ls, start);
  const minLayer = Math.min(...nodes.map((n) => lay.layer.get(n)!));
  for (const n of nodes) lay.layer.set(n, lay.layer.get(n)! - minLayer);
  const g = buildGrid(nodes, lay);
  // A forest is crossing-free in depth-first order: keep it (children stay in program order).
  if (!isForest(nodes, lay)) reduceCrossings(g);
  const x = assignX(g);
  const yOf = new Map<string, number>();
  g.layers.forEach((layer, y) => {
    for (const n of layer) yOf.set(n, y);
  });
  const pos = new Map(nodes.map((n) => [n, { x: x.get(n)!, y: yOf.get(n)! }]));
  const routes = new Map<string, Point[]>();
  for (const [l, chain] of g.chains) {
    if (!chain.length) continue;
    const points = chain.map((d) => ({ x: x.get(d)!, y: yOf.get(d)! }));
    routes.set(`${l.from}>${l.to}`, points);
    routes.set(`${l.to}>${l.from}`, [...points].reverse());
  }
  return { pos, routes, back: lay.back, width: Math.max(0, ...x.values()) };
}

/** Layered, piece by piece, side by side; nodes with no edges in a block on the right. */
function layered(nodes: string[], edges: readonly LayoutEdge[], directed: boolean, start: string | null): GraphLayout {
  const ls = links(nodes, edges);
  const linked = new Set(ls.flatMap((l) => [l.from, l.to]));
  const result: GraphLayout = { pos: new Map(), mode: "layered", routes: new Map(), back: new Set() };
  let left = 0;
  let depth = 1;
  // The start's piece first.
  const pieces = components(
    nodes.filter((n) => linked.has(n)),
    ls,
  ).sort((a, b) => Number(b.includes(start ?? "\u0002")) - Number(a.includes(start ?? "\u0002")));
  for (const piece of pieces) {
    const members = new Set(piece);
    const own = ls.filter((l) => members.has(l.from));
    const laid = layeredPiece(piece, own, directed, start && members.has(start) ? start : null);
    for (const [n, p] of laid.pos) {
      result.pos.set(n, { x: round(p.x + left), y: p.y });
      depth = Math.max(depth, p.y + 1);
    }
    for (const [k, points] of laid.routes)
      result.routes.set(
        k,
        points.map((p) => ({ x: round(p.x + left), y: p.y })),
      );
    for (const k of laid.back) result.back.add(k);
    left += laid.width + 2 * REAL_HALF;
  }
  const alone = nodes.filter((n) => !linked.has(n));
  if (alone.length) {
    // A block as tall as the picture, filled row by row.
    const columns = Math.ceil(alone.length / depth);
    alone.forEach((n, i) => {
      result.pos.set(n, { x: round(left + (i % columns)), y: Math.floor(i / columns) });
    });
  }
  return result;
}

export function circle(order: readonly string[]): Map<string, Point> {
  if (order.length <= 2) return new Map(order.map((n, i) => [n, { x: i * 1.4, y: 0 }]));
  const r = Math.max(0.9, (order.length * 1.25) / (2 * Math.PI));
  return new Map(
    order.map((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / order.length;
      return [n, { x: round(r + r * Math.cos(a)), y: round(r + r * Math.sin(a)) }];
    }),
  );
}

/** Nodes with no edges: rows, about as wide as tall. */
function grid(nodes: readonly string[]): Map<string, Point> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.6)));
  return new Map(nodes.map((n, i) => [n, { x: i % columns, y: Math.floor(i / columns) }]));
}

/** Fruchterman-Reingold, started from a circle so it's the same every run. */
function force(nodes: string[], edges: readonly LayoutEdge[]): Map<string, Point> {
  const n = nodes.length;
  const start = circle(nodes);
  const p = nodes.map((node) => ({ ...start.get(node)! }));
  const index = new Map(nodes.map((node, i) => [node, i]));
  const pairs: [number, number][] = links(nodes, edges).map((l) => [index.get(l.from)!, index.get(l.to)!]);
  const k = 1;
  let t = Math.max(0.5, n / 6);
  const iterations = 300;
  for (let it = 0; it < iterations; it++) {
    const d = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-6) {
          dx = 0.01 * (i - j);
          dy = 0.01;
          dist = Math.hypot(dx, dy);
        }
        const f = (k * k) / dist;
        d[i].x += (dx / dist) * f;
        d[i].y += (dy / dist) * f;
        d[j].x -= (dx / dist) * f;
        d[j].y -= (dy / dist) * f;
      }
    }
    for (const [i, j] of pairs) {
      const dx = p[i].x - p[j].x;
      const dy = p[i].y - p[j].y;
      const dist = Math.max(1e-6, Math.hypot(dx, dy));
      const f = (dist * dist) / k;
      d[i].x -= (dx / dist) * f;
      d[i].y -= (dy / dist) * f;
      d[j].x += (dx / dist) * f;
      d[j].y += (dy / dist) * f;
    }
    // A little gravity keeps separate pieces from drifting apart.
    const cx = p.reduce((s, q) => s + q.x, 0) / n;
    const cy = p.reduce((s, q) => s + q.y, 0) / n;
    for (let i = 0; i < n; i++) {
      d[i].x -= (p[i].x - cx) * 0.08;
      d[i].y -= (p[i].y - cy) * 0.08;
      const len = Math.hypot(d[i].x, d[i].y);
      if (len > 0) {
        p[i].x += (d[i].x / len) * Math.min(len, t);
        p[i].y += (d[i].y / len) * Math.min(len, t);
      }
    }
    t = Math.max(0.01, t * 0.985);
  }
  // Turn the picture so its long side is horizontal.
  const cx = p.reduce((s, q) => s + q.x, 0) / n;
  const cy = p.reduce((s, q) => s + q.y, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const q of p) {
    sxx += (q.x - cx) ** 2;
    syy += (q.y - cy) ** 2;
    sxy += (q.x - cx) * (q.y - cy);
  }
  const angle = -0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const q of p) {
    const x = q.x - cx;
    const y = q.y - cy;
    q.x = x * cos - y * sin;
    q.y = x * sin + y * cos;
  }
  // One edge is about one unit long, and no two nodes sit closer than 0.9.
  const lengths = pairs.map(([i, j]) => Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
  const scale = lengths.length ? 1.15 / (lengths.reduce((a, b) => a + b, 0) / lengths.length) : 1;
  for (const q of p) {
    q.x *= scale;
    q.y *= scale;
  }
  for (let r = 0; r < 60; r++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[j].x - p[i].x;
        const dy = p[j].y - p[i].y;
        const dist = Math.hypot(dx, dy);
        if (dist >= 0.9) continue;
        const push = (0.9 - dist) / 2 + 0.001;
        const ux = dist > 1e-6 ? dx / dist : 1;
        const uy = dist > 1e-6 ? dy / dist : 0;
        p[i].x -= ux * push;
        p[i].y -= uy * push;
        p[j].x += ux * push;
        p[j].y += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const minX = Math.min(...p.map((q) => q.x));
  const minY = Math.min(...p.map((q) => q.y));
  return new Map(nodes.map((node, i) => [node, { x: round(p[i].x - minX), y: round(p[i].y - minY) }]));
}

/**
 * Would layers read well? Not for a dense graph. Directed: when cycle
 * breaking turns only a few edges, and most edges don't go both ways (a
 * graph whose edges mostly go both ways is really undirected). Undirected:
 * only a forest.
 */
function layersSuit(nodes: string[], edges: readonly LayoutEdge[], directed: boolean, start: string | null): boolean {
  const ls = links(nodes, edges);
  if (!ls.length || ls.length > 1.8 * nodes.length) return false;
  const forest = ls.length === nodes.length - components(nodes, ls).length;
  if (!directed) return forest;
  const one = new Set(edges.map((x) => `${x.from}>${x.to}`));
  const twoWay = ls.filter((l) => one.has(`${l.to}>${l.from}`)).length;
  if (twoWay * 2 > ls.length) return forest;
  const { back } = layerDirected(nodes, ls, start);
  return back.size <= Math.max(2, Math.ceil(ls.length * 0.3));
}

/** Does a directed graph go round in a loop (rather than being layers that happen to form a ring)? */
function cycles(nodes: string[], edges: readonly LayoutEdge[]): boolean {
  return layerDirected(nodes, links(nodes, edges), null).back.size > 0;
}

/** Lay out a graph (see the top of this file). */
export function computeLayout(nodes: string[], edges: readonly LayoutEdge[], options: LayoutOptions): GraphLayout {
  const { directed } = options;
  const mode = options.mode ?? "auto";
  const start = options.start && nodes.includes(options.start) ? options.start : null;
  if (nodes.length === 0) return emptyLayout("circle");
  const ring = ringOrder(nodes, edges, start);
  if (mode === "circle") return { ...emptyLayout("circle"), pos: circle(ring ?? nodes) };
  if (mode === "layered") return layered(nodes, edges, directed, start);
  if (mode === "auto") {
    if (ring && (!directed || cycles(nodes, edges))) return { ...emptyLayout("circle"), pos: circle(ring) };
    if (!links(nodes, edges).length)
      return { ...emptyLayout("circle"), pos: nodes.length <= 2 ? circle(nodes) : grid(nodes) };
    if (layersSuit(nodes, edges, directed, start)) return layered(nodes, edges, directed, start);
  }
  if (nodes.length <= 2) return { ...emptyLayout("circle"), pos: circle(nodes) };
  return { ...emptyLayout("force"), pos: force(nodes, edges) };
}

/** Crossings in a layered layout's order (for tests: layouts must not get worse). */
export function layeredCrossings(layout: GraphLayout, edges: readonly LayoutEdge[]): number {
  // Every segment between neighboring layers, bends included.
  const segments: [Point, Point][] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}>${e.to}` : `${e.to}>${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = layout.pos.get(e.from);
    const b = layout.pos.get(e.to);
    if (!a || !b) continue;
    const pts = [a, ...(layout.routes.get(`${e.from}>${e.to}`) ?? []), b];
    for (let i = 0; i + 1 < pts.length; i++) segments.push([pts[i], pts[i + 1]]);
  }
  let count = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (properlyCross(segments[i], segments[j])) count++;
    }
  }
  return count;
}

function properlyCross([a, b]: [Point, Point], [c, d]: [Point, Point]): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}
