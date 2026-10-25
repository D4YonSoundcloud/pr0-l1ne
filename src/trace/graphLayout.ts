/**
 * Laying out a graph: where each node goes, and the bends of edges that
 * span more than one layer. Pure: data in, data out (graph.ts calls it once
 * per graph per run; render/graphView.ts draws the result).
 *
 *   layered   trees, DAGs, and directed graphs with a few cycles: the
 *             classic layered ("Sugiyama") pipeline below
 *   circle    a ring (each node linked to two others, all in one loop), a
 *             small dense graph (4 to 8 nodes, most pairs linked), a graph
 *             of one or two nodes, or a hint asking for it
 *   force     everything else (undirected graphs with cycles, bigger dense
 *             graphs): stress majorization (below), which looks like a
 *             force-directed layout but is tidier. "force" is still its name
 *             in hints.
 *   grid      nodes with no edges at all, in rows
 *
 * The stress layout ("force"): each connected piece on its own. Every pair
 * of nodes should be as far apart as the hops between them (one hop is
 * EDGE), near pairs mattering most; stress majorization moves each node in
 * turn to where that fits best. It has local minima, so it starts from a
 * few fixed places (classical scaling; circles in program order and in
 * breadth-first order) and keeps the one with the fewest crossings. The
 * picture is turned so its long side is horizontal, with the start at the
 * top left. Then straight edges are kept clear of nodes they don't touch:
 * nodes are nudged off them while that adds no crossings, and an edge still
 * in the way bends around the node (a route with one bend). The pieces are
 * packed in rows, the start's first; nodes with no edges go in a block last.
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
  /**
   * Edges drawn at right angles (a graph hint's `angled`): a stress layout
   * then lines nodes up in rows and columns, so most edges run straight
   * across or down.
   */
  angled?: boolean;
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

/** Half the room a node takes in its layer: a real node, or a placeholder. */
const half = (n: string) => (isDummy(n) ? DUMMY_HALF : REAL_HALF);

