// @vitest-environment jsdom
/**
 * The SVG loop renderer, drawing loop scenes (scene/loopScene.ts). What a
 * scene holds is tested in src/scene/; here, that the drawing has exactly
 * the scene's rows, bands and headers, for every example at every step.
 */
import { describe, expect, it } from "vitest";
import { liveRows } from "../app/loopController";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { loopScene } from "../scene/loopScene";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import { renderLoopHistory } from "./loopView";

const count = (svg: SVGSVGElement, selector: string) => svg.querySelectorAll(selector).length;

describe("renderLoopHistory draws the scene", () => {
  const programs = [
    ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 3000)] as const),
    ...TYPESCRIPT_EXAMPLES.map((e) => [`${e.name} (TypeScript)`, () => traceTypeScript(e.code, 3000)] as const),
  ];
  it.each(programs)(
    "%s: a row per row, a band per band or gap, a header per header",
    async (_name, run) => {
      const trace = applyHints(await run());
      // Every step of a short trace; 80 spread over a long one.
      const n = trace.steps.length;
      const steps = n <= 80 ? [...Array(n).keys()] : [...Array(80).keys()].map((k) => Math.floor((k * (n - 1)) / 79));
      for (const i of steps) {
        const history = buildNestedHistory(trace, i) ?? buildLoopHistory(trace, i, null);
        if (!history?.rows.length) continue;
        for (const hideQuiet of [false, true]) {
          const scene = loopScene(trace, history, { hideQuiet });
          const svg = renderLoopHistory(scene);
          const of = (kind: string) => scene.items.filter((item) => item.kind === kind).length;
          const headers = scene.items.filter((item) => item.kind === "header" && scene.info(item.loop)).length;
          expect(count(svg, ".loop-row"), `step ${i + 1}`).toBe(of("row"));
          expect(count(svg, ".quiet-band"), `step ${i + 1}`).toBe(of("band") + of("gap"));
          expect(count(svg, ".sampled-band"), `step ${i + 1}`).toBe(of("gap"));
          expect(count(svg, ".loop-header"), `step ${i + 1}`).toBe(headers);
          expect(count(svg, ".loop-row.is-current")).toBeLessThanOrEqual(1);
        }
      }
    },
    60_000,
  );
});

describe("renderLoopHistory", () => {
  const code = `const a = [3, 1, 2];
let total = 0;
for (let i = 0; i < a.length; i++) {
  total += a[i];
}
`;

  it("labels each row and marks the running one", async () => {
    const trace = await traceJavaScript(code);
    const at = trace.steps.findIndex((s) => s.loops.some((c) => c.iteration === 2));
    const scene = loopScene(trace, buildLoopHistory(trace, at, null)!, { hideQuiet: false });
    const svg = renderLoopHistory(scene);
    expect([...svg.querySelectorAll(".iteration-label")].map((t) => t.textContent)).toEqual(
      scene.rows.map((row) => scene.label(row)),
    );
    expect(svg.querySelector(".loop-row.is-current .iteration-label")?.textContent).toBe("#2");
  });

  it("in animated mode, draws just the live row", async () => {
    const trace = await traceJavaScript(code);
    const at = trace.steps.findIndex((s) => s.loops.some((c) => c.iteration === 2));
    const history = buildLoopHistory(trace, at, null)!;
    const scene = loopScene(trace, history, { hideQuiet: false, live: liveRows(trace, at, history) });
    const svg = renderLoopHistory(scene);
    expect(count(svg, ".loop-row")).toBe(1);
    expect(count(svg, ".loop-row.is-current")).toBe(1);
  });

  it("stacks lanes one above another when asked", async () => {
    const trace = applyHints(
      await traceJavaScript(
        "const a = [1, 2];\nconst b = [3, 4];\nfor (let i = 0; i < 2; i++) {\n  a[i] = b[i];\n  b[i] = 0;\n}\n",
      ),
    );
    const at = trace.steps.length - 2;
    const scene = loopScene(trace, buildLoopHistory(trace, at, null)!, { hideQuiet: false });
    const side = renderLoopHistory(scene);
    const stacked = renderLoopHistory(scene, { vertical: true });
    expect(Number(stacked.getAttribute("width"))).toBeLessThan(Number(side.getAttribute("width")));
    expect(Number(stacked.getAttribute("height"))).toBeGreaterThan(Number(side.getAttribute("height")));
  });
});
