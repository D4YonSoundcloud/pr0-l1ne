import { describe, expect, it } from "vitest";
import { dash, endDirection, flatten, parsePath, pathBounds } from "./path";

describe("parsePath", () => {
  it("reads every command PR0L1NE draws, absolute and relative", () => {
    // The memory view's box header: M, V, q, H, z.
    expect(parsePath("M10,40 V15 q0,-5 5,-5 H95 q5,0 5,5 V40 z")).toEqual([
      { op: "M", x: 10, y: 40 },
      { op: "L", x: 10, y: 15 },
      { op: "Q", cx: 10, cy: 10, x: 15, y: 10 },
      { op: "L", x: 95, y: 10 },
      { op: "Q", cx: 100, cy: 10, x: 100, y: 15 },
      { op: "L", x: 100, y: 40 },
      { op: "Z" },
    ]);
    expect(parsePath("M0,0 C10,0 20,10 20,20")).toEqual([
      { op: "M", x: 0, y: 0 },
      { op: "C", c1x: 10, c1y: 0, c2x: 20, c2y: 10, x: 20, y: 20 },
    ]);
  });

  it("treats numbers after a move as lines, and reads exponents and signs", () => {
    expect(parsePath("m1 2 3 4 h-1 v1e1 l.5-.5")).toEqual([
      { op: "M", x: 1, y: 2 },
      { op: "L", x: 4, y: 6 },
      { op: "L", x: 3, y: 6 },
      { op: "L", x: 3, y: 16 },
      { op: "L", x: 3.5, y: 15.5 },
    ]);
  });

  it("reflects control points for smooth curves (S, T)", () => {
    const s = parsePath("M0,0 C0,10 10,10 10,0 S20,-10 20,0");
    expect(s[2]).toEqual({ op: "C", c1x: 10, c1y: -10, c2x: 20, c2y: -10, x: 20, y: 0 });
    const t = parsePath("M0,0 Q5,10 10,0 T20,0");
    expect(t[2]).toEqual({ op: "Q", cx: 15, cy: -10, x: 20, y: 0 });
    // S and T with no curve before: the control point is the current point.
    expect(parsePath("M1,1 S2,2 3,3")[1]).toEqual({ op: "C", c1x: 1, c1y: 1, c2x: 2, c2y: 2, x: 3, y: 3 });
    expect(parsePath("M1,1 T3,3")[1]).toEqual({ op: "Q", cx: 1, cy: 1, x: 3, y: 3 });
    expect(parsePath("M0,0 c1,1 2,2 3,3 s1,1 2,2")[2]).toMatchObject({ op: "C", x: 5, y: 5 });
    expect(parsePath("M0,0 q1,1 2,0 t2,0")[2]).toMatchObject({ op: "Q", cx: 3, cy: -1, x: 4, y: 0 });
  });

  it("draws an arc (never used) as a straight line, and stops at junk", () => {
    expect(parsePath("M0,0 A5,5 0 0 1 10,0")).toEqual([
      { op: "M", x: 0, y: 0 },
      { op: "L", x: 10, y: 0 },
    ]);
    expect(parsePath("1 2 3")).toEqual([]);
    expect(parsePath("M0,0 Z 5")).toEqual([{ op: "M", x: 0, y: 0 }, { op: "Z" }]);
    expect(parsePath("M0,0 L5")).toEqual([{ op: "M", x: 0, y: 0 }]);
    expect(parsePath("")).toEqual([]);
  });
});

describe("flatten", () => {
  it("keeps lines, cuts curves into pieces, and closes closed paths", () => {
    const [square] = flatten(parsePath("M0,0 H10 V10 H0 Z"));
    expect(square.closed).toBe(true);
    expect(square.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ]);
    const [curve] = flatten(parsePath("M0,0 Q50,50 100,0"), 10);
    expect(curve.points.length).toBeGreaterThan(8);
    expect(curve.points.at(-1)).toEqual({ x: 100, y: 0 });
    const [cubic] = flatten(parsePath("M0,0 C0,10 10,10 10,0"));
    expect(cubic.points.length).toBeGreaterThanOrEqual(5);
  });

  it("splits subpaths, and lines with no move start where the pen is", () => {
    const lines = flatten(parsePath("M0,0 L1,0 M5,5 L6,5"));
    expect(lines).toHaveLength(2);
    expect(flatten([{ op: "L", x: 3, y: 4 }])[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ]);
    expect(flatten([{ op: "Q", cx: 1, cy: 1, x: 2, y: 0 }])[0].points[0]).toEqual({ x: 0, y: 0 });
    // A lone Z: nothing to close.
    expect(flatten([{ op: "Z" }])).toEqual([]);
  });
});