/** Positions by least squares (placeInOrder), sweeping up and down: balanced, but long edges may bend. */
function assignX(g: Grid): Map<string, number> {
  const x = new Map<string, number>();
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

/**
 * Positions by Brandes and Köpf ("Fast and simple horizontal coordinate
 * assignment", 2001): each node lines up with a median neighbor, long
 * edges first, so placeholder chains (long edges) run straight down. Four
 * passes (aligning up or down, packing left or right) are balanced by
 * taking the middle two of each node's four positions. Returns null if the
 * result breaks a minimum gap (the original packing step can, rarely).
 */
export function brandesKopf(
  layers: string[][],
  up: Map<string, string[]>,
  below: Map<string, string[]>,
): Map<string, number> | null {
  if (!layers.length) return new Map();
  const pos = new Map<string, number>();
  for (const layer of layers) for (const [i, n] of layer.entries()) pos.set(n, i);
  // Type 1 conflicts: a segment that isn't between two placeholders crossing one that is.
  const marked = new Set<string>();
  for (let i = 0; i + 1 < layers.length; i++) {
    const upper = layers[i];
    const lower = layers[i + 1];
    let k0 = 0;
    let l = 0;
    for (let l1 = 0; l1 < lower.length; l1++) {
      const v = lower[l1];
      const innerFrom = isDummy(v) ? up.get(v)!.find(isDummy) : undefined;
      if (l1 === lower.length - 1 || innerFrom !== undefined) {
        const k1 = innerFrom !== undefined ? pos.get(innerFrom)! : upper.length - 1;
        for (; l <= l1; l++) {
          const w = lower[l];
          for (const u of up.get(w)!) {
            const k = pos.get(u)!;
            if (k < k0 || k > k1) marked.add(`${u}\u0001${w}`);
          }
        }
        k0 = k1;
      }
    }
  }
  const conflict = (a: string, b: string) => marked.has(`${a}\u0001${b}`) || marked.has(`${b}\u0001${a}`);

  /** One pass: aligned toward the layer before (in `order`), packed toward the start of each layer. */
  const pass = (order: string[][], before: Map<string, string[]>): Map<string, number> => {
    const at = new Map<string, number>();
    for (const layer of order) for (const [i, n] of layer.entries()) at.set(n, i);
    const root = new Map<string, string>();
    const align = new Map<string, string>();
    for (const layer of order)
      for (const n of layer) {
        root.set(n, n);
        align.set(n, n);
      }
    for (let i = 1; i < order.length; i++) {
      let r = -1;
      for (const v of order[i]) {
        const ns = [...before.get(v)!].sort((a, b) => at.get(a)! - at.get(b)!);
        if (!ns.length) continue;
        const d = ns.length;
        for (const m of [...new Set([Math.floor((d - 1) / 2), Math.ceil((d - 1) / 2)])]) {
          if (align.get(v) !== v) continue;
          const u = ns[m];
          if (!conflict(u, v) && r < at.get(u)!) {
            align.set(u, v);
            root.set(v, root.get(u)!);
            align.set(v, root.get(v)!);
            r = at.get(u)!;
          }
        }
      }
    }
    // Pack the blocks (nodes aligned together) toward the start of each layer.
    const pred = new Map<string, string>();
    for (const layer of order)
      layer.forEach((n, i) => {
        if (i) pred.set(n, layer[i - 1]);
      });
    const sink = new Map<string, string>();
    const shift = new Map<string, number>();
    const x = new Map<string, number>();
    for (const layer of order)
      for (const n of layer) {
        sink.set(n, n);
        shift.set(n, Number.POSITIVE_INFINITY);
      }
    const place = (v: string) => {
      if (x.has(v)) return;
      x.set(v, 0);
      let w = v;
      do {
        const p = pred.get(w);
        if (p !== undefined) {
          const u = root.get(p)!;
          place(u);
          if (sink.get(v) === v) sink.set(v, sink.get(u)!);
          const gap = half(p) + half(w);
          if (sink.get(v) !== sink.get(u)) {
            shift.set(sink.get(u)!, Math.min(shift.get(sink.get(u)!)!, x.get(v)! - x.get(u)! - gap));
          } else x.set(v, Math.max(x.get(v)!, x.get(u)! + gap));
        }
        w = align.get(w)!;
      } while (w !== v);
    };
    for (const layer of order) for (const n of layer) if (root.get(n) === n) place(n);
    const out = new Map<string, number>();
    for (const layer of order)
      for (const n of layer) {
        const r = root.get(n)!;
        const s = shift.get(sink.get(r)!)!;
        out.set(n, x.get(r)! + (s < Number.POSITIVE_INFINITY ? s : 0));
      }
    return out;
  };

  const mirrored = (ls: string[][]) => ls.map((l) => [...l].reverse());
  const flip = (m: Map<string, number>) => new Map([...m].map(([n, v]) => [n, -v]));
  const passes = [
    pass(layers, up),
    flip(pass(mirrored(layers), up)),
    pass([...layers].reverse(), below),
    flip(pass(mirrored([...layers].reverse()), below)),
  ];
  // Line the four up on the narrowest: the left-packed ones by their left edge, the others by their right.
  const width = (m: Map<string, number>) => Math.max(...m.values()) - Math.min(...m.values());
  const narrowest = passes.reduce((a, b) => (width(b) < width(a) ? b : a));
  const lo = Math.min(...narrowest.values());
  const hi = Math.max(...narrowest.values());
  const lined = passes.map((m, k) => {
    const d = k % 2 === 0 ? lo - Math.min(...m.values()) : hi - Math.max(...m.values());
    return new Map([...m].map(([n, v]) => [n, v + d]));
  });
  const x = new Map<string, number>();
  for (const n of pos.keys()) {
    const v = lined.map((m) => m.get(n)!).sort((a, b) => a - b);
    x.set(n, (v[1] + v[2]) / 2);
  }
  for (const layer of layers) {
    for (let i = 1; i < layer.length; i++) {
      if (x.get(layer[i])! - x.get(layer[i - 1])! < half(layer[i - 1]) + half(layer[i]) - 1e-6) return null;
    }
  }
  const min = Math.min(...x.values());
  for (const [n, v] of x) x.set(n, round(v - min));
  return x;
}

/**
 * How well positions draw the layers: long edges that bend (a placeholder
 * chain not in a straight line), then how far edges lean in total.
 */
function placementCost(g: Grid, x: Map<string, number>): [number, number] {
  let bent = 0;
  for (const chain of g.chains.values()) {
    if (chain.length > 1 && chain.some((d) => Math.abs(x.get(d)! - x.get(chain[0])!) > 1e-6)) bent++;
  }
  let lean = 0;
  for (const [n, below] of g.below) for (const m of below) lean += Math.abs(x.get(n)! - x.get(m)!);
  return [bent, lean];
}

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
  // Brandes–Köpf keeps long edges straight; least squares balances better.
  // Whichever bends fewer long edges, then leans less, wins.
  const balanced = assignX(g);
  const straight = brandesKopf(g.layers, g.up, g.below);
  let x = balanced;
  if (straight) {
    const [bentS, leanS] = placementCost(g, straight);
    const [bentB, leanB] = placementCost(g, balanced);
    if (bentS < bentB || (bentS === bentB && leanS < leanB - 1e-6)) x = straight;
  }
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

// ---------------------------------------------------------------------------
// Stress (undirected graphs with cycles, dense graphs)
// ---------------------------------------------------------------------------

/** An edge's length in a stress layout, in units. */
const EDGE = 1.2;
/** How far a straight edge stays from a node it doesn't touch (center to line), in units. */
const CLEAR = 0.34;
/** Between separate pieces, in units. */
const PIECE_GAP = 1.2;

/** Hops between every pair of nodes in one connected piece (breadth-first from each). */
function hops(nodes: readonly string[], adj: Map<string, string[]>): number[][] {
  const index = new Map(nodes.map((n, i) => [n, i]));
  return nodes.map((root) => {
    const d = nodes.map(() => Number.POSITIVE_INFINITY);
    d[index.get(root)!] = 0;
    const queue = [root];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) {
        const j = index.get(m)!;
        if (d[j] !== Number.POSITIVE_INFINITY) continue;
        d[j] = d[index.get(n)!] + 1;
        queue.push(m);
      }
    }
    return d;
  });
}

