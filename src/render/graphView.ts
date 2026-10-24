/**
 * Drawing a graph (see trace/graph.ts), shared by the memory view and the
 * loop history.
 *
 *    ● seen   ◌ queue (1 = next)   ─ parent   dist
 *
 *        (A)──────(B) 1             filled: in a visited set
 *         │ ╲      │                dashed ring + number: waiting in the
 *        (C)  ╲───(D)①              queue / stack / heap, 1 comes out next
 *         ▲                         green arrows: a parent map (BFS tree)
 *         u                         ▲ name: a variable holding that node
 *
 * Node positions come from layoutFor(), which is the same for every step of
 * a run, so the picture never reshuffles while the algorithm runs: only the
 * marks on it change.
 */
import { type GraphData, type GraphLayout, type GraphOverlay, nodeSignature } from "../trace/graph";
import { s, textWidth, uiTextWidth } from "./draw";
import type { Mark } from "./drawing";

const NODE_H = 30;
const DOT = 18; // an object node with nothing to show
const LABEL_SIZE = 12.5;
const MIN_UNIT = 80;
const LEGEND_H = 24;
const BADGE_R = 8;
const POINTER_ROOM = 26; // under a node: ▲ and a name
const TOP_ROOM = 16; // above a node: badges, dist labels

export interface GraphPicture {
  w: number;
  h: number;
  /** Center of each node, relative to the picture's top-left corner. */
  centers: Map<string, { x: number; y: number }>;
  draw(x: number, y: number, layer: Mark): void;
}

export interface GraphPictureOptions {
  /** For animate.ts: pointer markers slide between nodes under this key. */
  flipKey: string;
  /** Compare with these to mark what changed. */
  prev?: { graph?: GraphData; overlay?: GraphOverlay } | null;
  legend?: boolean;
  /** Build the legend from all of these (so every loop row has the same one). */
  legendOverlays?: GraphOverlay[];
}

function nodeSize(label: string, objectNodes: boolean): { w: number; h: number } {
  if (objectNodes && !label) return { w: DOT, h: DOT };
  return { w: Math.max(NODE_H, textWidth(label, LABEL_SIZE) + 16), h: NODE_H };
}

/** Where a line from the node's center toward (dx, dy) leaves its outline. */
function exitDistance(size: { w: number; h: number }, dx: number, dy: number): number {
  const len = Math.hypot(dx, dy) || 1;
  const ux = Math.abs(dx / len);
  const uy = Math.abs(dy / len);
  const hw = size.w / 2 + 2;
  const hh = size.h / 2 + 2;
  return Math.min(ux > 1e-6 ? hw / ux : Infinity, uy > 1e-6 ? hh / uy : Infinity);
}

interface Legend {
  cls: string;
  text: string;
}

function legendItems(overlays: GraphOverlay[]): Legend[] {
  const union = <T>(pick: (o: GraphOverlay) => T[]) => [...new Set(overlays.flatMap(pick))];
  const visited = union((o) => o.visitedNames);
  const frontier = union((o) => (o.frontierName ? [o.frontierName] : []));
  const tree = union((o) => (o.treeName ? [o.treeName] : []));
  const path = union((o) => [o.pathName, o.chosenName].filter((n): n is string => !!n));
  const labels = union((o) => o.labelNames);
  const items: Legend[] = [];
  if (visited.length) items.push({ cls: "visited", text: visited.join(", ") });
  if (frontier.length) items.push({ cls: "frontier", text: `${frontier.join(", ")} (1 = next out)` });
  if (tree.length) items.push({ cls: "tree", text: tree.join(", ") });
  if (path.length) items.push({ cls: "path", text: path.join(", ") });
  if (labels.length) items.push({ cls: "label", text: labels.join(" · ") });
  return items;
}

/** To the nearest half pixel: layouts give fractions, and the picture moves as a whole (canvas/keep.ts). */
const half = (v: number) => Math.round(v * 2) / 2;

/** How far a back edge with no bends bows to its side, in pixels. */
const BACK_BOW = 18;
/** Between neighboring lanes of repeated edges, in pixels. */
const LANE_GAP = 14;

interface LaneEdge {
  from: string;
  to: string;
  label?: string;
  tree: boolean;
  /** Which of the edges between the same two nodes this is, and how many there are. */
  lane: number;
  lanes: number;
}

