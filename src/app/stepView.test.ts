// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { LineMarks } from "../editor";
import type { Step, Trace } from "../trace/types";
import { describe as describeStep, StepView } from "./stepView";
import { makeApp, showJavaScript } from "./testHelpers";

const step = (event: Step["event"], line: number, func = "Global", extra: Partial<Step> = {}) =>
  ({
    event,
    line,
    stack: [{ id: "f", func, locals: { vars: [] } }],
    heap: {},
    stdoutLength: 0,
    loops: [],
    ...extra,
  }) as unknown as Step;
const prim = (repr: string) => ({ kind: "prim", repr }) as Step["returnValue"];

describe("describing a step", () => {
  it("says what happened, in the editor's terms", () => {
    expect(describeStep(step("call", 0), undefined)).toBe("Program starts");
    expect(describeStep(step("call", 2, "sort"), undefined)).toBe("Called sort()");
    expect(describeStep(step("line", 4), step("line", 3))).toBe("Ran line 3, next is line 4");
    expect(describeStep(step("line", 1), step("call", 0))).toBe("Next is line 1");
    expect(describeStep(step("return", 5), undefined)).toBe("Program finished");
    expect(describeStep(step("return", 5, "sum", { returnValue: prim("6") }), undefined)).toBe("sum() returns 6");
    expect(describeStep(step("return", 5, "make"), undefined)).toBe("make() returns an object");
    expect(
      describeStep(step("exception", 7, "f", { exception: { type: "KeyError" } } as Partial<Step>), undefined),
    ).toBe("KeyError raised on line 7");
    expect(describeStep(step("yield", 3, "gen", { returnValue: prim("1") }), undefined)).toBe(
      "gen() yields 1 and pauses",
    );
    expect(describeStep(step("yield", 3, "gen"), undefined)).toBe("gen() hands over to another generator");
    expect(describeStep(step("await", 3, "load"), undefined)).toBe("load() waits at line 3 and pauses");
    expect(describeStep(step("resume", 3, "load"), undefined)).toBe("load() resumes at line 3");
  });
});

function setup() {
  document.body.innerHTML = `<div id="canvas"></div><span id="label"></span><pre id="output"></pre>`;
  const $ = (id: string) => document.getElementById(id)!;
  const { app } = makeApp();
  const drawn: string[] = [];
  const marks: LineMarks[] = [];
  let controls = 0;
  const pane = (name: string) => ({
    render: () => void drawn.push(name),
    showEmpty: () => void drawn.push(`${name} empty`),
  });
  const view = new StepView({
    app,
    els: { canvas: $("canvas"), stepLabel: $("label"), output: $("output") },
    memory: pane("memory"),
    loop: pane("loop"),
    updateControls: () => void controls++,
    editor: { setMarks: (m) => marks.push(m) },
  });
  return { app, view, $, drawn, marks, controls: () => controls };
}

describe("StepView", () => {
  it("before any run: empty windows, no label, no marks", () => {
    const { view, $, drawn, marks, controls } = setup();
    view.render();
    expect(drawn).toEqual(["memory empty", "loop empty"]);
    expect($("label").textContent).toBe("");
    expect(marks).toEqual([{ next: null, prev: null, error: null }]);
    expect(controls()).toBe(1);
  });

  it("draws a step: label, both windows, output so far and the editor's marks", async () => {
    const { app, view, $, drawn, marks } = setup();
    await showJavaScript(app, `console.log("hi");\nlet a = 1;\nlet b = 2;`);
    const { trace } = app.get();
    const index = trace!.steps.findIndex((s) => s.line === 3);
    app.setStep(index);
    view.render();
    expect($("label").textContent).toBe(`Step ${index + 1} of ${trace!.steps.length}: Ran line 2, next is line 3`);
    expect(drawn).toEqual(["memory", "loop"]);
    expect($("output").textContent).toBe("hi\n");
    expect(marks.at(-1)).toEqual({ next: 3, prev: 2, error: null });
    view.render(false);
    expect(marks).toHaveLength(1);
  });

  it("shows the error at the end, in the output and on its line", async () => {
    const { app, view, $, marks } = setup();
    await showJavaScript(app, `let a = 1;\nnull.x;`);
    view.render();
    expect($("output").querySelector(".error")?.textContent).toBe(
      "TypeError: Cannot read properties of null (reading 'x')\n",
    );
    expect(marks.at(-1)?.error).toEqual({
      line: 2,
      message: "TypeError: Cannot read properties of null (reading 'x')",
    });
  });

  it("dims a stale picture, and says when steps were skipped", () => {
    const { app, view, $ } = setup();
    const trace = { steps: [step("line", 1), step("line", 2, "Global", { skipped: 2500 })], stdout: "", error: null };
    app.showTrace(trace as unknown as Trace, "", 1);
    app.markStale();
    view.render();
    expect($("canvas").classList.contains("is-stale")).toBe(true);
    expect($("label").textContent).toBe("Step 2 of 2: Ran line 1, next is line 2 (2.5K steps skipped)");
    expect($("label").title).toContain("2,500 steps ran just before this one without being recorded");
  });
});
