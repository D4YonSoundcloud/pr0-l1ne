/** The linked track: a linked list (nodes in fixed columns, links as arrows) or a binary tree, one per row. */

import { trackLinkKind } from "../../scene/arrowKinds";
import { valueKey } from "../../trace/diff";
import { type LinkedRow, treeDepths } from "../../trace/linked";
import { CELL_H, POINTER_H, pointerMarkers, s, valueCell } from "../draw";
import type { Mark } from "../drawing";
import { ARC_BOTTOM, ARC_TOP, EMPTY, LEVEL_H, NODE_GAP, nameLabel, SLOT_W, type TrackLayout } from "./shared";

/** One row of the linked track: nodes in fixed columns, links as arrows. */
export function drawTrack(
  g: Mark,
  arrowLayer: Mark,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
  size: string | null,
): void {
  const { track, valueW, nodeW } = layout;
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const placeOf = (id: string) => layout.places?.get(id) ?? { line: 0, column: track.order.indexOf(id) };
  const lineStep = layout.lineStep ?? 0;
  const firstCellsY = cellsY;
  const trackG = s("g", { class: "linked-track" });
  // One name for every line, at their middle.
  nameLabel(
    g,
    layout.x - 8,
    firstCellsY + (((layout.lines ?? 1) - 1) * lineStep) / 2 + CELL_H / 2,
    track.typeName,
    size,
  );

  track.order.forEach((id) => {
    const node = state.nodes.get(id);
    if (!node) return; // not reachable in this row
    const { line, column } = placeOf(id);
    const cellsY = firstCellsY + line * lineStep;
    const midY = cellsY + CELL_H / 2;
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const nodeG = s("g", {
      class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" "),
      "data-flip": `lnode:${id}`,
      "data-x": nx,
      "data-y": line * lineStep,
    });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: cellsY, w: valueW, changed: valueChanged }).el);

    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(
        s(
          "g",
          { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
          s("rect", { x: sx, y: cellsY, width: SLOT_W, height: CELL_H, rx: 3 }),
        ),
      );
      if (target === null) {
        // null / None: a slash through the slot.
        nodeG.append(
          s("line", { class: "null-slash", x1: sx + 4, y1: cellsY + CELL_H - 5, x2: sx + SLOT_W - 4, y2: cellsY + 5 }),
        );
        return;
      }
      const cx = sx + SLOT_W / 2;
      nodeG.append(s("circle", { class: "ref-dot", cx, cy: midY, r: 3.5 }));
      const tColumn = placeOf(target).column;
      const tx = columnX(tColumn);
      const span = Math.abs(tColumn - column);
      let d: string;
      if (track.links.length === 1 && tColumn === column + 1) {
        d = `M${cx},${midY} L${tx - 2},${midY}`;
      } else if (k === 0) {
        // Over the top, into the top of the target's value cell.
        const top = cellsY - Math.min(ARC_TOP - 6, 12 + span * 4);
        const ex = tColumn === column ? tx + valueW / 2 - 6 : tx + valueW / 2;
        d = `M${cx},${cellsY} C${cx},${top} ${ex},${top} ${ex},${cellsY - 2}`;
      } else {
        // A second link (e.g. right) goes underneath.
        const bottom = cellsY + CELL_H + Math.min(ARC_BOTTOM + POINTER_H - 6, 14 + span * 4);
        // Land left of center, clear of the pointer markers under the node.
        const ex = tx + Math.min(8, valueW / 4);
        d = `M${cx},${cellsY + CELL_H} C${cx},${bottom} ${ex},${bottom} ${ex},${cellsY + CELL_H + 2}`;
      }
      // Its kind, for Style → Arrow colors: a link closes a loop when following
      // the same field from where it points leads back here.
      let closes = false;
      for (let at: string | null = target, n = 0; at !== null && n <= track.order.length; n++) {
        if (at === id) {
          closes = true;
          break;
        }
        at = state.nodes.get(at)?.links[k] ?? null;
      }
      const kind = trackLinkKind(track.links[k], "list", closes);
      arrowLayer.append(
        s("path", {
          d,
          class: ["link-arrow", `kind-${kind}`, linkChanged && "is-changed"].filter(Boolean).join(" "),
          "marker-end": linkChanged ? "url(#arrow-change)" : `url(#arrow-kind-${kind})`,
        }),
      );
    });
    trackG.append(nodeG);
  });

  // Variables that point at nodes, as markers under the node they point at.
  const pointers = state.pointers.map((p) => {
    const was = prev?.pointers.find((q) => q.name === p.name);
    return { ...p, changed: !!prev && was?.index !== p.index };
  });
  // Under each line, the markers for its nodes (pointers carry track.order columns).
  for (let line = 0; line < (layout.lines ?? 1); line++) {
    const here = pointers.flatMap((p) => {
      const id = track.order[p.index];
      if (id === undefined) return line === 0 && !layout.places ? [p] : []; // past the end
      const place = placeOf(id);
      return place.line === line ? [{ ...p, index: place.column }] : [];
    });
    if (!here.length) continue;
    const y = firstCellsY + line * lineStep;
    const count = layout.places
      ? Math.max(...[...layout.places.values()].filter((p) => p.line === line).map((p) => p.column)) + 1
      : track.order.length;
    trackG.append(
      pointerMarkers(here, columnX, valueW, y + CELL_H, count, { key: `tptr${line}`, originX: 0, originY: y }),
    );
  }
  g.append(trackG);
}