describe("dash", () => {
  const line = (length: number) => [
    {
      points: [
        { x: 0, y: 0 },
        { x: length, y: 0 },
      ],
    },
  ];
  const spans = (pieces: { x: number; y: number }[][]) =>
    pieces.map((p) => [Math.round(p[0].x * 100) / 100, Math.round(p.at(-1)!.x * 100) / 100]);

  it("cuts a line into dashes and gaps", () => {
    expect(spans(dash(line(20), [5, 3]))).toEqual([
      [0, 5],
      [8, 13],
      [16, 20],
    ]);
  });

  it("repeats an odd pattern twice, as SVG does, and starts at an offset", () => {
    expect(spans(dash(line(12), [2]))).toEqual([
      [0, 2],
      [4, 6],
      [8, 10],
    ]);
    expect(spans(dash(line(10), [4, 2], 3))).toEqual([
      [0, 1],
      [3, 7],
      [9, 10],
    ]);
    // An offset that lands in a gap.
    expect(spans(dash(line(10), [4, 2], 5))[0]).toEqual([1, 5]);
  });

  it("carries the pattern round corners, and restarts it for each subpath", () => {
    const corner = [
      {
        points: [
          { x: 0, y: 0 },
          { x: 3, y: 0 },
          { x: 3, y: 3 },
        ],
      },
    ];
    const pieces = dash(corner, [4, 1]);
    expect(pieces[0]).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
    ]);
    expect(dash([...line(4), ...line(4)], [3, 1])).toHaveLength(2);
  });

  it("draws a solid line for patterns that aren't dashes", () => {
    expect(dash(line(10), [])).toEqual([line(10)[0].points]);
    expect(dash(line(10), [0, 0])).toEqual([line(10)[0].points]);
    expect(dash(line(10), [-1, Number.NaN])).toEqual([line(10)[0].points]);
  });
});

describe("endDirection", () => {
  it("is where a path ends and which way it's going", () => {
    expect(endDirection(parsePath("M0,0 L10,0"))).toEqual({ x: 10, y: 0, angle: 0 });
    expect(endDirection(parsePath("M0,0 L0,10"))?.angle).toBeCloseTo(Math.PI / 2);
    // Curves: from the last control point.
    expect(endDirection(parsePath("M0,0 C0,10 10,10 10,0"))?.angle).toBeCloseTo(-Math.PI / 2);
    expect(endDirection(parsePath("M0,0 Q10,0 10,10"))?.angle).toBeCloseTo(Math.PI / 2);
    // A control point on the end point: use the one before.
    expect(endDirection(parsePath("M0,0 C10,0 10,0 10,0"))?.angle).toBeCloseTo(0);
    expect(endDirection(parsePath("M0,0 C10,0 10,0 10,0 C10,0 10,0 10,0"))?.angle).toBe(0);
    expect(endDirection(parsePath("M5,5 Q5,5 5,5"))).toEqual({ x: 5, y: 5, angle: 0 });
    expect(endDirection(parsePath("M0,0 L10,0 Z"))?.angle).toBeCloseTo(Math.PI);
    expect(endDirection([])).toBeNull();
    expect(endDirection(parsePath("M3,4"))).toEqual({ x: 3, y: 4, angle: 0 });
  });
});

describe("pathBounds", () => {
  it("covers points and control points", () => {
    expect(pathBounds(parsePath("M0,0 Q5,-10 10,0 C12,4 14,4 16,0 Z"))).toEqual({ x: 0, y: -10, w: 16, h: 14 });
    expect(pathBounds([])).toBeNull();
  });
});
