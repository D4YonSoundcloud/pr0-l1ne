// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { SVG_RENDERERS } from "../render/svgRenderers";
import { buildLoopHistory } from "../trace/loopHistory";
import { LoopController, liveRows } from "./loopController";
import { makeApp, showJavaScript } from "./testHelpers";

const NESTED = `const grid = [[1, 2], [3, 4]];
let sum = 0;
for (let r = 0; r < grid.length; r++) {
  for (let c = 0; c < grid[r].length; c++) {
    sum += grid[r][c];
  }
}`;

/** The last step matching `test`. */
const lastIndex = <T>(items: T[], test: (item: T) => boolean) => items.map(test).lastIndexOf(true);

/** The step inside the inner loop on its last pass. */
async function insideInnerLoop(app: ReturnType<typeof makeApp>["app"]) {
  await showJavaScript(app, NESTED);
  const { trace } = app.get();
  const index = lastIndex(trace!.steps, (s) => s.line === 5);
  app.setStep(index);
}

function setup(storage?: ReturnType<typeof makeApp>["storage"]) {
  document.body.innerHTML = `
    <div id="loop"></div><div id="loop-tabs"></div>
    <input id="hide-quiet" type="checkbox" checked /><input id="loop-vertical" type="checkbox" />
    <button id="loop-stacked"></button><button id="loop-animated"></button>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const { app, settings, storage: store } = makeApp(storage);
  // These tests start from stacked rows (a first visit starts animated: see its own test).
  if (!storage) settings.loopMode.set("stacked");
  const redraws: boolean[] = [];
  const loop = new LoopController({
    app,
    renderers: SVG_RENDERERS,
    settings,
    els: {
      loop: $("loop"),
      loopTabs: $("loop-tabs"),
      hideQuiet: $("hide-quiet"),
      loopVertical: $("loop-vertical"),
      loopStacked: $("loop-stacked"),
      loopAnimated: $("loop-animated"),
    },
    sizes: () => null,
    animation: () => ({ duration: 0, easing: "linear", enter: { fade: false, slide: false } }),
    redraw: (updateMarks) => {
      redraws.push(updateMarks);
      loop.render();
    },
  });
  const tabs = () => [...$("loop-tabs").querySelectorAll("button")];
  const selected = () => tabs().find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
  return { app, settings, storage: store, loop, $, tabs, selected, redraws };
}

describe("LoopController", () => {
  it("starts animated on a first visit", () => {
    expect(makeApp().settings.loopMode.get()).toBe("animated");
  });

  it("explains itself before any loop runs", async () => {
    const { app, loop, $ } = setup();
    await showJavaScript(app, NESTED, 2);
    loop.render();
    expect($("loop").textContent).toContain("When your code enters a loop");
  });

  it("draws nested loops together, with a tab for each loop", async () => {
    const { app, loop, tabs, selected, $ } = setup();
    await insideInnerLoop(app);
    loop.render();
    expect(tabs().map((t) => t.textContent)).toEqual([
      "All loops",
      expect.stringMatching(/^for \(let r = 0.*\(line 3\)$/),
      expect.stringMatching(/^for \(let c = 0.*\(line 4\)$/),
    ]);
    expect(selected()).toBe("All loops");
    expect($("loop").querySelectorAll(".loop-row").length).toBeGreaterThan(2);
  });

  it("a tab picks one loop, until another program or language", async () => {
    const { app, loop, tabs, selected, redraws } = setup();
    await insideInnerLoop(app);
    loop.render();
    tabs()[2].click();
    expect(redraws).toEqual([true]);
    expect(selected()).toMatch(/^for \(let c/);
    loop.reset();
    loop.render();
    expect(selected()).toBe("All loops");
    tabs()[1].click();
    app.setLanguage("python"); // also resets
    await insideInnerLoop(app);
    loop.render();
    expect(selected()).toBe("All loops");
  });

  it("animated mode shows one loop, live, and is remembered", async () => {
    const { app, loop, tabs, redraws, $, storage } = setup();
    await insideInnerLoop(app);
    loop.render();
    $("loop-animated").click();
    expect(redraws).toEqual([false]); // the editor's marks don't change
    expect($("loop-animated").getAttribute("aria-pressed")).toBe("true");
    expect(tabs().map((t) => t.textContent)).not.toContain("All loops");
    expect(setup(storage).$("loop-animated").getAttribute("aria-pressed")).toBe("true");
  });

  it("the toolbar's checkboxes redraw, and stacking vertically is remembered", () => {
    const { $, redraws, storage } = setup();
    $<HTMLInputElement>("hide-quiet").click();
    $<HTMLInputElement>("loop-vertical").click();
    expect(redraws).toEqual([true, true]);
    expect(setup(storage).$<HTMLInputElement>("loop-vertical").checked).toBe(true);
  });

  it("showEmpty clears the window and its tabs", async () => {
    const { app, loop, tabs } = setup();
    await insideInnerLoop(app);
    loop.render();
    loop.showEmpty();
    expect(tabs()).toEqual([]);
  });
});

describe("liveRows", () => {
  it("is the loop's state at this step and the one before", async () => {
    const t = await traceJavaScript("let s = 0;\nfor (let i = 0; i < 3; i++) {\n  s += i;\n}");
    const index = lastIndex(t.steps, (s) => s.line === 3);
    const history = buildLoopHistory(t, index, null)!;
    const { prev, current } = liveRows(t, index, history);
    expect(current.stepIndex).toBe(index);
    expect(prev.stepIndex).toBe(index - 1);
    expect(current.iteration).toBe(history.rows.at(-1)?.iteration);
  });
});