/**
 * One row of a binary tree, drawn top-down: x is the node's in-order column
 * (the same in every row), y is its depth.
 */
export function drawTree(
  g: Mark,
  layout: TrackLayout,
  state: LinkedRow,
  prev: LinkedRow | null,
  cellsY: number,
  size: string | null,
): void {
  const { track, valueW, nodeW } = layout;
  const depths = treeDepths(state);
  const columnX = (index: number) => layout.x + index * (nodeW + NODE_GAP);
  const nodeY = (id: string) => cellsY + (depths.get(id) ?? 0) * LEVEL_H;
  const trackG = s("g", { class: "linked-track tree" });
  // Edges go behind the nodes and labels, so labels stay readable.
  const edgesG = s("g", { class: "tree-edges" });
  g.append(edgesG);
  nameLabel(g, layout.x - 8, cellsY + CELL_H / 2, track.typeName, size);

  track.order.forEach((id, column) => {
    const node = state.nodes.get(id);
    if (!node) return;
    const before = prev?.nodes.get(id);
    const nx = columnX(column);
    const ny = nodeY(id);
    const nodeG = s("g", {
      class: ["linked-node", prev && !before && "is-new"].filter(Boolean).join(" "),
      "data-flip": `lnode:${id}`,
      "data-x": nx,
      "data-y": ny - cellsY,
    });
    const valueChanged = !!before && valueKey(before.value ?? EMPTY) !== valueKey(node.value ?? EMPTY);
    nodeG.append(valueCell(node.value ?? EMPTY, { x: nx, y: ny, w: valueW, changed: valueChanged }).el);
    node.links.forEach((target, k) => {
      const sx = nx + valueW + k * SLOT_W;
      const linkChanged = !!before && before.links[k] !== target;
      nodeG.append(
        s(
          "g",
          { class: ["cell", "link-slot", linkChanged && "is-changed"].filter(Boolean).join(" ") },
          s("rect", { x: sx, y: ny, width: SLOT_W, height: CELL_H, rx: 3 }),
        ),
      );
      if (target === null) {
        nodeG.append(
          s("line", { class: "null-slash", x1: sx + 4, y1: ny + CELL_H - 5, x2: sx + SLOT_W - 4, y2: ny + 5 }),
        );
        return;
      }
      nodeG.append(s("circle", { class: "ref-dot", cx: sx + SLOT_W / 2, cy: ny + CELL_H / 2, r: 3.5 }));
      // From the bottom of the slot down to the top of the child.
      const tx = columnX(track.order.indexOf(target)) + valueW / 2;
      const ty = nodeY(target);
      const from = { x: sx + SLOT_W / 2, y: ny + CELL_H };
      const d =
        ty > from.y
          ? `M${from.x},${from.y} C${from.x},${from.y + 18} ${tx},${ty - 18} ${tx},${ty - 2}`
          : `M${from.x},${from.y} C${from.x},${from.y + 30} ${tx},${ty - 30} ${tx},${ty - 2}`;
      const kind = trackLinkKind(track.links[k], "tree", false);
      edgesG.append(
        s("path", {
          d,
          class: ["link-arrow", `kind-${kind}`, linkChanged && "is-changed"].filter(Boolean).join(" "),
          "marker-end": linkChanged ? "url(#arrow-change)" : `url(#arrow-kind-${kind})`,
        }),
      );
    });
    trackG.append(nodeG);
  });

  // Pointer markers under the node they point at, at that node's depth.
  const byDepth = new Map<number, { name: string; index: number; changed: boolean }[]>();
  for (const p of state.pointers) {
    const depth = depths.get(track.order[p.index]) ?? 0;
    const was = prev?.pointers.find((q) => q.name === p.name);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), { ...p, changed: !!prev && was?.index !== p.index }]);
  }
  for (const [depth, pointers] of byDepth) {
    trackG.append(
      pointerMarkers(pointers, columnX, valueW, cellsY + depth * LEVEL_H + CELL_H, track.order.length, {
        key: "tptr",
        originX: 0,
        originY: cellsY,
      }),
    );
  }
  g.append(trackG);
}
