import { describe, expect, it } from "vitest";
import { crosses, findFreeY, overlaps, roundedPath, routeEdges, type Point, type Rect } from "./route";

const box = (x: number, y: number, w = 100, h = 60): Rect => ({ x, y, w, h });
const segments = (points: Point[]) => points.slice(1).map((p, i) => [points[i], p] as const);
const isOrthogonal = (points: Point[]) => segments(points).every(([a, b]) => a.x === b.x || a.y === b.y);

describe("findFreeY", () => {
  it("keeps the wanted position when it's free", () => {
    expect(findFreeY(0, 50, 50, 10, [box(200, 0)], 20)).toBe(10);
  });

  it("moves down past everything in the way", () => {
    const obstacles = [box(0, 0, 100, 60), box(20, 70, 100, 40)];
    const y = findFreeY(0, 100, 50, 0, obstacles, 20);
    expect(y).toBe(130);
    expect(obstacles.some((o) => overlaps({ x: 0, y, w: 100, h: 50 }, o))).toBe(false);
  });
});

describe("routeEdges", () => {
  const S = box(0, 40);
  const T = box(200, 40);

  it("draws a straight arrow when the target is level", () => {
    const [route] = routeEdges([{ from: { x: 80, y: 60 }, source: S, target: T, entryY: 60 }], [S, T]);
    expect(route).toEqual([{ x: 80, y: 60 }, { x: 200, y: 60 }]);
  });

  it("turns once in the gap for a forward arrow at a different height", () => {
    const low = box(200, 200);
    const [route] = routeEdges([{ from: { x: 80, y: 60 }, source: S, target: low, entryY: 213 }], [S, low]);
    expect(isOrthogonal(route)).toBe(true);
    expect(route[route.length - 1]).toEqual({ x: 200, y: 213 });
    const laneX = route[1].x;
    expect(laneX).toBeGreaterThan(100);
    expect(laneX).toBeLessThan(200);
  });

  it("gives arrows sharing a gap separate lanes", () => {
    const a = box(0, 0), b = box(0, 100), t1 = box(200, 300), t2 = box(200, 400);
    const routes = routeEdges([
      { from: { x: 80, y: 20 }, source: a, target: t1, entryY: 313 },
      { from: { x: 80, y: 120 }, source: b, target: t2, entryY: 413 },
    ], [a, b, t1, t2]);
    expect(routes[0][1].x).not.toBe(routes[1][1].x);
  });

  it("u-turns on the right for a target in the same column", () => {
    const above = box(0, 0, 100, 40), below = box(0, 100, 100, 40);
    const [route] = routeEdges([{ from: { x: 80, y: 120 }, source: below, target: above, entryY: 13 }], [above, below]);
    expect(isOrthogonal(route)).toBe(true);
    expect(route[1].x).toBeGreaterThan(100);
    expect(route[route.length - 1]).toEqual({ x: 100, y: 13 }); // into the right edge
  });

  it("goes over the boxes in between for a target in an earlier column", () => {
    const left = box(0, 60), middle = box(200, 40, 100, 200), source = box(400, 60);
    const [route] = routeEdges([{ from: { x: 480, y: 80 }, source, target: left, entryY: 73 }], [left, middle, source]);
    expect(isOrthogonal(route)).toBe(true);
    for (const [a, b] of segments(route).slice(1)) expect(crosses(a, b, middle)).toBe(false);
    expect(Math.min(...route.map((p) => p.y))).toBeLessThan(40); // over the top
  });

  it("goes under when there's no room above", () => {
    const left = box(0, 4), middle = box(200, 4, 100, 200), source = box(400, 4);
    const [route] = routeEdges([{ from: { x: 480, y: 30 }, source, target: left, entryY: 17 }], [left, middle, source]);
    for (const [a, b] of segments(route).slice(1)) expect(crosses(a, b, middle)).toBe(false);
    expect(Math.max(...route.map((p) => p.y))).toBeGreaterThan(204);
  });

  it("spreads arrowheads arriving at the same side, keeping a level one straight", () => {
    const a = box(0, 0), b = box(0, 100), t = box(200, 0);
    const routes = routeEdges([
      { from: { x: 80, y: 13 }, source: a, target: t, entryY: 13 },
      { from: { x: 80, y: 120 }, source: b, target: t, entryY: 13 },
    ], [a, b, t]);
    expect(routes[0]).toHaveLength(2); // still straight
    const ends = routes.map((r) => r[r.length - 1].y);
    expect(ends[0]).not.toBe(ends[1]);
  });
});

describe("roundedPath", () => {
  it("rounds corners and keeps the end point", () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }]);
    expect(d).toBe("M0,0 L44,0 Q50,0 50,6 L50,50");
  });
});
