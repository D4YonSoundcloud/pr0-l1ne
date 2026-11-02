// @vitest-environment jsdom
/**
 * Drawing at a level (lod.ts): built at the level (buildAt), what the
 * level leaves out is never made; and atLevel's results are kept on the
 * marks. Neither may change what's drawn: for every example, at every
 * level, a drawing built at the level and drawn there is mark for mark the
 * full drawing with what the level hides left out (as atLevel did before,
 * testing/atLevelReference.ts), and stays so as boxes and rows are kept
 * from step to step, the zoom goes in and out, and hovering changes it.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { atLevelReference } from "../testing/atLevelReference";
import { diffSteps } from "../trace/diff";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { s } from "./draw";
import { descendants, type Mark, startSignatures, type TextMark, toSvg } from "./drawing";
import { atLevel, buildAt, builtAt, finestLodAt, type Lod, lodAt, lodFor } from "./lod";
import { loopDrawing } from "./loopView";
import { loopSize } from "./loopView/layout";
import { planLoop } from "./loopView/plan";
import { RowCache } from "./loopView/rowCache";
import { applyFocus, memoryDrawing } from "./memory";
import { BoxCache } from "./memoryView/boxCache";
import { SvgPatcher } from "./patch";

const LEVELS: Lod[] = [1, 2, 3, 4];
const same = (a: Mark, b: Mark) => a.signature() === b.signature();

async function examples(): Promise<[string, Trace][]> {
  const out: [string, Trace][] = [];
  for (const e of JAVASCRIPT_EXAMPLES) out.push([e.name, applyHints(await traceJavaScript(e.code, 2000))]);
  for (const e of TYPESCRIPT_EXAMPLES) out.push([e.name, applyHints(await traceTypeScript(e.code, 2000))]);
  return out;
}

/** Steps to visit: spread through the run, and a few in a row (kept boxes and rows). */
function visits(n: number): number[] {
  const spread = [...Array(Math.min(n, 12)).keys()].map((k) =>
    Math.floor((k * (n - 1)) / Math.max(1, Math.min(n, 12) - 1)),
  );
  const run = [...Array(Math.min(n, 6)).keys()].map((k) => Math.floor(n / 2) + k).filter((i) => i < n);
  return [...spread, ...run];
}

describe("drawing at a level: memory", () => {
  it("is the full drawing with what the level hides left out, for every example and level, kept from step to step", async () => {
    for (const [name, trace] of await examples()) {
      for (const lod of LEVELS) {
        const boxes = new BoxCache();
        const patcher = new SvgPatcher();
        // The zoom going in and out as it steps: kept boxes built with less detail must never show at more.
        const zooms: Lod[] = [lod, 0, lod, lod, 0];
        visits(trace.steps.length).forEach((i, k) => {
          const diff = diffSteps(trace.steps[i - 1] ?? trace.steps[i], trace.steps[i]);
          const scene = memoryScene(trace, i, diff, {});
          const at = zooms[k % zooms.length];
          const where = `${name}, step ${i + 1}, level ${at}`;
          const full = memoryDrawing(scene);
          const built = memoryDrawing(scene, { positions: new Map(), boxes, level: at });
          expect(builtAt(built), where).toBe(at);
          const drawn = atLevel(built, at);
          expect(same(drawn, atLevelReference(full, at)), where).toBe(true);
          // Shown on one SVG, step after step: the patcher keeps it exactly what a fresh one would be.
          expect(patcher.show(drawn).outerHTML, where).toBe((toSvg(drawn) as Element).outerHTML);
        });
      }
    }
  }, 300_000);

  it("stays the same as the reference when hovering changes the drawing, and asked again at each level", async () => {
    for (const [name, trace] of (await examples()).slice(0, 6)) {
      const i = Math.floor(trace.steps.length / 2);
      const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1], trace.steps[i]), {});
      const drawing = memoryDrawing(scene);
      const keys = drawing.querySelectorAll(".node").map((n) => n.getAttribute("data-node-key"));
      for (const lod of LEVELS) {
        for (const key of [keys[0], keys.at(-1), null, keys[1] ?? null]) {
          applyFocus(drawing, key ?? null);
          expect(same(atLevel(drawing, lod), atLevelReference(drawing, lod)), `${name}, level ${lod}, ${key}`).toBe(
            true,
          );
        }
      }
    }
  }, 120_000);
});

describe("drawing at a level: loop history", () => {
  it("is the full drawing with what the level hides left out, with rows kept, and its size is worked out beforehand", async () => {
    let checked = 0;
    for (const [name, trace] of await examples()) {
      for (const vertical of [false, true]) {
        const rows = new RowCache();
        const zooms: Lod[] = [2, 0, 3, 3, 1, 4, 4];
        visits(trace.steps.length).forEach((i, k) => {
          const history = buildNestedHistory(trace, i) ?? buildLoopHistory(trace, i, null);
          if (!history?.rows.length) return;
          const scene = loopScene(trace, history, { hideQuiet: true });
          const at = zooms[k % zooms.length];
          const where = `${name}, step ${i + 1}, level ${at}${vertical ? ", vertical" : ""}`;
          const full = loopDrawing(scene, { vertical });
          const size = loopSize(scene, planLoop(scene, { vertical }));
          expect([size.width, size.height], where).toEqual([
            Number(full.getAttribute("width")),
            Number(full.getAttribute("height")),
          ]);
          let asked: { width: number; height: number } | null = null;
          const built = loopDrawing(scene, {
            vertical,
            rows,
            level: (s) => {
              asked = s;
              return at;
            },
          });
          expect(asked, where).toEqual(size);
          expect(same(atLevel(built, at), atLevelReference(full, at)), where).toBe(true);
          checked++;
        });
      }
    }
    expect(checked).toBeGreaterThan(50);
  }, 300_000);
});

