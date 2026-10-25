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
import {
  angledL,
  angledLayers,
  angledLayersSideways,
  arcOffset,
  assignTracks,
  type EdgeShape,
  edgePath,
  type LabelRequest,
  type LayerStep,
  placeLabels,
  type Rect,
  selfLoop,
} from "./graphEdges";

const NODE_H = 30;
const DOT = 18; // an object node with nothing to show
const LABEL_SIZE = 12.5;
const MIN_UNIT = 80;
const LEGEND_H = 24;
const BADGE_R = 8;
const POINTER_ROOM = 26; // under a node: ▲ and a name
const TOP_ROOM = 16; // above a node: badges, dist labels
const EDGE_LABEL_SIZE = 11; // styles.css, .edge-label

export interface GraphPicture {
  w: number;
  h: number;
  /** Center of each node, relative to the picture's top-left corner. */
  centers: Map<string, { x: number; y: number }>;
  draw(x: number, y: number, layer: Mark): void;
}

export interface GraphPictureOptions {
  /**
   * The window is taller than it is wide: a layered graph with a very wide
   * layer is drawn left to right (see sidewaysFits).
   */
  tall?: boolean;
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

/** A layered layout turned to run left to right: x and y swapped, bends too. */
function turned(layout: GraphLayout): GraphLayout {
  const swap = (p: { x: number; y: number }) => ({ x: p.y, y: p.x });
  return {
    ...layout,
    pos: new Map([...layout.pos].map(([key, p]) => [key, swap(p)])),
    routes: new Map([...layout.routes].map(([key, bends]) => [key, bends.map(swap)])),
  };
}

/**
 * Should a layered graph run left to right? When a hint asks (`sideways`);
 * or, by itself, when a layer is very wide (8 nodes or more, the picture
 * more than 2.5 times wider than tall) and the window is taller than wide,
 * where a tall picture fits better. In a wide window, top to bottom fits
 * better, so it stays.
 */
export function sidewaysFits(
  graph: GraphData,
  layout: GraphLayout,
  unitX: number,
  unitY: number,
  tall: boolean,
): boolean {
  if (layout.mode !== "layered") return false;
  if (graph.sideways) return true;
  if (!tall) return false;
  const perLayer = new Map<number, number>();
  for (const p of layout.pos.values()) perLayer.set(p.y, (perLayer.get(p.y) ?? 0) + 1);
  const widest = Math.max(0, ...perLayer.values());
  const xs = [...layout.pos.values()].map((p) => p.x);
  const width = (Math.max(...xs) - Math.min(...xs)) * unitX;
  const height = Math.max(1, perLayer.size - 1) * unitY;
  return widest >= 8 && width > 2.5 * height;
}

export function graphPicture(
  graph: GraphData,
  given: GraphLayout,
  overlay: GraphOverlay,
  options: GraphPictureOptions,
): GraphPicture {
  // Size the grid from every node the graph ever has (the layout), so the
  // picture keeps its size while the graph grows.
  const labelFor = (key: string) => graph.nodes.get(key) ?? (graph.objectNodes ? "" : key.slice(2));
  const sizes = new Map([...given.pos.keys()].map((key) => [key, nodeSize(labelFor(key), graph.objectNodes)]));
  const maxW = Math.max(NODE_H, ...[...sizes.values()].map((size) => size.w));
  const rowH = Math.max(76, NODE_H + TOP_ROOM + POINTER_ROOM + 8);
  // Left to right: the layers become columns (a node's width apart, plus
  // room for the edges between), and each layer's nodes a column of rows.
  const sideways = sidewaysFits(graph, given, Math.max(MIN_UNIT, maxW + 46), rowH, !!options.tall);
  const layout = sideways ? turned(given) : given;
  const unitX = sideways ? maxW + 64 : Math.max(MIN_UNIT, maxW + 46);
  const unitY = layout.mode === "layered" ? rowH : unitX;
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
      const drawable = edgeList.filter(
        (edge) =>
          centers.has(edge.from) && centers.has(edge.to) && graph.nodes.has(edge.from) && graph.nodes.has(edge.to),
      );
      const style = graph.edgeStyle;
      // Every node's box, for angled edges and labels to keep clear of.
      const boxes = new Map<string, Rect>(
        [...graph.nodes.keys()]
          .filter((key) => centers.has(key))
          .map((key) => {
            const c = at(key);
            const size = sizes.get(key)!;
            return [key, { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h }];
          }),
      );
      // Which way each edge is drawn (a tree or path edge of an undirected graph points the way it was taken).
      const direction = drawable.map((edge) => {
        const forward = `${edge.from}>${edge.to}`;
        const backward = `${edge.to}>${edge.from}`;
        const flip =
          !graph.directed &&
          (overlay.treeEdges.has(backward) || overlay.pathEdges.has(backward)) &&
          !overlay.treeEdges.has(forward) &&
          !overlay.pathEdges.has(forward);
        return flip ? { from: edge.to, to: edge.from } : { from: edge.from, to: edge.to };
      });
      // Angled edges in layers: each step between two layers gets a track in its gap.
      const layered = layout.mode === "layered";
      const unitPoints = (from: string, to: string) => [
        layout.pos.get(from)!,
        ...(layout.routes.get(`${from}>${to}`) ?? []),
        layout.pos.get(to)!,
      ];
      // A point's layer, and where it is along its layer (sideways: x is the layer).
      const layerAt = (p: { x: number; y: number }) => (sideways ? p.x : p.y);
      const along = (p: { x: number; y: number }) => (sideways ? place(p).y : place(p).x);
      const steps: LayerStep[] = [];
      if (style === "angled" && layered) {
        direction.forEach(({ from, to }, i) => {
          if (from === to) return;
          const pts = unitPoints(from, to);
          for (let k = 0; k + 1 < pts.length; k++) {
            if (layerAt(pts[k]) === layerAt(pts[k + 1])) continue;
            steps.push({
              edge: i,
              step: k,
              gap: Math.min(layerAt(pts[k]), layerAt(pts[k + 1])),
              x1: along(pts[k]),
              x2: along(pts[k + 1]),
            });
          }
        });
      }
      const tracks = assignTracks(steps);
      // Tracks run in the gap after a layer: below the ▲ names and above the
      // next layer's badges, or (sideways) between two columns of nodes.
      const trackAt = (gap: number, track: number) => {
        const count = tracks.count.get(gap) ?? 1;
        const [start, end] = sideways
          ? [place({ x: gap, y: minY }).x + maxW / 2 + 10, place({ x: gap + 1, y: minY }).x - maxW / 2 - 10]
          : [place({ x: minX, y: gap }).y + NODE_H / 2 + 10, place({ x: minX, y: gap + 1 }).y - NODE_H / 2 - 12];
        return Math.round(start + ((end - start) * (track + 1)) / (count + 1));
      };

      const labels: (LabelRequest & { cls: string })[] = [];
      drawable.forEach((edge, i) => {
        const { from, to } = direction[i];
        const forward = `${edge.from}>${edge.to}`;
        const backward = `${edge.to}>${edge.from}`;
        const inTree = overlay.treeEdges.has(forward) || (!graph.directed && overlay.treeEdges.has(backward));
        const onPath = overlay.pathEdges.has(forward) || (!graph.directed && overlay.pathEdges.has(backward));
        const chosen = overlay.chosenEdges.has(forward) || (!graph.directed && overlay.chosenEdges.has(backward));
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
        const shape = edgeShape(edge, from, to, arrow, i);
        edgesG.append(s("path", { d: shape.d, class: cls, "marker-end": arrow ? marker : null }));
        if (edge.label !== undefined && edge.label !== "") {
          labels.push({
            text: edge.label,
            w: textWidth(edge.label, EDGE_LABEL_SIZE) + 2,
            h: EDGE_LABEL_SIZE + 2,
            samples: shape.samples,
            cls: ["edge-label", isNew && "is-new"].filter(Boolean).join(" "),
          });
        }
      });

      function edgeShape(edge: LaneEdge, from: string, to: string, arrow: boolean, index: number): EdgeShape {
        if (from === to) return selfLoop(at(from), sizes.get(from)!, edge.lane);
        const a = at(from);
        const b = at(to);
        const twoWay = graph.directed && all.has(`${to}>${from}`);
        const back = graph.directed && !edge.tree && layout.back.has(`${edge.from}>${edge.to}`);
        let offset = laneOffset(edge.lane, edge.lanes, twoWay);
        const bends = style === "straight" ? [] : (layout.routes.get(`${from}>${to}`) ?? []).map(place);
        if (style === "angled" && !edge.tree) {
          const layers = unitPoints(from, to).map(layerAt);
          // In layers, unless both ends share a layer (an undirected graph's odd cycle): that's an L.
          if (layered && layers[0] !== layers[layers.length - 1]) {
            // Lanes side by side, across the way the edge runs.
            const pts = [a, ...bends, b].map((p) =>
              sideways ? { x: p.x, y: p.y + offset * 0.5 } : { x: p.x + offset * 0.5, y: p.y },
            );
            const route = sideways ? angledLayersSideways : angledLayers;
            return route(
              pts,
              (p) => layers[pts.indexOf(p)] ?? 0,
              sizes.get(from)!,
              sizes.get(to)!,
              trackAt,
              (step) => tracks.track.get(`${index}:${step}`),
              arrow,
            );
          }
          const others = [...boxes].filter(([key]) => key !== from && key !== to).map(([, box]) => box);
          return angledL(a, b, sizes.get(from)!, sizes.get(to)!, others, arrow);
        }
        if (!offset && back && !bends.length && style !== "straight") offset = BACK_BOW;
        if (!offset && !bends.length && style === "curved") offset = arcOffset(a, b);
        return edgePath(a, b, bends, sizes.get(from)!, sizes.get(to)!, offset, arrow);
      }

      // Weight labels last, where they cover no node and no other label.
      const legendBox: Rect[] = legend.length ? [{ x, y, w: legendW + 12, h: legendH }] : [];
      placeLabels(labels, [...boxes.values(), ...legendBox]).forEach((p, i) => {
        labelsG.append(
          s(
            "text",
            { class: labels[i].cls, x: p.x, y: p.y, "text-anchor": "middle", "dominant-baseline": "central" },
            labels[i].text,
          ),
        );
      });
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