/**
 * The edges to draw, each with its lane. A directed edge listed twice is
 * two edges, side by side. An undirected graph lists each edge from both
 * ends: its edges between two nodes are as many as the end that lists
 * more, drawn from that end.
 */
export function edgeLanes(
  edges: readonly { from: string; to: string; label?: string }[],
  directed: boolean,
): Omit<LaneEdge, "tree">[] {
  const groups = new Map<string, { from: string; to: string; label?: string }[]>();
  for (const e of edges) {
    const key =
      directed || e.from === e.to ? `${e.from}>${e.to}` : e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const group = groups.get(key) ?? [];
    group.push(e);
    groups.set(key, group);
  }
  const out: Omit<LaneEdge, "tree">[] = [];
  for (const group of groups.values()) {
    let chosen = group;
    if (!directed && group[0].from !== group[0].to) {
      const first = group.filter((e) => e.from === group[0].from);
      const other = group.filter((e) => e.from !== group[0].from);
      chosen = other.length > first.length ? other : first;
    }
    chosen.forEach((e, lane) => {
      out.push({ ...e, lane, lanes: chosen.length });
    });
  }
  return out;
}

/** Sideways offset for a lane: lanes spread around the straight line; a two-way pair keeps to its own side. */
function laneOffset(lane: number, lanes: number, twoWay: boolean): number {
  if (twoWay) return 14 + lane * LANE_GAP;
  return (lane - (lanes - 1) / 2) * LANE_GAP;
}

/**
 * An edge from a to b: straight, bowed sideways by `offset`, or through
 * `bends` (a long edge in a layered layout) as a smooth curve. Cut where it
 * leaves each node's outline. `mid` is where its label goes.
 */
