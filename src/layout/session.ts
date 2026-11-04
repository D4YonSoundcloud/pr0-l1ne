/**
 * Everything between a trace and a window's drawing: the layout worker
 * (layout/layout.worker.ts) runs this, and the page does too when there's
 * no worker (layout/local.ts, and the tests). It holds the trace, prepared
 * (trace/prepare.ts), builds each window's scene for a step
 * (scene/memoryScene.ts, scene/loopScene.ts) and lays it out
 * (render/memory.ts, render/loopView.ts), keeping each window's boxes and
 * rows from step to step (memoryView/boxCache.ts, loopView/rowCache.ts).
 *
 * A window is a channel: each renderer the page makes gets its own, with
 * its own kept boxes or rows, as each renderer had its own before.
 */

import { setArrowStyle } from "../render/arrowStyle";
import type { Mark } from "../render/drawing";
import type { Lod } from "../render/lod";
import { loopDrawing } from "../render/loopView";
import { RowCache } from "../render/loopView/rowCache";
import { memoryDrawing } from "../render/memory";
import { BoxCache } from "../render/memoryView/boxCache";
import { setSpacing, spacing } from "../render/spacing";
import { sqlPipelineDrawing, sqlTableDrawing } from "../render/sqlView";
import { levelForFit } from "../render/viewport";
import { liveNestedRows, liveRows } from "../scene/liveRows";
import { loopScene } from "../scene/loopScene";
import { memoryScene } from "../scene/memoryScene";
import { sqlPipelineScene, sqlTableScene } from "../scene/sqlScene";
import { summaryBoxes } from "../scene/summaries";
import { diffSteps } from "../trace/diff";
import { focusedLoop } from "../trace/hints";
import { ALL_LOOPS, availableLoops, buildLoopHistory, buildNestedHistory, nestedLoopsAt } from "../trace/loopHistory";
import { prepareTrace } from "../trace/prepare";
import type { Trace } from "../trace/types";
import type { Work } from "../trace/work";
import type { Look, LoopLaidOut, LoopShow, LoopTab, LoopView, MemoryLaidOut, MemoryShow, MemoryView } from "./requests";

/** What the loop window says with no loop to show. */
export const NO_LOOP_MESSAGE = "When your code enters a loop, each iteration is stacked here so you can compare them.";

export class LayoutSession {
  private trace: Trace | null = null;
  /** The look last used, as JSON: set again only when it changes (a new spacing forgets every kept box). */
  private look = "";

  /** Use the page's spacing and arrows, if they've changed. */
  private useLook(look: Look): void {
    const json = JSON.stringify(look);
    if (json === this.look) return;
    this.look = json;
    if (JSON.stringify(look.spacing) !== JSON.stringify(spacing)) setSpacing(look.spacing);
    setArrowStyle(look.arrows);
  }
  private readonly boxes = new Map<number, BoxCache>();
  private readonly rows = new Map<number, RowCache>();

  /** The trace drawn, prepared (null before the first). */
  get current(): Trace | null {
    return this.trace;
  }

  /** Prepare a trace (a slice at a time: trace/work.ts), then draw from it. */
  *load(raw: Trace): Work<Trace> {
    const prepared = yield* prepareTrace(raw);
    this.trace = prepared;
    return prepared;
  }

  /** Draw from a trace prepared already (the page's own, when it's laid out on the page). */
  use(prepared: Trace): void {
    this.trace = prepared;
  }

  /** A window gone (its renderer replaced): let its kept boxes and rows go. */
  release(channel: number): void {
    this.boxes.delete(channel);
    this.rows.delete(channel);
  }