describe("drawing at a level: what it saves", () => {
  it("never makes what the level leaves out wherever it is, and copies nothing that loses nothing", () => {
    const build = () =>
      s(
        "svg",
        {},
        s(
          "g",
          { class: "grid" },
          s("g", { class: "cell" }, s("rect", { width: 4 }), s("text", {}, "7")),
          s("g", { class: "cell" }, s("rect", { width: 4 }), s("text", {}, "8")),
        ),
        s("g", { class: "row" }, s("text", { class: "index" }, "0"), s("rect", { width: 9 })),
      );
    const blocks = buildAt(2, build);
    expect(descendants(blocks).filter((m) => m.localName === "text")).toHaveLength(0);
    // Nothing left to leave out: the drawing at its level is itself.
    expect(atLevel(blocks, 2)).toBe(blocks);
    expect(same(atLevel(blocks, 2), atLevelReference(build(), 2))).toBe(true);
    // Reduced keeps the values, not the index.
    const reduced = buildAt(1, build);
    expect(descendants(reduced).map((m) => m.textContent)).not.toContain("0");
    expect(descendants(reduced).filter((m) => m.localName === "text")).toHaveLength(2);
  });

  it("keeps each mark's result: unchanged parts are the very same marks, changed ones made again", () => {
    const cell = (v: string) => s("g", { class: "cell", "data-cell": v }, s("rect", { width: 4 }), s("text", {}, v));
    const a = cell("1");
    const b = cell("2");
    const drawing = s("svg", {}, s("g", { class: "row" }, a, b));
    const first = atLevel(drawing, 2);
    const again = atLevel(drawing, 2);
    expect(again).toBe(first);
    (b.querySelector("text")!.childNodes[0] as TextMark).textContent = "3";
    const after = atLevel(drawing, 2);
    expect(after).not.toBe(first);
    const [ca, cb] = after.children[0].children;
    expect(ca).toBe(first.children[0].children[0]);
    expect(cb).not.toBe(first.children[0].children[1]);
    // A left-out mark changing to be shown is seen too.
    b.querySelector("text")!.setAttribute("class", "value");
    expect(same(atLevel(drawing, 1), atLevelReference(drawing, 1))).toBe(true);
    a.querySelector("text")!.setAttribute("class", "index");
    expect(same(atLevel(drawing, 1), atLevelReference(drawing, 1))).toBe(true);
  });

  it("builds a fitted drawing at the finest level it could end up at, however the zoom glides there", () => {
    const zooms = [1, 0.7, 0.62, 0.5, 0.36, 0.33, 0.2, 0.13, 0.11, 0.05, 0.031, 0.028, 0.01];
    for (const from of zooms)
      for (const to of zooms) {
        let level = lodAt(from);
        for (let k = 1; k <= 24; k++) level = lodFor(from * (to / from) ** (k / 24), level);
        expect(finestLodAt(to) <= level, `${from} to ${to}`).toBe(true);
      }
  });
});

describe("signature numbers", () => {
  it("are the same exactly when signatures are", async () => {
    const [[, trace]] = await examples();
    const marks: Mark[] = [];
    for (const i of visits(trace.steps.length)) {
      const scene = memoryScene(trace, i, diffSteps(trace.steps[i - 1] ?? trace.steps[i], trace.steps[i]), {});
      marks.push(...descendants(memoryDrawing(scene)));
    }
    const byId = new Map<number, string>();
    const bySig = new Map<string, number>();
    for (const m of marks) {
      const id = m.signatureId();
      const sig = m.signature();
      expect(byId.get(id) ?? sig).toBe(sig);
      expect(bySig.get(sig) ?? id).toBe(id);
      byId.set(id, sig);
      bySig.set(sig, id);
    }
    expect(bySig.size).toBeGreaterThan(100);
  });

  it("change with the mark, and start again in a new generation when the table's too big", () => {
    const m = s("g", {}, s("rect", { width: 3 }), "hi");
    const id = m.signatureId();
    expect(s("g", {}, s("rect", { width: 3 }), "hi").signatureId()).toBe(id);
    (m.childNodes[0] as Mark).setAttribute("width", 4);
    expect(m.signatureId()).not.toBe(id);
    const before = startSignatures();
    expect(startSignatures(0)).toBe(before + 1);
    // Worked out again in the new generation, not taken from the old.
    expect(s("g", {}, s("rect", { width: 4 }), "hi").signatureId()).toBe(m.signatureId());
  });
});
