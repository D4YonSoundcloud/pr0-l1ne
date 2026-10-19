/**
 * Binary trees in the memory view, laid out as one block: each node in its
 * in-order slot, at the height of its depth.
 */
import type { SceneTree } from "../../scene/memoryScene";
import type { Shape } from "./shapes";

/** Binary trees in the memory view: gap between in-order slots, and levels. */
export const TREE_GAP = 34;
export const LEVEL_GAP = 44;

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
  block.levelH = Math.max(...sizes.map((shape) => shape.h)) + LEVEL_GAP;
  const levels = Math.max(...[...block.nodes.values()].map((n) => n.depth)) + 1;
  block.w = block.inOrder.length * (block.slotW + TREE_GAP) - TREE_GAP;
  block.h = levels * block.levelH - LEVEL_GAP;
}
