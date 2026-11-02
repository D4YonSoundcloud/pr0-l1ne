// @vitest-environment jsdom
/**
 * Summaries in the loop history (loopSummaries.ts): rows far from the
 * running one fold into a band past a budget of cells; the band keeps its
 * key from step to step and grows a chunk at a time, so the rows below it
 * stay where they are; an opened fold is drawn in full; and nothing in the
 * examples is folded at full detail.
 */
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples/index";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { loopDrawing } from "../render/loopView";
import { loopSize } from "../render/loopView/layout";
import { planLoop } from "../render/loopView/plan";
import { RowCache } from "../render/loopView/rowCache";
import { applyHints } from "../trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../trace/loopHistory";
import type { Trace } from "../trace/types";
import { type LoopScene, loopScene } from "./loopScene";
import { FOLD_PREFIX, type Fold, loopDetailBudget } from "./loopSummaries";

const LONG = `const a = [];
for (let i = 0; i < 50; i++) a.push(i);
for (let k = 0; k < 40; k++) {
  a[k] = a[k] * 2;
}
let done = 1;
`;

const trace = async (code: string) => applyHints(await traceJavaScript(code, 5000));
const historyAt = (t: Trace, i: number) => buildNestedHistory(t, i) ?? buildLoopHistory(t, i, null);
const detail = (cells: number, expanded: string[] = []) => ({ cells, expanded: new Set(expanded) });
const foldsOf = (scene: LoopScene) => scene.items.filter((item): item is Fold => item.kind === "fold");
const rowsOf = (scene: LoopScene) => scene.items.flatMap((item) => (item.kind === "row" ? [item] : []));

/** The steps inside the second loop, in order. */
async function longLoop() {
  const t = await trace(LONG);
  const steps: number[] = [];
  t.steps.forEach((s, i) => {
    if (s.line === 4) steps.push(i);
  });
  return { t, steps };
}

