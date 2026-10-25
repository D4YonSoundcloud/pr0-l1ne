/**
 * The graph layouts before trace/graphLayout.ts (October 2026): layered, and
 * force-directed (replaced by stress in phase 2). Kept only so
 * graphLayout.test.ts can check the new ones never draw more crossings.
 * Not used by the app.
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

function legacyCircle(nodes: string[]): Pos {
  if (nodes.length <= 2) return new Map(nodes.map((n, i) => [n, { x: i * 1.4, y: 0 }]));
  const r = Math.max(0.9, (nodes.length * 1.25) / (2 * Math.PI));
  return new Map(
    nodes.map((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
      return [n, { x: r + r * Math.cos(a), y: r + r * Math.sin(a) }];
    }),
  );
}

/** Fruchterman-Reingold, started from a circle so it's the same every run. */
/** The old force-directed layout (Fruchterman-Reingold), for comparison only. */
export function legacyForce(nodes: string[], edges: readonly Edge[]): Pos {
  const n = nodes.length;
  const start = legacyCircle(nodes);
  const p = nodes.map((node) => ({ ...start.get(node)! }));
  const index = new Map(nodes.map((node, i) => [node, i]));
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (const e of edges) {
    if (e.from === e.to || !index.has(e.from) || !index.has(e.to)) continue;
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([index.get(e.from)!, index.get(e.to)!]);
  }
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
  return new Map(nodes.map((node, i) => [node, { x: p[i].x - minX, y: p[i].y - minY }]));
}