  /** The memory window's drawing for a step; null when there's no such step. */
  memory(channel: number, show: MemoryShow, view: MemoryView): MemoryLaidOut<Mark> | null {
    const trace = this.trace;
    const step = trace?.steps[show.step];
    if (!trace || !step) return null;
    this.useLook(show.look);
    if (trace.sql) {
      const scene = sqlTableScene(trace, show.step);
      return scene ? { drawing: sqlTableDrawing(scene), sql: true, summaryKeys: [] } : null;
    }
    const scene = memoryScene(trace, show.step, diffSteps(trace.steps[show.step - 1], step), {
      mode: show.mode,
      sizes: show.sizes,
      output: show.output,
      dimForOutput: show.dimForOutput,
      tall: show.tall,
      detail: { budget: view.budget, expanded: new Set(show.expanded) },
    });
    const positions = new Map(view.positions);
    let boxes = this.boxes.get(channel);
    if (!boxes && !view.full) {
      boxes = new BoxCache();
      this.boxes.set(channel, boxes);
    }
    const drawing = view.full
      ? memoryDrawing(scene, { positions, simpleArrows: view.simpleArrows })
      : memoryDrawing(scene, {
          positions,
          raise: view.raise,
          boxes,
          simpleArrows: view.simpleArrows,
          level: view.level as Lod,
        });
    return { drawing, sql: false, detailBudget: scene.detailBudget, summaryKeys: [...summaryBoxes(scene)] };
  }

  /** The loop window's drawing (or why there's none) and its tabs, for a step; null when there's no such step. */
  loop(channel: number, show: LoopShow, view: LoopView): LoopLaidOut<Mark> | null {
    const trace = this.trace;
    if (!trace?.steps[show.step]) return null;
    this.useLook(show.look);
    const stepIndex = show.step;
    // SQL: the statement's stages, in the order they run.
    if (trace.sql) {
      const scene = sqlPipelineScene(trace, stepIndex);
      return scene ? { drawing: sqlPipelineDrawing(scene), message: "", sql: true, live: false, tabs: [] } : null;
    }
    // Nested loops are drawn together unless one loop is picked: stacked,
    // each inner pass under the outer pass it's in; animated, each inner
    // loop's live row under the loop around it.
    const { contexts } = availableLoops(trace, stepIndex);
    const together = nestedLoopsAt(trace, stepIndex).length > 0;
    // Nothing picked in the tabs: a `viz: focus` hint's loop, when it's one of the loops here.
    const focus = focusedLoop(trace);
    const selected =
      show.selected ??
      (focus === "all" ? ALL_LOOPS : focus && contexts.some((ctx) => ctx.loop === focus) ? focus : null);
    const wantsAll = together && (selected === null || selected === ALL_LOOPS);
    const history =
      (wantsAll ? buildNestedHistory(trace, stepIndex) : null) ??
      buildLoopHistory(trace, stepIndex, selected === ALL_LOOPS ? null : selected);
    const animated = show.mode === "animated";
    const tabs: LoopTab[] = [
      ...(together
        ? [
            {
              text: "All loops",
              selected: !!history?.nested,
              pick: ALL_LOOPS,
              title: animated
                ? "Every loop in this function, together: each inner loop running under the loop around it"
                : "Every loop in this function, together: each pass of an inner loop under the pass of the loop around it",
            },
          ]
        : []),
      ...contexts.map((ctx) => {
        const info = trace.loops.find((loop) => loop.id === ctx.loop);
        return {
          text: `${info?.header ?? ctx.loop}  (line ${info?.line ?? "?"})`,
          selected: !history?.nested && history?.info.id === ctx.loop,
          pick: ctx.loop,
        };
      }),
    ];
    if (!history?.rows.length) return { drawing: null, message: NO_LOOP_MESSAGE, sql: false, live: false, tabs };
    const live = !animated
      ? undefined
      : history.nested
        ? liveNestedRows(trace, stepIndex, history)
        : liveRows(trace, stepIndex, history);
    const scene = loopScene(trace, history, {
      hideQuiet: show.hideQuiet,
      live,
      sizes: show.sizes,
      tall: show.tall,
      // Stacked: rows far from the running one fold past the budget the zoom allows.
      detail: live ? undefined : { cells: view.budget, expanded: new Set(show.expanded) },
    });
    let rows = this.rows.get(channel);
    if (!rows && !view.full) {
      rows = new RowCache();
      this.rows.set(channel, rows);
    }
    const drawing = view.full
      ? loopDrawing(scene, { vertical: view.vertical, visible: view.visible })
      : loopDrawing(scene, {
          vertical: view.vertical,
          rows,
          visible: view.visible,
          // Built at the level it'll be drawn at: with Auto-fit, where the fit will put it.
          level: (size) => levelForFit(view.fit, size),
        });
    return {
      drawing,
      message: "",
      sql: false,
      cellBudget: scene.cellBudget,
      live: !!scene.live,
      visible: view.visible,
      tabs,
    };
  }
}