describe("folding the loop history", () => {
  it("keeps the first row and the latest that fit the budget, folding the rest into one band", async () => {
    const { t, steps } = await longLoop();
    const at = steps.at(-1)!;
    const history = historyAt(t, at)!;
    const full = loopScene(t, history, { hideQuiet: false });
    const scene = loopScene(t, history, { hideQuiet: false, detail: detail(600) });
    const [fold] = foldsOf(scene);
    expect(foldsOf(scene)).toHaveLength(1);
    const kept = rowsOf(scene);
    expect(kept[0].index).toBe(0);
    expect(kept.at(-1)!.index).toBe(rowsOf(full).at(-1)!.index);
    expect(kept.length + fold.count).toBe(rowsOf(full).length);
    // About the budget: 51 cells a row, 600 cells, so ten or so rows below the band (a chunk more at most).
    expect(kept.length - 1).toBeGreaterThanOrEqual(10);
    expect(kept.length - 1).toBeLessThan(10 + 6);
    expect(fold.key.startsWith(FOLD_PREFIX)).toBe(true);
    expect(scene.cellBudget).toBe(600);
    // Under the budget, nothing folds; without one, nothing either.
    expect(foldsOf(loopScene(t, history, { hideQuiet: false, detail: detail(1e9) }))).toHaveLength(0);
    expect(foldsOf(full)).toHaveLength(0);
  });

  it("keeps its key while stepping, and moves a chunk of rows at a time, so rows below it stay put", async () => {
    const { t, steps } = await longLoop();
    const keys = new Set<string>();
    let moves = 0;
    let lastStart: number | null = null;
    for (const i of steps.slice(20)) {
      const scene = loopScene(t, historyAt(t, i)!, { hideQuiet: false, detail: detail(600) });
      const [fold] = foldsOf(scene);
      if (!fold) continue;
      keys.add(fold.key);
      const start = rowsOf(scene)[1].index;
      if (lastStart !== null && start !== lastStart) moves++;
      lastStart = start;
    }
    expect(keys.size).toBe(1);
    // 20 steps, a chunk of 5 or 6 rows: the rows below move a handful of times, not every step.
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(5);
  });

  it("draws an opened fold's rows in full, step after step", async () => {
    const { t, steps } = await longLoop();
    const scene = loopScene(t, historyAt(t, steps.at(-1)!)!, { hideQuiet: false, detail: detail(600) });
    const [fold] = foldsOf(scene);
    for (const i of steps.slice(-5)) {
      const open = loopScene(t, historyAt(t, i)!, { hideQuiet: false, detail: detail(600, [fold.key]) });
      expect(foldsOf(open)).toHaveLength(0);
    }
  });

  it("is drawn as a band that opens by its key, the drawing's size worked out beforehand, with rows kept between steps", async () => {
    const { t, steps } = await longLoop();
    const rows = new RowCache();
    for (const vertical of [false, true])
      for (const i of steps.slice(-8)) {
        const scene = loopScene(t, historyAt(t, i)!, { hideQuiet: true, detail: detail(600) });
        const fresh = loopDrawing(scene, { vertical });
        const band = fresh.querySelector(".fold-band");
        const [fold] = foldsOf(scene);
        expect(band?.getAttribute("data-summary")).toBe(fold.key);
        expect(band?.getAttribute("data-node-key")).toBe(fold.key);
        expect(band?.textContent).toContain(`${fold.count} passes folded`);
        const size = loopSize(scene, planLoop(scene, { vertical }));
        expect(size.height).toBe(Number(fresh.getAttribute("height")));
        // Kept rows draw it the same as a fresh drawing, and are kept.
        const kept = loopDrawing(scene, { vertical, rows });
        expect(kept.signature()).toBe(fresh.signature());
      }
    expect(rows.stats.kept).toBeGreaterThan(5);
  });

  it("folds nested loops' passes, keeping the header that starts the first run below the band", async () => {
    const t = await trace(`const g = [];
for (let i = 0; i < 30; i++) {
  const row = [];
  for (let j = 0; j < 12; j++) row.push(i * j);
  g.push(row);
}
let done = 1;
`);
    let deepest = -1;
    t.steps.forEach((s, i) => {
      if (s.line === 4) deepest = i;
    });
    const history = historyAt(t, deepest)!;
    const scene = loopScene(t, history, { hideQuiet: false, detail: detail(400) });
    const items = scene.items;
    const at = items.findIndex((item) => item.kind === "fold");
    expect(at).toBeGreaterThan(0);
    // Whatever follows the band starts a row's run (its header) or is a row.
    expect(["header", "row"]).toContain(items[at + 1].kind);
    const drawn = loopDrawing(scene, {});
    expect(drawn.querySelectorAll(".fold-band")).toHaveLength(1);
  });

  it("never folds anything in the examples at full detail", async () => {
    for (const [name, run] of [
      ...JAVASCRIPT_EXAMPLES.map((e) => [e.name, () => traceJavaScript(e.code, 2000)] as const),
      ...TYPESCRIPT_EXAMPLES.map((e) => [e.name, () => traceTypeScript(e.code, 2000)] as const),
    ]) {
      const t = applyHints(await run());
      for (let i = 0; i < t.steps.length; i += 3) {
        const history = historyAt(t, i);
        if (!history?.rows.length) continue;
        const scene = loopScene(t, history, { hideQuiet: true, detail: detail(loopDetailBudget(0, false)) });
        expect(foldsOf(scene), `${name}, step ${i}`).toHaveLength(0);
      }
    }
  }, 120_000);

  it("folds sooner zoomed out, and as at full detail with Auto-fit on", () => {
    expect(loopDetailBudget(0, false)).toBeGreaterThan(loopDetailBudget(2, false));
    expect(loopDetailBudget(2, false)).toBeGreaterThan(loopDetailBudget(4, false));
    expect(loopDetailBudget(4, true)).toBe(loopDetailBudget(0, false));
  });
});
