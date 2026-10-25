import { describe, expect, it } from "vitest";
import { angledL, angledLayers, assignTracks, edgePath, placeLabels, selfLoop } from "./graphEdges";

const size = { w: 30, h: 30 };

describe("edge shapes", () => {
  it("cut straight edges at the node outlines, and sample along them", () => {
    const shape = edgePath({ x: 0, y: 0 }, { x: 100, y: 0 }, [], size, size, 0, false);
    expect(shape.d).toBe("M17,0 L83,0");
    expect(shape.samples).toEqual([
      { x: 17, y: 0 },
      { x: 83, y: 0 },
    ]);
  });

  it("curve through bends, with samples from start to end", () => {
    const shape = edgePath({ x: 0, y: 0 }, { x: 0, y: 200 }, [{ x: 40, y: 100 }], size, size, 0, true);
    expect(shape.d).toMatch(/^M[\d.,-]+ C.* C/);
    expect(shape.samples[0].y).toBeGreaterThan(0);
    expect(shape.samples.at(-1)!.y).toBeLessThan(200);
    expect(shape.samples.some((p) => Math.abs(p.x - 40) < 1 && Math.abs(p.y - 100) < 1)).toBe(true);
  });

  it("loop a self-loop off the node's right side", () => {
    const shape = selfLoop({ x: 0, y: 0 }, size, 0);
    expect(Math.min(...shape.samples.map((p) => p.x))).toBeGreaterThanOrEqual(15);
  });
});

describe("right angles", () => {
  it("make an L that goes round the way with no node in it", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 200 };
    // A node where the across-first L would turn: it goes down first instead.
    const shape = angledL(a, b, size, size, [{ x: 185, y: -15, w: 30, h: 30 }], false);
    expect(shape.samples[1]).toEqual({ x: 0, y: 200 });
    // Nothing in the way: across first.
    expect(angledL(a, b, size, size, [], false).samples[1]).toEqual({ x: 200, y: 0 });
    // Both ways round blocked, the straight line clear: straight across.
    const both = [
      { x: 185, y: -15, w: 30, h: 30 },
      { x: -15, y: 185, w: 30, h: 30 },
    ];
    expect(angledL(a, b, size, size, both, false).samples).toHaveLength(2);
    // Level: a straight line.
    expect(angledL(a, { x: 200, y: 3 }, size, size, [], false).samples).toHaveLength(2);
  });

  it("give steps across the same gap separate tracks where they overlap", () => {
    const { track, count } = assignTracks([
      { edge: 0, step: 0, gap: 0, x1: 0, x2: 100 },
      { edge: 1, step: 0, gap: 0, x1: 50, x2: 150 },
      { edge: 2, step: 0, gap: 0, x1: 200, x2: 300 },
      { edge: 3, step: 0, gap: 0, x1: 400, x2: 400 }, // straight down: no track
      { edge: 4, step: 0, gap: 1, x1: 0, x2: 100 },
    ]);
    expect(track.get("0:0")).toBe(0);
    expect(track.get("1:0")).toBe(1);
    expect(track.get("2:0")).toBe(0);
    expect(track.has("3:0")).toBe(false);
    expect(count.get(0)).toBe(2);
    expect(count.get(1)).toBe(1);
  });

  it("run a layered edge down, across at its track, and down again", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 80 },
    ];
    const shape = angledLayers(
      pts,
      (p) => p.y / 80,
      size,
      size,
      () => 40,
      () => 0,
      false,
    );
    expect(shape.samples).toEqual([
      { x: 0, y: 17 },
      { x: 0, y: 40 },
      { x: 100, y: 40 },
      { x: 100, y: 63 },
    ]);
  });
});

describe("weight labels", () => {
  const line = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ];
  it("go halfway along when that's clear, and elsewhere along the edge when it isn't", () => {
    expect(placeLabels([{ text: "4", w: 10, h: 12, samples: line }], [])).toEqual([{ x: 100, y: 0 }]);
    const [moved] = placeLabels([{ text: "4", w: 10, h: 12, samples: line }], [{ x: 90, y: -10, w: 20, h: 20 }]);
    expect(Math.abs(moved.x - 100) > 15 || Math.abs(moved.y) > 10).toBe(true);
  });

  it("don't cover each other", () => {
    const [a, b] = placeLabels(
      [
        { text: "1", w: 10, h: 12, samples: line },
        { text: "2", w: 10, h: 12, samples: line },
      ],
      [],
    );
    expect(Math.abs(a.x - b.x) >= 10 || Math.abs(a.y - b.y) >= 12).toBe(true);
  });
});
