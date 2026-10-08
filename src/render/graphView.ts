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
import { nodeSignature, type GraphData, type GraphLayout, type GraphOverlay } from "../trace/graph";
import { s, textWidth, uiTextWidth } from "./draw";

const NODE_H = 30;
const DOT = 18;               // an object node with nothing to show
const LABEL_SIZE = 12.5;
const MIN_UNIT = 80;
const LEGEND_H = 24;
const BADGE_R = 8;
const POINTER_ROOM = 26;      // under a node: ▲ and a name
const TOP_ROOM = 16;          // above a node: badges, dist labels

export interface GraphPicture {
  w: number;
  h: number;
  /** Center of each node, relative to the picture's top-left corner. */
  centers: Map<string, { x: number; y: number }>;
  draw(x: number, y: number, layer: SVGGElement): void;
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

interface Legend { cls: string; text: string }

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

export function graphPicture(graph: GraphData, layout: GraphLayout, overlay: GraphOverlay, options: GraphPictureOptions): GraphPicture {
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
    centers.set(key, { x: offsetX + padX + (p.x - minX) * unitX, y: padTop + (p.y - minY) * unitY });
  }

  return {
    w, h, centers,
    draw(x, y, layer) {
      const g = s("g", { class: ["graph", graph.directed && "is-directed"].filter(Boolean).join(" ") });
      const at = (key: string) => {
        const c = centers.get(key)!;
        return { x: x + c.x, y: y + c.y };
      };
      const prevGraph = options.prev?.graph;
      const prevOverlay = options.prev?.overlay;
      const prevEdges = prevGraph ? new Set(prevGraph.edges.map((e) => `${e.from}>${e.to}`)) : null;

      // Legend
      if (legend.length) {
        const lg = s("g", { class: "graph-legend" });
        let lx = x + 6;
        const ly = y + 11;
        for (const item of legend) {
          if (item.cls === "visited") lg.append(s("rect", { class: "swatch is-visited", x: lx, y: ly - 6, width: 14, height: 12, rx: 6 }));
          else if (item.cls === "frontier") lg.append(s("rect", { class: "swatch is-frontier", x: lx, y: ly - 6, width: 14, height: 12, rx: 6 }));
          else if (item.cls === "label") lg.append(s("rect", { class: "swatch is-label", x: lx, y: ly - 6, width: 14, height: 12, rx: 3 }));
          else lg.append(s("line", { class: `swatch is-${item.cls}`, x1: lx, x2: lx + 14, y1: ly, y2: ly }));
          lg.append(s("text", { x: lx + 19, y: ly, "dominant-baseline": "central" }, item.text));
          lx += uiTextWidth(item.text, 11.5) + 34;
        }
        g.append(lg);
      }

      // Edges. An undirected edge stored both ways is drawn once.
      const edgesG = s("g", { class: "graph-edges" });
      const labelsG = s("g", { class: "graph-edge-labels" });
      const drawn = new Set<string>();
      const all = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
      const edgeList = graph.edges.map((e) => ({ ...e, tree: false }));
      // Parent-map edges that aren't in the graph are still drawn.
      for (const key of [...overlay.treeEdges, ...overlay.pathEdges, ...overlay.chosenEdges]) {
        const [from, to] = key.split(">");
        if (!all.has(key) && !all.has(`${to}>${from}`) && centers.has(from) && centers.has(to)) {
          edgeList.push({ from, to, tree: true });
        }
      }
      for (const edge of edgeList) {
        if (!centers.has(edge.from) || !centers.has(edge.to) || !graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
        const pair = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
        const id = graph.directed ? `${edge.from}>${edge.to}` : pair;
        if (drawn.has(id)) continue;
        drawn.add(id);
        const forward = `${edge.from}>${edge.to}`;
        const backward = `${edge.to}>${edge.from}`;
        const inTree = overlay.treeEdges.has(forward) || (!graph.directed && overlay.treeEdges.has(backward));
        const onPath = overlay.pathEdges.has(forward) || (!graph.directed && overlay.pathEdges.has(backward));
        const chosen = overlay.chosenEdges.has(forward) || (!graph.directed && overlay.chosenEdges.has(backward));
        // In an undirected graph, a tree or path edge points the way it was taken.
        const flip = !graph.directed && (overlay.treeEdges.has(backward) || overlay.pathEdges.has(backward)) && !overlay.treeEdges.has(forward) && !overlay.pathEdges.has(forward);
        const from = flip ? edge.to : edge.from;
        const to = flip ? edge.from : edge.to;
        const a = at(from);
        const b = at(to);
        const isNew = !!prevEdges && !prevEdges.has(forward) && !(!graph.directed && prevEdges.has(backward)) && !edge.tree;
        const arrow = graph.directed || inTree || onPath;
        // Links that aren't edges of the graph (a union-find forest) are dashed.
        const cls = ["graph-edge", inTree && "is-tree", (onPath || chosen) && "is-path", isNew && "is-new", edge.tree && "is-extra"].filter(Boolean).join(" ");
        const marker = onPath ? "url(#arrow-path)" : inTree ? "url(#arrow-tree)" : graph.directed ? "url(#arrow-graph)" : null;
        let d: string;
        let mid: { x: number; y: number };
        if (from === to) {
          const top = a.y - sizes.get(from)!.h / 2;
          d = `M${a.x - 7},${top} C${a.x - 26},${top - 30} ${a.x + 26},${top - 30} ${a.x + 7},${top - 1}`;
          mid = { x: a.x, y: top - 24 };
        } else {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          // A directed edge that also goes the other way bows to one side.
          const bow = graph.directed && all.has(backward) ? 14 : 0;
          const nx = -dy / len;
          const ny = dx / len;
          const startCut = exitDistance(sizes.get(from)!, dx, dy);
          const endCut = exitDistance(sizes.get(to)!, -dx, -dy) + (arrow ? 1 : 0);
          const sx = a.x + (dx / len) * startCut + nx * bow * 0.5;
          const sy = a.y + (dy / len) * startCut + ny * bow * 0.5;
          const ex = b.x - (dx / len) * endCut + nx * bow * 0.5;
          const ey = b.y - (dy / len) * endCut + ny * bow * 0.5;
          if (bow) {
            const cx = (a.x + b.x) / 2 + nx * bow * 1.6;
            const cy = (a.y + b.y) / 2 + ny * bow * 1.6;
            d = `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`;
            mid = { x: (a.x + b.x) / 2 + nx * bow * 1.1, y: (a.y + b.y) / 2 + ny * bow * 1.1 };
          } else {
            d = `M${sx},${sy} L${ex},${ey}`;
            mid = { x: (sx + ex) / 2, y: (sy + ey) / 2 };
          }
        }
        edgesG.append(s("path", { d, class: cls, "marker-end": arrow ? marker : null }));
        if (edge.label !== undefined && edge.label !== "") {
          labelsG.append(s("text", { class: ["edge-label", isNew && "is-new"].filter(Boolean).join(" "), x: mid.x, y: mid.y, "text-anchor": "middle", "dominant-baseline": "central" }, edge.label));
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
        const cls = ["graph-node",
          overlay.visited.has(key) && "is-visited",
          overlay.frontier.has(key) && "is-frontier",
          overlay.pathNodes.has(key) && "is-path",
          changed && "is-changed",
          isNew && "is-new"].filter(Boolean).join(" ");
        const ng = s("g", { class: cls });
        const left = c.x - size.w / 2;
        const top = c.y - size.h / 2;
        if (changed) ng.append(s("rect", { class: "node-halo", x: left - 4, y: top - 4, width: size.w + 8, height: size.h + 8, rx: size.h / 2 + 4 }));
        ng.append(s("rect", { class: "node-body", x: left, y: top, width: size.w, height: size.h, rx: size.h / 2 }));
        if (label) {
          ng.append(s("text", { class: "node-text", x: c.x, y: c.y, "text-anchor": "middle", "dominant-baseline": "central" }, label));
        }
        const rank = overlay.frontier.get(key);
        if (rank !== undefined) {
          const bx = left + 2;
          const by = top - 1;
          ng.append(s("circle", { class: "frontier-badge", cx: bx, cy: by, r: BADGE_R }),
            s("text", { class: "frontier-badge-text", x: bx, y: by, "text-anchor": "middle", "dominant-baseline": "central" }, String(rank + 1)));
        }
        const text = overlay.labels.get(key);
        if (text !== undefined) {
          const tx = left + size.w - 2;
          const ty = top - 6;
          const tw = uiTextWidth(text, 11.5) + 8;
          ng.append(s("rect", { class: "node-label-bg", x: tx, y: ty - 8, width: tw, height: 16, rx: 3 }),
            s("text", { class: "node-label", x: tx + 4, y: ty, "dominant-baseline": "central" }, text));
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
        pointersG.append(s("g", {
          class: ["pointer", changed && "is-changed"].filter(Boolean).join(" "),
          "data-flip": `${options.flipKey}:${label}`, "data-x": Math.round(local.x), "data-y": Math.round(local.y),
        },
        s("path", { d: `M${c.x - 5},${py + 7} L${c.x},${py + 1} L${c.x + 5},${py + 7} z` }),
        s("text", { x: c.x, y: py + 18, "text-anchor": "middle" }, label)));
      }
      g.append(pointersG);
      layer.append(g);
    },
  };
}
