/**
 * Binary trees in the memory view, laid out as one block: each node in its
 * column (its in-order slot, or a big tree's tidy one: scene/memoryScene.ts),
 * at the height of its depth.
 */
import type { SceneTree } from "../../scene/memoryScene";
import { onSpacingChange, spacing } from "../spacing";
import type { Shape } from "./shapes";

/** Binary trees in the memory view: gap between in-order slots, and levels. */
export let TREE_GAP = 34;
export let LEVEL_GAP = 44;
/**
 * The gap between in-order slots as used: never less than the lane inset,
 * since arrows between a tree's nodes run in those gaps (route.ts).
 */
export const treeGap = (): number => Math.max(TREE_GAP, spacing.gapPad);
// The Layout panel can change these (see render/spacing.ts).
onSpacingChange(() => {
  TREE_GAP = spacing.treeGap;
  LEVEL_GAP = spacing.treeLevelGap;
});

/** A binary tree from the scene, with the room its nodes need (measureBlock) and where it went. */
export interface TreeBlock extends SceneTree {
  slotW: number;
  levelH: number;
  w: number;
  h: number;
  origin?: { x: number; y: number };
}

export function measureBlock(block: TreeBlock, shapes: Map<string, Shape>): void {
  const sizes = block.inOrder.map((id) => shapes.get(id)!);
  block.slotW = Math.max(...sizes.map((shape) => shape.w));
  // Arrows into a node turn in above it (route.ts, TOP_GAP): levels leave room for that.
  const levelGap = Math.max(LEVEL_GAP, spacing.topGap + 8);
  block.levelH = Math.max(...sizes.map((shape) => shape.h)) + levelGap;
  const levels = Math.max(...[...block.nodes.values()].map((n) => n.depth)) + 1;
  // As many slots as its columns span (one per node in order, fewer laid out tidily).
  const columns = Math.max(...[...block.nodes.values()].map((n) => n.x)) + 1;
  block.w = Math.ceil(columns * (block.slotW + treeGap()) - treeGap());
  block.h = levels * block.levelH - levelGap;
}