/**
 * Classical multidimensional scaling: positions whose distances best match
 * `d`, from the top two eigenvectors of the double-centered squared
 * distances (power iteration from a fixed start, so always the same).
 */
function classicalScaling(d: number[][]): Point[] {
  const n = d.length;
  const sq = d.map((row) => row.map((v) => v * v));
  const rowMean = sq.map((row) => row.reduce((s, v) => s + v, 0) / n);
  const all = rowMean.reduce((s, v) => s + v, 0) / n;
  const b = sq.map((row, i) => row.map((v, j) => -0.5 * (v - rowMean[i] - rowMean[j] + all)));
  const axes: { v: number[]; value: number }[] = [];
  for (let k = 0; k < 2; k++) {
    let v = Array.from({ length: n }, (_, i) => Math.sin(i * 1.7 + k * 0.9 + 0.3));
    let value = 0;
    for (let it = 0; it < 300; it++) {
      const next = b.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
      // Without the axes already found.
      for (const axis of axes) {
        const dot = axis.v.reduce((s, x, j) => s + x * v[j], 0);
        for (let i = 0; i < n; i++) next[i] -= axis.value * dot * axis.v[i];
      }
      const len = Math.hypot(...next);
      if (len < 1e-12) {
        value = 0;
        break;
      }
      const unit = next.map((x) => x / len);
      const change = unit.reduce((s, x, i) => s + Math.abs(x - v[i]), 0);
      value = len;
      v = unit;
      if (change < 1e-9) break;
    }
    axes.push({ v, value });
  }
  return Array.from({ length: n }, (_, i) => ({
    x: axes[0].v[i] * Math.sqrt(Math.max(0, axes[0].value)),
    y: axes[1].v[i] * Math.sqrt(Math.max(0, axes[1].value)),
  }));
}

/** Stress majorization from `p` (moved in place): each node to where its distances fit best, in turn. */
function majorize(p: Point[], d: number[][], iterations: number): number {
  const n = p.length;
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let x = 0;
      let y = 0;
      let total = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const w = 1 / (d[i][j] * d[i][j]);
        const dx = p[i].x - p[j].x;
        const dy = p[i].y - p[j].y;
        const dist = Math.hypot(dx, dy) || 1e-9;
        x += w * (p[j].x + (d[i][j] * dx) / dist);
        y += w * (p[j].y + (d[i][j] * dy) / dist);
        total += w;
      }
      const nx = x / total;
      const ny = y / total;
      moved = Math.max(moved, Math.abs(nx - p[i].x) + Math.abs(ny - p[i].y));
      p[i].x = nx;
      p[i].y = ny;
    }
    if (moved < 1e-4) break;
  }
  // The stress left: how far the distances are from the hops, near pairs weighing most.
  let stress = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      stress += (Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y) - d[i][j]) ** 2 / (d[i][j] * d[i][j]);
    }
  }
  return stress;
}

