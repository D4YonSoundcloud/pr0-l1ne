// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { SVG_RENDERERS } from "../render/svgRenderers";
import { MemoryController } from "./memoryController";
import { makeApp, showJavaScript } from "./testHelpers";

const CODE = `const nums = [3, 1, 2];
const box = { nums };
console.log(nums.length);`;

function setup(storage?: ReturnType<typeof makeApp>["storage"]) {
  document.body.innerHTML = `
    <div id="memory"></div>
    <button id="mode-arrows"></button><button id="mode-nested"></button>
    <button id="sizes"></button><select id="size-model"></select>
    <button id="show-output"></button><button id="dim-output"></button>
    <span id="memory-total"></span>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const { app, settings, storage: store } = makeApp(storage);
  let redraws = 0;
  const memory = new MemoryController({
    app,
    renderers: SVG_RENDERERS,
    settings,
    els: {
      memory: $("memory"),
      modeArrows: $("mode-arrows"),
      modeNested: $("mode-nested"),
      sizes: $("sizes"),
      sizeModel: $("size-model"),
      showOutput: $("show-output"),
      dimOutput: $("dim-output"),
      memoryTotal: $("memory-total"),
    },
    animation: () => ({ duration: 0, easing: "linear", enter: { fade: false, slide: false } }),
    redraw: () => {
      redraws++;
      memory.render();
    },
  });
  const pressed = (id: string) => $(id).getAttribute("aria-pressed");
  return { app, settings, storage: store, memory, $, pressed, redraws: () => redraws };
}

describe("MemoryController", () => {
  it("invites you to run something, then draws the step", async () => {
    const { app, memory, $ } = setup();
    memory.showEmpty();
    expect($("memory").textContent).toContain("Write some code and press Run");
    await showJavaScript(app, CODE);
    memory.render();
    expect($("memory").querySelector(".memory-svg")).not.toBeNull();
    expect($("memory").querySelectorAll(".node").length).toBeGreaterThan(0);
  });

  it("switches between arrows and nested objects, and remembers", async () => {
    const { app, memory, pressed, $, storage } = setup();
    await showJavaScript(app, CODE);
    expect(pressed("mode-arrows")).toBe("true");
    $("mode-nested").click();
    expect(pressed("mode-nested")).toBe("true");
    expect(pressed("mode-arrows")).toBe("false");
    memory.toggleNested();
    expect(pressed("mode-arrows")).toBe("true");
    memory.toggleNested();
    expect(setup(storage).pressed("mode-nested")).toBe("true");
  });

  it("shows memory sizes, with the program's total, under a model per language", async () => {
    const { app, memory, $, pressed, redraws } = setup();
    await showJavaScript(app, CODE);
    memory.render();
    expect($("memory-total").hidden).toBe(true);
    expect($<HTMLSelectElement>("size-model").hidden).toBe(true);
    $("sizes").click();
    expect(pressed("sizes")).toBe("true");
    expect(redraws()).toBe(1);
    expect(memory.sizes()).toBe("textbook");
    expect($("memory-total").hidden).toBe(false);
    expect($("memory-total").textContent).toMatch(/^Program: \d/);
    const models = () => [...$<HTMLSelectElement>("size-model").options].map((o) => o.value);
    expect(models()).toEqual(["textbook", "v8"]);
    app.setLanguage("python");
    expect(models()).toEqual(["python", "textbook"]);
    expect(memory.sizes()).toBe("python");
  });

  it("remembers the size model chosen for each language family", () => {
    const { app, $, memory, storage } = setup();
    const select = $<HTMLSelectElement>("size-model");
    $("sizes").click();
    select.value = "v8";
    select.dispatchEvent(new Event("change"));
    expect(memory.sizes()).toBe("v8");
    app.setLanguage("typescript"); // shares JavaScript's sizes
    expect(memory.sizes()).toBe("v8");
    expect(setup(storage).memory.sizes()).toBe("v8");
  });

  it("dimming the rest only applies while output is shown", () => {
    const { $, pressed } = setup();
    const dim = $<HTMLButtonElement>("dim-output");
    expect(pressed("show-output")).toBe("true");
    expect(dim.disabled).toBe(false);
    $("show-output").click();
    expect(dim.disabled).toBe(true);
    $("show-output").click();
    dim.click();
    expect(pressed("dim-output")).toBe("true");
  });

  it("Reset layout only shows once a box has been moved", () => {
    const { $ } = setup();
    const reset = [...$("memory").querySelectorAll("button")].find((b) => b.textContent === "Reset layout")!;
    expect(reset.hidden).toBe(true);
  });
});
