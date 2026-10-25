// @vitest-environment jsdom
/**
 * Arrow crossings in the memory view (Arrows mode, every step of every
 * JavaScript example) never go up: crossings.baseline.json has each
 * example's count from before arrows could run behind boxes (October 2026).
 * Routing changes must keep every example at or below it. If one gets
 * better, lower its number.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { memoryScene } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import baseline from "./crossings.baseline.json";
import { type Point, renderMemory } from "./memory";

/** Each arrow's corners, read back from its path (M, a Q per corner, L). */
function arrows(svg: SVGSVGElement): Point[][] {
  return [...svg.querySelectorAll<SVGPathElement>(".ref-arrow")].map((path) => {
    const d = path.getAttribute("d")!;
    const start = d.match(/^M([\d.-]+),([\d.-]+)/)!;
    const points = [{ x: Number(start[1]), y: Number(start[2]) }];
    for (const m of d.matchAll(/Q([\d.-]+),([\d.-]+)/g)) points.push({ x: Number(m[1]), y: Number(m[2]) });
    const end = d.match(/L([\d.-]+),([\d.-]+)$/)!;
    points.push({ x: Number(end[1]), y: Number(end[2]) });
    return points;
  });
}

/** Does a level segment cross an upright one (not just touch)? */
function cross(a: Point, b: Point, c: Point, d: Point): boolean {
  const [h1, h2] = [a.y === b.y, c.y === d.y];
  if (h1 === h2) return false;
  const [hA, hB, vA, vB] = h1 ? [a, b, c, d] : [c, d, a, b];
  const [x, y] = [vA.x, hA.y];
  return (
    x > Math.min(hA.x, hB.x) + 0.5 &&
    x < Math.max(hA.x, hB.x) - 0.5 &&
    y > Math.min(vA.y, vB.y) + 0.5 &&
    y < Math.max(vA.y, vB.y) - 0.5
  );
}

describe("arrow crossings", () => {
  const counts = baseline as Record<string, number>;
  it.each(JAVASCRIPT_EXAMPLES.map((e) => [e.name, e.code] as const))("%s: no more than before", async (name, code) => {
    const t = applyHints(await traceJavaScript(code, 3000));
    let total = 0;
    for (let i = 0; i < t.steps.length; i++) {
      const routes = arrows(renderMemory(memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { mode: "arrows" })));
      for (let a = 0; a < routes.length; a++)
        for (let b = a + 1; b < routes.length; b++)
          for (let p = 1; p < routes[a].length; p++)
            for (let q = 1; q < routes[b].length; q++)
              if (cross(routes[a][p - 1], routes[a][p], routes[b][q - 1], routes[b][q])) total++;
    }
    expect(total).toBeLessThanOrEqual(counts[name] ?? 0);
  });
});