export function edgePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bends: { x: number; y: number }[],
  fromSize: { w: number; h: number },
  toSize: { w: number; h: number },
  offset: number,
  arrow: boolean,
): { d: string; mid: { x: number; y: number } } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const r = (v: number) => Math.round(v * 100) / 100;
  if (!bends.length) {
    const startCut = exitDistance(fromSize, dx, dy);
    const endCut = exitDistance(toSize, -dx, -dy) + (arrow ? 1 : 0);
    const sx = a.x + (dx / len) * startCut + nx * offset * 0.5;
    const sy = a.y + (dy / len) * startCut + ny * offset * 0.5;
    const ex = b.x - (dx / len) * endCut + nx * offset * 0.5;
    const ey = b.y - (dy / len) * endCut + ny * offset * 0.5;
    if (!offset) return { d: `M${r(sx)},${r(sy)} L${r(ex)},${r(ey)}`, mid: { x: (sx + ex) / 2, y: (sy + ey) / 2 } };
    const cx = (a.x + b.x) / 2 + nx * offset * 1.6;
    const cy = (a.y + b.y) / 2 + ny * offset * 1.6;
    return {
      d: `M${r(sx)},${r(sy)} Q${r(cx)},${r(cy)} ${r(ex)},${r(ey)}`,
      mid: { x: (a.x + b.x) / 2 + nx * offset * 1.1, y: (a.y + b.y) / 2 + ny * offset * 1.1 },
    };
  }
  // Through the bends, shifted sideways for a lane.
  const inner = bends.map((p) => ({ x: p.x + nx * offset, y: p.y + ny * offset }));
  const first = inner[0];
  const last = inner[inner.length - 1];
  const out = { x: first.x - a.x, y: first.y - a.y };
  const into = { x: b.x - last.x, y: b.y - last.y };
  const outLen = Math.hypot(out.x, out.y) || 1;
  const intoLen = Math.hypot(into.x, into.y) || 1;
  const startCut = exitDistance(fromSize, out.x, out.y);
  const endCut = exitDistance(toSize, -into.x, -into.y) + (arrow ? 1 : 0);
  const points = [
    { x: a.x + (out.x / outLen) * startCut, y: a.y + (out.y / outLen) * startCut },
    ...inner,
    { x: b.x - (into.x / intoLen) * endCut, y: b.y - (into.y / intoLen) * endCut },
  ];
  // Catmull-Rom through the points, as cubic Béziers.
  let d = `M${r(points[0].x)},${r(points[0].y)}`;
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p2.x)},${r(p2.y)}`;
  }
  // The label halfway along.
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let half = lengths.reduce((sum, l) => sum + l, 0) / 2;
  let mid = points[0];
  for (let i = 0; i < lengths.length; i++) {
    if (half <= lengths[i]) {
      const t = lengths[i] ? half / lengths[i] : 0;
      mid = {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
      break;
    }
    half -= lengths[i];
  }
  return { d, mid };
}

/** A self-loop: out of the node's right side and back in, further out for each extra one. */
function selfLoop(
  c: { x: number; y: number },
  size: { w: number; h: number },
  lane: number,
): {
  d: string;
  mid: { x: number; y: number };
} {
  const right = c.x + size.w / 2;
  const reach = 26 + lane * 12;
  const spread = 16 + lane * 6;
  return {
    d: `M${right},${c.y - 6} C${right + reach},${c.y - spread} ${right + reach},${c.y + spread} ${right + 1},${c.y + 6}`,
    mid: { x: right + reach * 0.75 + 8, y: c.y },
  };
}

export function graphPicture(
  graph: GraphData,
  layout: GraphLayout,
  overlay: GraphOverlay,
  options: GraphPictureOptions,
): GraphPicture {
  // Size the grid from every node the graph ever has (the layout), so the
  // picture keeps its size while the graph grows.
  const labelFor = (key: string) => graph.nodes.get(key) ?? (graph.objectNodes ? "" : key.slice(2));
  const sizes = new Map([...layout.pos.keys()].map((key) => [key, nodeSize(labelFor(key), graph.objectNodes)]));
  const maxW = Math.max(NODE_H, ...[...sizes.values()].map((size) => size.w));
  const unitX = Math.max(MIN_UNIT, maxW + 46);
  const unitY = layout.mode === "layered" ? Math.max(76, NODE_H + TOP_ROOM + POINTER_ROOM + 8) : unitX;
  const legend = options.legend === false ? [] : legendItems(options.legendOverlays ?? [overlay]);
  const legendH = legend.length ? LEGEND_H : 0;
  const padX = maxW / 2 + 22;
  const padTop = legendH + TOP_ROOM + NODE_H / 2 + 4;
  const xs = [...layout.pos.values()].map((p) => p.x);
  const ys = [...layout.pos.values()].map((p) => p.y);
  const spanX = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const spanY = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const minX = xs.length ? Math.min(...xs) : 0;
  const minY = ys.length ? Math.min(...ys) : 0;
  const legendW = legend.reduce((sum, item) => sum + uiTextWidth(item.text, 11.5) + 34, 0);
  const w = Math.max(spanX * unitX + 2 * padX, legendW + 12, 120);
  const h = padTop + spanY * unitY + NODE_H / 2 + POINTER_ROOM + 6;
  const offsetX = (w - (spanX * unitX + 2 * padX)) / 2;

  const centers = new Map<string, { x: number; y: number }>();
  for (const [key, p] of layout.pos) {
    centers.set(key, { x: half(offsetX + padX + (p.x - minX) * unitX), y: half(padTop + (p.y - minY) * unitY) });
  }

  return {
    w,
    h,
    centers,
    draw(x, y, layer) {
      const g = s("g", { class: ["graph", graph.directed && "is-directed"].filter(Boolean).join(" ") });
      const at = (key: string) => {
        const c = centers.get(key)!;
        return { x: x + c.x, y: y + c.y };
      };
      // A bend of a long edge (layout units) on the page.
      const place = (p: { x: number; y: number }) => ({
        x: x + half(offsetX + padX + (p.x - minX) * unitX),
        y: y + half(padTop + (p.y - minY) * unitY),
      });
      const prevGraph = options.prev?.graph;
      const prevOverlay = options.prev?.overlay;
      const prevEdges = prevGraph ? new Set(prevGraph.edges.map((e) => `${e.from}>${e.to}`)) : null;

      // Legend
      if (legend.length) {
        const lg = s("g", { class: "graph-legend" });
        let lx = x + 6;
        const ly = y + 11;
        for (const item of legend) {
          if (item.cls === "visited")
            lg.append(s("rect", { class: "swatch is-visited", x: lx, y: ly - 6, width: 14, height: 12, rx: 6 }));
          else if (item.cls === "frontier")
            lg.append(s("rect", { class: "swatch is-frontier", x: lx, y: ly - 6, width: 14, height: 12, rx: 6 }));
          else if (item.cls === "label")
            lg.append(s("rect", { class: "swatch is-label", x: lx, y: ly - 6, width: 14, height: 12, rx: 3 }));
          else lg.append(s("line", { class: `swatch is-${item.cls}`, x1: lx, x2: lx + 14, y1: ly, y2: ly }));
          lg.append(s("text", { x: lx + 19, y: ly, "dominant-baseline": "central" }, item.text));
          lx += uiTextWidth(item.text, 11.5) + 34;
        }
        g.append(lg);
      }

      // Edges. An undirected edge stored both ways is drawn once; repeated
      // edges and two-way pairs get lanes side by side (edgeLanes).
      const edgesG = s("g", { class: "graph-edges" });
      const labelsG = s("g", { class: "graph-edge-labels" });
      const all = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
      const edgeList: LaneEdge[] = edgeLanes(graph.edges, graph.directed).map((e) => ({ ...e, tree: false }));
      // Parent-map edges that aren't in the graph are still drawn.
      for (const key of [...overlay.treeEdges, ...overlay.pathEdges, ...overlay.chosenEdges]) {
        const [from, to] = key.split(">");
        if (!all.has(key) && !all.has(`${to}>${from}`) && centers.has(from) && centers.has(to)) {
          edgeList.push({ from, to, tree: true, lane: 0, lanes: 1 });
        }
      }
      for (const edge of edgeList) {
        if (
          !centers.has(edge.from) ||
          !centers.has(edge.to) ||
          !graph.nodes.has(edge.from) ||
          !graph.nodes.has(edge.to)
        )
          continue;
        const forward = `${edge.from}>${edge.to}`;
        const backward = `${edge.to}>${edge.from}`;
        const inTree = overlay.treeEdges.has(forward) || (!graph.directed && overlay.treeEdges.has(backward));
        const onPath = overlay.pathEdges.has(forward) || (!graph.directed && overlay.pathEdges.has(backward));
        const chosen = overlay.chosenEdges.has(forward) || (!graph.directed && overlay.chosenEdges.has(backward));
        // In an undirected graph, a tree or path edge points the way it was taken.
        const flip =
          !graph.directed &&
          (overlay.treeEdges.has(backward) || overlay.pathEdges.has(backward)) &&
          !overlay.treeEdges.has(forward) &&
          !overlay.pathEdges.has(forward);
        const from = flip ? edge.to : edge.from;
        const to = flip ? edge.from : edge.to;
        const isNew =
          !!prevEdges && !prevEdges.has(forward) && !(!graph.directed && prevEdges.has(backward)) && !edge.tree;
        const arrow = graph.directed || inTree || onPath;
        // Links that aren't edges of the graph (a union-find forest) are dashed.
        const cls = [
          "graph-edge",
          inTree && "is-tree",
          (onPath || chosen) && "is-path",
          isNew && "is-new",
          edge.tree && "is-extra",
        ]
          .filter(Boolean)
          .join(" ");
        const marker = onPath
          ? "url(#arrow-path)"
          : inTree
            ? "url(#arrow-tree)"
            : graph.directed
              ? "url(#arrow-graph)"
              : null;
        let shape: { d: string; mid: { x: number; y: number } };
        if (from === to) {
          shape = selfLoop(at(from), sizes.get(from)!, edge.lane);
        } else {
          // Sideways from the straight line, in pixels: lanes, two-way pairs, and back edges.
          const twoWay = graph.directed && all.has(backward);
          const back = graph.directed && !edge.tree && layout.back.has(`${edge.from}>${edge.to}`);
          const bends = (layout.routes.get(`${from}>${to}`) ?? []).map(place);
          let offset = laneOffset(edge.lane, edge.lanes, twoWay);
          if (!offset && back && !bends.length) offset = BACK_BOW;
          shape = edgePath(at(from), at(to), bends, sizes.get(from)!, sizes.get(to)!, offset, arrow);
        }
        edgesG.append(s("path", { d: shape.d, class: cls, "marker-end": arrow ? marker : null }));
        if (edge.label !== undefined && edge.label !== "") {
          labelsG.append(
            s(
              "text",
              {
                class: ["edge-label", isNew && "is-new"].filter(Boolean).join(" "),
                x: shape.mid.x,
                y: shape.mid.y,
                "text-anchor": "middle",
                "dominant-baseline": "central",
              },
              edge.label,
            ),
          );
        }
      }
      g.append(edgesG, labelsG);

      // Nodes
      const nodesG = s("g", { class: "graph-nodes" });
      for (const [key, label] of graph.nodes) {
        if (!centers.has(key)) continue;
        const c = at(key);
        const size = sizes.get(key) ?? nodeSize(label, graph.objectNodes);
        const isNew = !!prevGraph && !prevGraph.nodes.has(key);
        const changed = !isNew && !!prevOverlay && nodeSignature(prevOverlay, key) !== nodeSignature(overlay, key);
        const cls = [
          "graph-node",
          overlay.visited.has(key) && "is-visited",
          overlay.frontier.has(key) && "is-frontier",
          overlay.pathNodes.has(key) && "is-path",
          changed && "is-changed",
          isNew && "is-new",
        ]
          .filter(Boolean)
          .join(" ");
        const ng = s("g", { class: cls });
        const left = c.x - size.w / 2;
        const top = c.y - size.h / 2;
        if (changed)
          ng.append(
            s("rect", {
              class: "node-halo",
              x: left - 4,
              y: top - 4,
              width: size.w + 8,
              height: size.h + 8,
              rx: size.h / 2 + 4,
            }),
          );
        ng.append(s("rect", { class: "node-body", x: left, y: top, width: size.w, height: size.h, rx: size.h / 2 }));
        if (label) {
          ng.append(
            s(
              "text",
              { class: "node-text", x: c.x, y: c.y, "text-anchor": "middle", "dominant-baseline": "central" },
              label,
            ),
          );
        }
        const rank = overlay.frontier.get(key);
        if (rank !== undefined) {
          const bx = left + 2;
          const by = top - 1;
          ng.append(
            s("circle", { class: "frontier-badge", cx: bx, cy: by, r: BADGE_R }),
            s(
              "text",
              { class: "frontier-badge-text", x: bx, y: by, "text-anchor": "middle", "dominant-baseline": "central" },
              String(rank + 1),
            ),
          );
        }
        const text = overlay.labels.get(key);
        if (text !== undefined) {
          const tx = left + size.w - 2;
          const ty = top - 6;
          const tw = uiTextWidth(text, 11.5) + 8;
          ng.append(
            s("rect", { class: "node-label-bg", x: tx, y: ty - 8, width: tw, height: 16, rx: 3 }),
            s("text", { class: "node-label", x: tx + 4, y: ty, "dominant-baseline": "central" }, text),
          );
        }
        nodesG.append(ng);
      }
      g.append(nodesG);

      // Variables holding a node: ▲ name, under it. They slide when animated.
      const pointersG = s("g", { class: "pointers graph-pointers" });
      const prevPointer = new Map<string, string>();
      for (const [key, names] of prevOverlay?.pointers ?? []) for (const name of names) prevPointer.set(name, key);
      for (const [key, names] of overlay.pointers) {
        if (!centers.has(key) || !graph.nodes.has(key)) continue;
        const c = at(key);
        const size = sizes.get(key)!;
        const py = c.y + size.h / 2 + 2;
        const label = names.join(", ");
        const changed = !!prevOverlay && names.some((name) => prevPointer.get(name) !== key);
        const local = centers.get(key)!;
        pointersG.append(
          s(
            "g",
            {
              class: ["pointer", changed && "is-changed"].filter(Boolean).join(" "),
              "data-flip": `${options.flipKey}:${label}`,
              "data-x": Math.round(local.x),
              "data-y": Math.round(local.y),
            },
            s("path", { d: `M${c.x - 5},${py + 7} L${c.x},${py + 1} L${c.x + 5},${py + 7} z` }),
            s("text", { x: c.x, y: py + 18, "text-anchor": "middle" }, label),
          ),
        );
      }
      g.append(pointersG);
      layer.append(g);
    },
  };
}
