// @vitest-environment jsdom
/**
 * The Changes tab under the code (changesView.ts): the tabs switch, keep
 * the choice, and move with the arrow keys; the list says what changed at
 * the step shown (only the last asked for, if several are on their way);
 * a note when there's nothing to list; read out except while playing.
 */
import { describe, expect, it } from "vitest";
import type { StepChanges } from "../trace/changes";
import { ChangesView } from "./changesView";
import { makeApp, memoryStorage, showJavaScript } from "./testHelpers";

const CODE = `const nums = [5, 3];
nums[0] = 9;
let i = 1;
console.log(i);
`;

function setup(storage = memoryStorage()) {
  document.body.innerHTML = `
    <button id="output-tab"></button><button id="changes-tab"></button>
    <pre id="output"></pre><div id="changes"></div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const { app, settings, layout } = makeApp(storage);
  const els = {
    outputTab: $<HTMLButtonElement>("output-tab"),
    changesTab: $<HTMLButtonElement>("changes-tab"),
    output: $("output"),
    changes: $("changes"),
  };
  const view = new ChangesView({ app, settings, layout, els });
  return { app, settings, layout, view, els, storage };
}

const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, " ").trim();

describe("the Changes tab", () => {
  it("switches with the Output tab, remembers which was open, and moves with the arrow keys", () => {
    const { els, storage } = setup();
    expect(els.output.hidden).toBe(false);
    expect(els.changes.hidden).toBe(true);
    els.changesTab.click();
    expect(els.changesTab.getAttribute("aria-selected")).toBe("true");
    expect(els.output.hidden).toBe(true);
    expect(els.changes.hidden).toBe(false);
    expect(setup(storage).els.changes.hidden).toBe(false);
    const again = setup(storage).els;
    again.changesTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(again.output.hidden).toBe(false);
    expect(document.activeElement).toBe(again.outputTab);
  });

  it("lists what changed at the step shown, or says why there's nothing", async () => {
    const { app, view, els } = setup();
    view.open("changes");
    const trace = await showJavaScript(app, CODE, 2);
    view.render();
    await view.listed();
    expect(text(els.changes)).toBe("nums: [5, 3] new");
    const at = (line: number) => trace.lines.findIndex((l, i) => l === line && i > 2);
    app.setStep(at(3));
    view.render();
    await view.listed();
    expect(text(els.changes)).toBe("nums[0]: from 5 → to 9");
    expect(els.changes.querySelector(".change-arrow")?.getAttribute("aria-hidden")).toBe("true");
    app.setStep(trace.steps - 1);
    view.render();
    await view.listed();
    expect(text(els.changes)).toBe("Nothing changed at this step.");
  });

  it("shows only the last step asked for, and nothing at all while the Output tab is open", async () => {
    const { app, view, els, layout } = setup();
    await showJavaScript(app, CODE, 2);
    let asked = 0;
    const answers: ((c: StepChanges) => void)[] = [];
    layout.changes = () => {
      asked++;
      return new Promise((resolve) => answers.push(resolve));
    };
    view.render();
    expect(asked).toBe(0); // the Output tab is open
    view.open("changes");
    view.render();
    answers[1]({ changes: [{ name: "late", before: "1", after: "2" }], more: 0 });
    answers[0]({ changes: [{ name: "early", before: "1", after: "2" }], more: 3 });
    await Promise.resolve();
    await view.listed();
    expect(text(els.changes)).toBe("late: from 1 → to 2");
  });

  it("is read out as steps are shown, but not while playing", () => {
    const { app, els } = setup();
    expect(els.changes.getAttribute("aria-live")).toBe("polite");
    app.setPlaying(true);
    expect(els.changes.getAttribute("aria-live")).toBe("off");
    app.setPlaying(false);
    expect(els.changes.getAttribute("aria-live")).toBe("polite");
  });
});