/** Straight edges crossing each other, for positions by index. */
function straightCrossings(p: Point[], pairs: [number, number][]): number {
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i];
      const [c, e] = pairs[j];
      if (a === c || a === e || b === c || b === e) continue;
      if (properlyCross([p[a], p[b]], [p[c], p[e]])) count++;
    }
  }
  return count;
}

/**
 * One connected piece by stress majorization: every pair of nodes as far
 * apart as the hops between them (times EDGE), near pairs mattering most.
 * Stress has local minima, so it starts from a few fixed places (classical
 * scaling, and circles in program order and in breadth-first order from
 * the start) and keeps the result with the fewest crossings, then the
 * least stress. Always the same result.
 */
function stressPiece(nodes: string[], ls: Link[], start: string | null, angled = false): Map<string, Point> {
  const n = nodes.length;
  if (n === 1) return new Map([[nodes[0], { x: 0, y: 0 }]]);
  if (n === 2) return new Map(nodes.map((node, i) => [node, { x: i * EDGE, y: 0 }]));
  const adj = neighborsOf(nodes, ls);
  const d = hops(nodes, adj).map((row) => row.map((h) => h * EDGE));
  const index = new Map(nodes.map((node, i) => [node, i]));
  const pairs = ls.map((l): [number, number] => [index.get(l.from)!, index.get(l.to)!]);
  const big = n > 120;
  const starts: Point[][] = [classicalScaling(d)];
  if (!big) {
    const ring = (order: string[]) => {
      const at = circle(order);
      return nodes.map((node) => ({ ...at.get(node)! }));
    };
    starts.push(ring(nodes));
    const bfs: string[] = [];
    for (const root of [...(start ? [start] : []), ...nodes]) {
      if (bfs.includes(root)) continue;
      const queue = [root];
      bfs.push(root);
      while (queue.length) {
        for (const m of adj.get(queue.shift()!)!) {
          if (bfs.includes(m)) continue;
          bfs.push(m);
          queue.push(m);
        }
      }
    }
    starts.push(ring(bfs));
  }
  let best: { p: Point[]; crossings: number; stress: number } | null = null;
  for (const p of starts) {
    // Nodes in the same place (a path is a straight line): a little apart.
    p.forEach((q, i) => {
      q.y += Math.sin(i * 2.3) * 1e-3;
    });
    const stress = majorize(p, d, big ? 80 : 300);
    const crossings = straightCrossings(p, pairs);
    if (!best || crossings < best.crossings || (crossings === best.crossings && stress < best.stress - 1e-9)) {
      best = { p, crossings, stress };
    }
  }
  const p = best!.p;
  orient(p, start ? nodes.indexOf(start) : 0, pairs, angled);
  if (angled) {
    // Rows and columns: nodes nearly level (or nearly in line) share one.
    snap(
      p,
      (q) => q.x,
      (q, v) => {
        q.x = v;
      },
    );
    snap(
      p,
      (q) => q.y,
      (q, v) => {
        q.y = v;
      },
    );
  }
  separate(p, 0.9);
  return new Map(nodes.map((node, i) => [node, p[i]]));
}

/** Nearly equal coordinates (within 0.4 units of the next) made equal: their mean. */
function snap(p: Point[], get: (q: Point) => number, set: (q: Point, v: number) => void): void {
  const order = p.map((_, i) => i).sort((a, b) => get(p[a]) - get(p[b]) || a - b);
  let group: number[] = [];
  const flush = () => {
    const mean = group.reduce((sum, i) => sum + get(p[i]), 0) / group.length;
    for (const i of group) set(p[i], mean);
    group = [];
  };
  for (const i of order) {
    if (group.length && get(p[i]) - get(p[group[group.length - 1]]) > 0.4) flush();
    group.push(i);
  }
  if (group.length) flush();
}

