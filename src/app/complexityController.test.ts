// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CostLabel } from "../complexityPanel";
import { ComplexityController } from "./complexityController";
import { makeApp, manualTimers, showJavaScript } from "./testHelpers";

const NESTED = `function pairs(nums) {
  let count = 0;
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) count++;
  }
  return count;
}
pairs([1, 2, 3, 4]);`;

function setup(storage?: ReturnType<typeof makeApp>["storage"]) {
  document.body.innerHTML = `<section id="editor-pane"></section><button id="complexity"></button>`;
  const $ = (id: string) => document.getElementById(id)!;
  const { app, settings, storage: store } = makeApp(storage);
  const labels: CostLabel[][] = [];
  const opened: string[] = [];
  const timers = manualTimers();
  const complexity = new ComplexityController({
    app,
    settings,
    els: { editorPane: $("editor-pane"), complexity: $("complexity") as HTMLButtonElement },
    editor: { revealLine: () => {}, setCostLabels: (l) => labels.push(l) },
    measurement: () => null,
    onOpen: () => opened.push("complexity"),
    ...timers,
  });
  return { app, settings, storage: store, complexity, labels, opened, timers, chip: $("complexity") };
}

describe("ComplexityController", () => {
  it("estimates each new trace after it's drawn, and labels the loops and functions", async () => {
    const { app, labels, timers, chip } = setup();
    await showJavaScript(app, NESTED);
    expect(labels).toEqual([]); // not until the step has been drawn
    timers.run();
    expect(chip.textContent).toMatch(/Time\s*O\(n²\)/);
    expect(labels.at(-1)?.find((l) => l.kind === "function")?.text).toMatch(/^O\(n²\) time/);
  });

  it("drops the labels while the picture is stale (they'd sit on the wrong lines)", async () => {
    const { app, labels, timers, chip } = setup();
    await showJavaScript(app, NESTED);
    timers.run();
    app.markStale();
    timers.run();
    expect(labels.at(-1)).toEqual([]);
    expect(chip.classList.contains("is-stale")).toBe(true);
  });

  it("the labels can be turned off, and that's remembered", async () => {
    const { app, complexity, labels, timers, storage } = setup();
    await showJavaScript(app, NESTED);
    timers.run();
    complexity.panel.toggle(true);
    const box = document.querySelector<HTMLInputElement>('#editor-pane input[type="checkbox"]')!;
    box.click();
    timers.run();
    expect(labels.at(-1)).toEqual([]);
    expect(setup(storage).settings.complexityLabels.get()).toBe(false);
  });

  it("switching language clears the estimate with the trace", async () => {
    const { app, labels, timers, chip } = setup();
    await showJavaScript(app, NESTED);
    timers.run();
    app.setLanguage("python");
    timers.run();
    expect(chip.textContent).toBe("Complexity");
    expect(labels.at(-1)).toEqual([]);
  });

  it("opens from its chip, closing the others", () => {
    const { complexity, opened, chip } = setup();
    chip.click();
    expect(opened).toEqual(["complexity"]);
    complexity.close();
    expect(complexity.panel.isOpen).toBe(false);
  });
});
