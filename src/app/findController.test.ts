// @vitest-environment jsdom
/**
 * Finding a step where something's true (findController.ts): Enter for
 * the next step where it is, Shift + Enter or ◀ for the one before; a note
 * when it's never true that way, or doesn't read, or there's nothing to
 * search; only the last search's answer counts.
 */
import { describe, expect, it } from "vitest";
import { FindController } from "./findController";
import { makeApp, showJavaScript } from "./testHelpers";

const CODE = `let best = 0;
for (const x of [3, 12, 5]) {
  if (x > best) best = x;
}
`;

function setup() {
  document.body.innerHTML = `<form id="find"><input id="find-input"><button type="button" id="find-prev"></button><button type="submit">▶</button><span id="find-note"></span></form>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const { app, layout } = makeApp();
  const els = {
    find: $<HTMLFormElement>("find"),
    findInput: $<HTMLInputElement>("find-input"),
    findPrev: $<HTMLButtonElement>("find-prev"),
    findNote: $("find-note"),
  };
  const find = new FindController({ app, layout, els, goTo: (step) => app.setStep(step), firstStep: () => 2 });
  return { app, layout, find, els };
}

describe("finding a step", () => {
  it("goes to the next step where it's true on Enter, and the one before on Shift + Enter or ◀", async () => {
    const { app, find, els } = setup();
    await showJavaScript(app, CODE, 2);
    els.findInput.value = "best > 4";
    els.find.requestSubmit();
    await find.found();
    const first = app.get().stepIndex;
    expect(first).toBeGreaterThan(2);
    els.findInput.value = "best == 0";
    els.findInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    await find.found();
    expect(app.get().stepIndex).toBeLessThan(first);
    els.findInput.value = "best > 4";
    els.findPrev.click();
    await find.found();
    expect(els.findNote.textContent).toBe("Not true at any step before this one.");
  });

  it("says when it's never true that way, when it doesn't read, and when there's nothing to search", async () => {
    const { app, find, els } = setup();
    els.findInput.value = "best > 4";
    await find.find(false);
    expect(els.findNote.textContent).toBe("Run the code first.");
    await showJavaScript(app, CODE, 2);
    els.findInput.value = "best > 100";
    await find.find(false);
    expect(els.findNote.textContent).toBe("Not true at any step after this one.");
    els.findInput.value = "best >";
    await find.find(false);
    expect(els.findNote.textContent).toMatch(/^Can't read that: /);
    expect(els.findNote.classList.contains("is-error")).toBe(true);
    els.findInput.dispatchEvent(new Event("input"));
    expect(els.findNote.textContent).toBe("");
    app.markStale();
    els.findInput.value = "best > 4";
    await find.find(false);
    expect(els.findNote.textContent).toMatch(/^The code changed since it ran/);
  });

  it("answers only the last search", async () => {
    const { app, find, els, layout } = setup();
    await showJavaScript(app, CODE, 2);
    const answers: ((step: number) => void)[] = [];
    layout.find = () => new Promise((resolve) => answers.push((step) => resolve({ step })));
    els.findInput.value = "best > 4";
    const one = find.find(false);
    const two = find.find(false);
    answers[1](5);
    answers[0](4);
    await Promise.all([one, two]);
    expect(app.get().stepIndex).toBe(5);
  });
});