/**
 * Turn a picture so it reads well: its edges along the axes when most of
 * them share directions a right angle apart (a grid comes out square, not
 * as a diamond), else its long side horizontal; wider than tall; and with
 * `first` (where the algorithm starts) toward the top left.
 */
function orient(p: Point[], first: number, pairs: readonly [number, number][], align = false): void {
  const n = p.length;
  const rotate = (angle: number) => {
    const cx = p.reduce((s, q) => s + q.x, 0) / n;
    const cy = p.reduce((s, q) => s + q.y, 0) / n;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const q of p) {
      const x = q.x - cx;
      const y = q.y - cy;
      q.x = x * cos - y * sin;
      q.y = x * sin + y * cos;
    }
  };
  // The edges' directions, four times over, so directions a right angle apart agree.
  let c4 = 0;
  let s4 = 0;
  for (const [i, j] of pairs) {
    const angle = Math.atan2(p[j].y - p[i].y, p[j].x - p[i].x);
    c4 += Math.cos(4 * angle);
    s4 += Math.sin(4 * angle);
  }
  const agreement = pairs.length ? Math.hypot(c4, s4) / pairs.length : 0;
  if (agreement > 0.5 || (align && agreement > 0.05)) rotate(-Math.atan2(s4, c4) / 4);
  else {
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
    rotate(-0.5 * Math.atan2(2 * sxy, sxx - syy));
  }
  const span = (pick: (q: Point) => number) => Math.max(...p.map(pick)) - Math.min(...p.map(pick));
  if (span((q) => q.y) > span((q) => q.x) + 1e-6) rotate(Math.PI / 2);
  const cx = p.reduce((s, q) => s + q.x, 0) / n;
  const cy = p.reduce((s, q) => s + q.y, 0) / n;
  if (first >= 0 && p[first].x > cx + 1e-6) for (const q of p) q.x = 2 * cx - q.x;
  if (first >= 0 && p[first].y > cy + 1e-6) for (const q of p) q.y = 2 * cy - q.y;
}

