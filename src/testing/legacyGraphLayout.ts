/**
 * The graph layout before trace/graphLayout.ts (October 2026), kept only so
 * graphLayout.test.ts can check the new one never draws more crossings on
 * the examples. Not used by the app.
 */
interface Edge {
  from: string;
  to: string;
}
type Pos = Map<string, { x: number; y: number }>;

function undirectedNeighbors(nodes: string[], edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map(nodes.map((n) => [n, new Set<string>()]));
  for (const e of edges) {
    if (e.from === e.to || !adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  return adj;
}

function dagLayers(nodes: string[], edges: Edge[]): Map<string, number> | null {
  const out = new Map(nodes.map((n) => [n, [] as string[]]));
  const indegree = new Map(nodes.map((n) => [n, 0]));
  for (const e of edges) {
    if (!out.has(e.from) || !out.has(e.to)) continue;
    if (e.from === e.to) return null;
    out.get(e.from)!.push(e.to);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }
  const depth = new Map(nodes.map((n) => [n, 0]));
  const ready = nodes.filter((n) => indegree.get(n) === 0);
  let seen = 0;
  while (ready.length) {
    const n = ready.shift()!;
    seen++;
    for (const m of out.get(n)!) {
      depth.set(m, Math.max(depth.get(m)!, depth.get(n)! + 1));
      indegree.set(m, indegree.get(m)! - 1);
      if (indegree.get(m) === 0) ready.push(m);
    }
  }
  return seen === nodes.length ? depth : null;
}

function forestLayers(nodes: string[], edges: Edge[]): Map<string, number> | null {
  const adj = undirectedNeighbors(nodes, edges);
  const unique = new Set<string>();
  for (const [n, set] of adj) for (const m of set) unique.add(n < m ? `${n}|${m}` : `${m}|${n}`);
  const depth = new Map<string, number>();
  let components = 0;
  for (const root of nodes) {
    if (depth.has(root)) continue;
    components++;
    depth.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n)!) {
        if (depth.has(m)) continue;
        depth.set(m, depth.get(n)! + 1);
        queue.push(m);
      }
    }
  }
  return unique.size === nodes.length - components ? depth : null;
}

function layered(nodes: string[], edges: Edge[], depth: Map<string, number>): Pos {
  const adj = undirectedNeighbors(nodes, edges);
  const levels: string[][] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    const d = depth.get(n)!;
    levels[d] ??= [];
    levels[d].push(n);
    for (const m of adj.get(n)!) if (depth.get(m)! > depth.get(n)!) visit(m);
  };
  for (const n of nodes) if (depth.get(n) === 0) visit(n);
  for (const n of nodes) visit(n);
  const x = new Map<string, number>();
  for (const level of levels) {
    level?.forEach((n, i) => {
      x.set(n, i);
    });
  }
  const neighborsIn = (n: string, level: number) => [...adj.get(n)!].filter((m) => depth.get(m) === level);
  const place = (level: string[], toward: number) => {
    const want = new Map(
      level.map((n) => {
        const ns = neighborsIn(n, toward);
        return [n, ns.length ? ns.reduce((sum, m) => sum + x.get(m)!, 0) / ns.length : x.get(n)!];
      }),
    );
    level.sort((a, b) => want.get(a)! - want.get(b)! || x.get(a)! - x.get(b)!);
    let cursor = Number.NEGATIVE_INFINITY;
    const placed = level.map((n) => {
      cursor = Math.max(want.get(n)!, cursor + 1);
      return cursor;
    });
    const shift = level.reduce((sum, n, i) => sum + placed[i] - want.get(n)!, 0) / Math.max(1, level.length);
    level.forEach((n, i) => {
      x.set(n, placed[i] - shift);
    });
  };
  for (let round = 0; round < 4; round++) {
    for (let d = 1; d < levels.length; d++) if (levels[d]) place(levels[d], d - 1);
    for (let d = levels.length - 2; d >= 0; d--) if (levels[d]) place(levels[d], d + 1);
  }
  const minX = Math.min(...x.values());
  return new Map(nodes.map((n) => [n, { x: x.get(n)! - minX, y: depth.get(n)! }]));
}

/** The old layered layout, or null where it wasn't layered (it drew those with force). */
export function legacyLayered(nodes: string[], edges: Edge[], directed: boolean): Pos | null {
  const layers = directed ? dagLayers(nodes, edges) : forestLayers(nodes, edges);
  if (!layers || !edges.length) return null;
  return layered(nodes, edges, layers);
}
