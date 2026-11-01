/**
 * Kept boxes (boxCache.ts) on the Python examples: as boxCache.test.ts does
 * for JavaScript, every step drawn with kept boxes must be the step drawn
 * afresh. Python's tracer runs in this process, without a DOM, so drawings
 * are compared by their marks' signatures (everything they say).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PYTHON_EXAMPLES } from "../../examples/index";
import { memoryScene } from "../../scene/memoryScene";
import { pythonTracer, type TracePython } from "../../testing/pythonTracer";
import { diffSteps } from "../../trace/diff";
import { applyHints } from "../../trace/hints";
import { memoryDrawing, type Point } from "../memory";
import { BoxCache } from "./boxCache";

describe("kept boxes on the Python examples", () => {
  let tracePython: TracePython;
  beforeAll(async () => {
    tracePython = await pythonTracer();
  }, 120_000);

  for (const example of PYTHON_EXAMPLES) {
    it(`${example.name}: every step drawn with kept boxes is the step drawn afresh`, () => {
      const trace = applyHints(tracePython(example.code, 1500, 10));
      const n = trace.steps.length;
      const forward = [...Array(Math.min(n, 50)).keys()].map((k) => (n <= 50 ? k : Math.floor((k * (n - 1)) / 49)));
      const order = [...forward, ...forward.slice(-6).reverse(), 0, n - 1, Math.floor(n / 2)];
      let kept = 0;
      for (const mode of ["arrows", "nested"] as const) {
        for (const sizes of [null, "python" as const]) {
          const boxes = new BoxCache();
          const positions = new Map<string, Point>();
          for (const i of order) {
            const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]), { mode, sizes });
            if (i % 11 === 5 && scene.objects[0]) positions.set(scene.objects[0].key, { x: 20 * i, y: 300 + i });
            const fresh = memoryDrawing(scene, { positions }).signature();
            const drawing = memoryDrawing(scene, { positions, boxes });
            expect(drawing.signature() === fresh, `${mode}${sizes ? ", sizes" : ""}, step ${i + 1}`).toBe(true);
            kept += boxes.stats.kept;
          }
        }
      }
      if (n > 10) expect(kept).toBeGreaterThan(0);
    }, 120_000);
  }
});