/** Push apart any two nodes closer than `gap`. */
function separate(p: Point[], gap: number): void {
  for (let r = 0; r < 60; r++) {
    let moved = false;
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const dx = p[j].x - p[i].x;
        const dy = p[j].y - p[i].y;
        const dist = Math.hypot(dx, dy);
        if (dist >= gap) continue;
        const push = (gap - dist) / 2 + 0.001;
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
}

/** The closest point to `c` on the segment a–b, and how far along it is (0 at a, 1 at b). */
function closestOn(a: Point, b: Point, c: Point): { at: Point; t: number; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
  const at = { x: a.x + dx * t, y: a.y + dy * t };
  return { at, t, dist: Math.hypot(c.x - at.x, c.y - at.y) };
}

/**
 * Straight edges that pass through (or graze) a node they don't touch.
 * Each is [edge, node].
 */
function edgesThroughNodes(pos: Map<string, Point>, ls: readonly Link[]): [Link, string][] {
  const hits: [Link, string][] = [];
  for (const l of ls) {
    const a = pos.get(l.from)!;
    const b = pos.get(l.to)!;
    for (const [node, c] of pos) {
      if (node === l.from || node === l.to) continue;
      const { t, dist } = closestOn(a, b, c);
      if (t > 0.02 && t < 0.98 && dist < CLEAR) hits.push([l, node]);
    }
  }
  return hits;
}

/**
 * Keep straight edges clear of the nodes they don't touch: first nudge
 * each such node off the edge (a few rounds), then bend any edge still in
 * the way around the node, as a route with one bend.
 */
function clearEdges(pos: Map<string, Point>, ls: readonly Link[]): Map<string, Point[]> {
  const straight = () => edgeCrossings({ pos, mode: "force", routes: new Map(), back: new Set() }, ls);
  const before = straight();
  // Nudge nodes off edges, a round at a time, as long as that adds no crossings.
  for (let round = 0; round < 20; round++) {
    const hits = edgesThroughNodes(pos, ls);
    if (!hits.length) break;
    const saved = new Map(pos);
    for (const [l, node] of hits) {
      const c = pos.get(node)!;
      const a = pos.get(l.from)!;
      const b = pos.get(l.to)!;
      const { at, dist } = closestOn(a, b, c);
      // Away from the line; straight across it if the node sits right on it.
      let ux = c.x - at.x;
      let uy = c.y - at.y;
      if (dist < 1e-6) {
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        ux = -(b.y - a.y) / len;
        uy = (b.x - a.x) / len;
      } else {
        ux /= dist;
        uy /= dist;
      }
      const push = CLEAR - dist + 0.02;
      pos.set(node, { x: c.x + ux * push, y: c.y + uy * push });
    }
    const list = [...pos.values()].map((q) => ({ ...q }));
    separate(list, 0.9);
    [...pos.keys()].forEach((node, i) => {
      pos.set(node, list[i]);
    });
    if (straight() > before) {
      for (const [node, q] of saved) pos.set(node, q);
      break;
    }
  }
  // Bend each edge still in the way around the node. Of the bends tried (each
  // side, further out each time), the best: clear of every node if one is,
  // then the fewest crossings, then the most room.
  const routes = new Map<string, Point[]>();
  /** How many other edges (as drawn so far) this edge would cross, drawn through `points`. */
  const crossingsWith = (edge: Link, points: Point[]) => {
    let count = 0;
    for (const other of ls) {
      if (
        other === edge ||
        other.from === edge.from ||
        other.from === edge.to ||
        other.to === edge.from ||
        other.to === edge.to
      )
        continue;
      const theirs = [pos.get(other.from)!, ...(routes.get(`${other.from}>${other.to}`) ?? []), pos.get(other.to)!];
      for (let i = 0; i + 1 < points.length; i++) {
        for (let j = 0; j + 1 < theirs.length; j++) {
          if (properlyCross([points[i], points[i + 1]], [theirs[j], theirs[j + 1]])) count++;
        }
      }
    }
    return count;
  };
  for (const [l, node] of edgesThroughNodes(pos, ls)) {
    const key = `${l.from}>${l.to}`;
    if (routes.has(key)) continue;
    const a = pos.get(l.from)!;
    const b = pos.get(l.to)!;
    const { at } = closestOn(a, b, pos.get(node)!);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    let best: { bend: Point; clear: boolean; crossings: number; room: number } | null = null;
    for (const out of [CLEAR + 0.3, CLEAR + 0.6, CLEAR + 1]) {
      for (const side of [1, -1]) {
        const bend = { x: round(at.x + nx * out * side), y: round(at.y + ny * out * side) };
        let room = Number.POSITIVE_INFINITY;
        for (const [other, c] of pos) {
          if (other === l.from || other === l.to) continue;
          room = Math.min(room, closestOn(a, bend, c).dist, closestOn(bend, b, c).dist);
        }
        const trial = { bend, clear: room >= CLEAR, crossings: crossingsWith(l, [a, bend, b]), room };
        if (
          !best ||
          (trial.clear && !best.clear) ||
          (trial.clear === best.clear &&
            (trial.crossings < best.crossings || (trial.crossings === best.crossings && trial.room > best.room)))
        ) {
          best = trial;
        }
      }
    }
    routes.set(key, [best!.bend]);
    routes.set(`${l.to}>${l.from}`, [best!.bend]);
  }
  return routes;
}

/**
 * Lay out piece by piece and pack the pieces in rows, the start's piece
 * first, then in the order they first appear; nodes with no edges go last,
 * in a block.
 */
function packPieces(
  nodes: string[],
  ls: Link[],
  start: string | null,
  layoutPiece: (piece: string[], own: Link[], start: string | null) => Map<string, Point>,
): Map<string, Point> {
  const linked = new Set(ls.flatMap((l) => [l.from, l.to]));
  const pieces = components(
    nodes.filter((n) => linked.has(n)),
    ls,
  ).sort((a, b) => Number(b.includes(start ?? "\u0002")) - Number(a.includes(start ?? "\u0002")));
  const laid = pieces.map((piece) => {
    const members = new Set(piece);
    const pos = layoutPiece(
      piece,
      ls.filter((l) => members.has(l.from)),
      start && members.has(start) ? start : null,
    );
    const xs = [...pos.values()].map((q) => q.x);
    const ys = [...pos.values()].map((q) => q.y);
    const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
    for (const [n, q] of pos) pos.set(n, { x: q.x - minX, y: q.y - minY });
    return { pos, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  });
  const alone = nodes.filter((n) => !linked.has(n));
  if (alone.length) {
    const g = grid(alone);
    laid.push({
      pos: g,
      w: Math.max(...[...g.values()].map((q) => q.x)),
      h: Math.max(...[...g.values()].map((q) => q.y)),
    });
  }
  // Rows about as wide as the pieces would be in a square, and never narrower than the widest.
  const area = laid.reduce((sum, piece) => sum + (piece.w + PIECE_GAP) * (piece.h + PIECE_GAP), 0);
  const rowWidth = Math.max(...laid.map((piece) => piece.w), Math.sqrt(area) * 1.5);
  const out = new Map<string, Point>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const piece of laid) {
    if (x > 0 && x + piece.w > rowWidth) {
      x = 0;
      y += rowH + PIECE_GAP;
      rowH = 0;
    }
    for (const [n, q] of piece.pos) out.set(n, { x: round(q.x + x), y: round(q.y + y) });
    x += piece.w + PIECE_GAP;
    rowH = Math.max(rowH, piece.h);
  }
  return out;
}

/** Stress layout for a whole graph: pieces packed, straight edges kept clear of nodes. */
function stress(nodes: string[], edges: readonly LayoutEdge[], start: string | null, angled = false): GraphLayout {
  const ls = links(nodes, edges);
  const pos = packPieces(nodes, ls, start, (piece, own, first) => stressPiece(piece, own, first, angled));
  const routes = clearEdges(pos, ls);
  for (const [n, q] of pos) pos.set(n, { x: round(q.x), y: round(q.y) });
  const minX = Math.min(...[...pos.values()].map((q) => q.x));
  const minY = Math.min(...[...pos.values()].map((q) => q.y));
  for (const [n, q] of pos) pos.set(n, { x: round(q.x - minX), y: round(q.y - minY) });
  for (const [k, bends] of routes)
    routes.set(
      k,
      bends.map((q) => ({ x: round(q.x - minX), y: round(q.y - minY) })),
    );
  return { pos, mode: "force", routes, back: new Set() };
}

/**
 * A small dense graph: a circle (in program order, or breadth-first from
 * the start) unless stress crosses fewer edges. Ties go to the circle.
 */
function denseCircleOrStress(nodes: string[], edges: readonly LayoutEdge[], start: string | null): GraphLayout {
  const ls = links(nodes, edges);
  const adj = neighborsOf(nodes, ls);
  const bfs: string[] = [];
  for (const root of [...(start ? [start] : []), ...nodes]) {
    if (bfs.includes(root)) continue;
    const queue = [root];
    bfs.push(root);
    while (queue.length) {
      for (const m of adj.get(queue.shift()!)!) {
        if (bfs.includes(m)) continue;
        bfs.push(m);
        queue.push(m);
      }
    }
  }
  const candidates: GraphLayout[] = [
    { ...emptyLayout("circle"), pos: circle(nodes) },
    { ...emptyLayout("circle"), pos: circle(bfs) },
    stress(nodes, edges, start),
  ];
  let best = candidates[0];
  for (const c of candidates.slice(1)) if (edgeCrossings(c, ls) < edgeCrossings(best, ls)) best = c;
  return best;
}

/** A small graph with most of its possible edges: a circle may show it best. */
function smallAndDense(nodes: string[], edges: readonly LayoutEdge[]): boolean {
  const n = nodes.length;
  if (n < 4 || n > 8) return false;
  const ls = links(nodes, edges);
  return components(nodes, ls).length === 1 && ls.length >= 0.6 * ((n * (n - 1)) / 2);
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
    // Right-angled edges suit rows and columns better than a circle.
    if (smallAndDense(nodes, edges) && !options.angled) return denseCircleOrStress(nodes, edges, start);
  }
  if (nodes.length <= 2) return { ...emptyLayout("circle"), pos: circle(nodes) };
  // "force" (a hint's name for it, and the mode graphView reads): stress, which looks like force but tidier.
  return stress(nodes, edges, start, options.angled);
}

/** Edges crossing each other in a layout, bends included (for tests: layouts must not get worse). */
export function edgeCrossings(layout: GraphLayout, edges: readonly LayoutEdge[]): number {
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
