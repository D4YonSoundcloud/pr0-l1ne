/**
 * Graphs in the memory view: the object holding a graph (an adjacency list,
 * a matrix, a set of node objects) drawn as a box with the graph's picture
 * (graphView.ts) inside.
 */
import type { MemoryScene, SceneGraph } from "../../scene/memoryScene";
import { formatBytes } from "../../trace/memory";
import type { HeapObject } from "../../trace/types";
import { HEADER_H, s, uiTextWidth } from "../draw";
import { type GraphPicture, graphPicture } from "../graphView";
import { type Ctx, type Shape, sizeLabel } from "./shapes";

export interface GraphBox extends SceneGraph {
  picture: GraphPicture;
}

/** Where a graph's picture starts inside its box. */
export const GRAPH_BODY_Y = HEADER_H + 4;

/** The scene's graphs, each with its picture drawn, by the heap id each one is drawn in place of. */
export function graphBoxes(scene: MemoryScene): Map<string, GraphBox> {
  const boxes = new Map<string, GraphBox>();
  for (const [hostId, graph] of scene.graphs) {
    const picture = graphPicture(graph.graph, graph.layout, graph.overlay, {
      flipKey: `gptr:${graph.graph.id}`,
      prev: graph.previous,
      legendOverlays: graph.legendOverlays,
    });
    boxes.set(hostId, { ...graph, picture });
  }
  return boxes;
}

/** A graph's size: its container (and everything in it), or all its node objects. */
export function graphSize(box: GraphBox, ctx: Ctx): string | null {
  if (!ctx.sizes) return null;
  if (!box.graph.objectNodes) return sizeLabel(ctx, box.graph.hostId);
  const nodes = [...box.graph.nodes.keys()].map((id) => ({ kind: "ref" as const, id }));
  return `total ${formatBytes(ctx.sizes.of(nodes), ctx.sizes.approximate)}`;
}

export function graphShape(box: GraphBox, obj: HeapObject, isNew: boolean, size: string | null): Shape {
  const { graph, picture } = box;
  const kind = `${graph.directed ? "directed" : "undirected"} graph, ${graph.nodes.size} node${graph.nodes.size === 1 ? "" : "s"}`;
  const title = graph.objectNodes ? `${graph.name} objects: ${kind}` : `${obj.typeName}: ${kind}`;
  const sizeW = size ? uiTextWidth(size, 11.5) * 1.08 + 14 : 0;
  const w = Math.max(picture.w + 16, uiTextWidth(title, 12) + 28 + sizeW);
  const h = GRAPH_BODY_Y + picture.h + 4;
  return {
    w,
    h,
    inY: HEADER_H / 2,
    draw(x, y, layer) {
      const g = s("g", { class: ["box", "graph-box", isNew && "is-new"].filter(Boolean).join(" ") });
      g.append(
        s("rect", { class: "box-body", x, y, width: w, height: h, rx: 5 }),
        s("path", {
          class: "box-header",
          d: `M${x},${y + HEADER_H} V${y + 5} q0,-5 5,-5 H${x + w - 5} q5,0 5,5 V${y + HEADER_H} z`,
        }),
        s("text", { class: "box-title", x: x + 10, y: y + HEADER_H / 2, "dominant-baseline": "central" }, title),
      );
      if (size)
        g.append(
          s(
            "text",
            {
              class: "box-size",
              x: x + w - 9,
              y: y + HEADER_H / 2,
              "text-anchor": "end",
              "dominant-baseline": "central",
            },
            size,
          ),
        );
      picture.draw(x + Math.round((w - picture.w) / 2), y + GRAPH_BODY_Y, g);
      layer.append(g);
    },
  };
}
