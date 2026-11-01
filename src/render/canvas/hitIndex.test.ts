import { describe, expect, it } from "vitest";
import { HitIndex } from "./hitIndex";
import type { PaintGroup, Rect } from "./paint";

const group = (bounds: Rect | null, extra: Partial<PaintGroup> = {}, children: PaintGroup[] = []): PaintGroup => ({
  kind: "group",
  alpha: 1,
  children,
  classes: "",
  parentClasses: "",
  bounds,
  ...extra,
});

/** What walking every group in drawing order finds last: what the index must agree with. */
function walk(root: PaintGroup, x: number, y: number, ok: (g: PaintGroup) => boolean): PaintGroup | null {
  let found: PaintGroup | null = null;
  const visit = (g: PaintGroup) => {
    const b = g.bounds;
    if (b && ok(g) && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) found = g;
    for (const c of g.children) if (c.kind === "group") visit(c);
  };
  visit(root);
  return found;
}

describe("HitIndex", () => {
  it("finds the topmost box under a point, as a walk through every group would", () => {
    const back = group({ x: 0, y: 0, w: 400, h: 300 }, { nodeKey: "back" });
    const front = group({ x: 100, y: 100, w: 50, h: 50 }, { nodeKey: "front" });
    const titled = group({ x: 120, y: 120, w: 10, h: 10 }, { title: "a cell" });
    const root = group(null, {}, [back, group(null, {}, [front, titled])]);
    const index = new HitIndex(root, (g) => !!(g.nodeKey || g.title));
    expect(index.at(120, 120, (g) => !!g.nodeKey)).toBe(front);
    expect(index.at(10, 10, (g) => !!g.nodeKey)).toBe(back);
    expect(index.at(125, 125, (g) => !!g.title)).toBe(titled);
    expect(index.at(125, 125)).toBe(titled);
    expect(index.at(1000, 1000)).toBeNull();
  });

  it("agrees with the walk for many boxes, big ones too, anywhere", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const boxes: PaintGroup[] = [];
    for (let i = 0; i < 400; i++) {
      const big = i % 50 === 0;
      boxes.push(
        group(
          {
            x: rand() * 20000 - 2000,
            y: rand() * 20000 - 2000,
            w: big ? 30000 : rand() * 600,
            h: big ? 500 : rand() * 400,
          },
          i % 3 ? { nodeKey: `n${i}` } : { title: `t${i}` },
        ),
      );
    }
    const root = group(null, {}, boxes);
    const index = new HitIndex(root, (g) => !!(g.nodeKey || g.title));
    for (let i = 0; i < 2000; i++) {
      const x = rand() * 24000 - 3000;
      const y = rand() * 24000 - 3000;
      expect(index.at(x, y, (g) => !!g.nodeKey)).toBe(walk(root, x, y, (g) => !!g.nodeKey));
      expect(index.at(x, y, (g) => !!g.title)).toBe(walk(root, x, y, (g) => !!g.title));
    }
  });
});
