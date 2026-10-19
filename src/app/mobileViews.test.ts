// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSettings } from "../settings";
import { MobileViewsController, parseViews, toggleView } from "./mobileViews";

describe("toggleView", () => {
  it("shows a hidden window, making room by dropping the oldest pick", () => {
    expect(toggleView(["editor", "memory"], "loop")).toEqual(["memory", "loop"]);
    expect(toggleView(["memory", "loop"], "editor")).toEqual(["loop", "editor"]);
    expect(toggleView(["memory"], "loop")).toEqual(["memory", "loop"]);
  });

  it("hides one of two, but never the last", () => {
    expect(toggleView(["editor", "memory"], "editor")).toEqual(["memory"]);
    expect(toggleView(["memory"], "memory")).toEqual(["memory"]);
  });
});

describe("parseViews", () => {
  it("reads one or two windows, and falls back to code and memory", () => {
    expect(parseViews("memory,loop")).toEqual(["memory", "loop"]);
    expect(parseViews("loop")).toEqual(["loop"]);
    expect(parseViews(" editor , loop ")).toEqual(["editor", "loop"]);
    expect(parseViews("loop,loop")).toEqual(["loop"]);
    for (const raw of [null, "", "nonsense", "editor,memory,loop"]) {
      expect(parseViews(raw), String(raw)).toEqual(["editor", "memory"]);
    }
  });
});

describe("MobileViewsController", () => {
  function setup(saved?: string) {
    document.body.innerHTML = `
      <nav id="view-switch">
        <button data-view="editor"></button><button data-view="memory"></button><button data-view="loop"></button><button></button>
      </nav>
      <main id="workspace"></main>`;
    const settings = createSettings(null);
    if (saved) settings.mobileViews.set(saved);
    const els = {
      viewSwitch: document.getElementById("view-switch")!,
      workspace: document.getElementById("workspace")!,
    };
    const controller = new MobileViewsController(els, settings.mobileViews);
    const button = (view: string) => els.viewSwitch.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!;
    const pressed = () => ["editor", "memory", "loop"].filter((v) => button(v).getAttribute("aria-pressed") === "true");
    return { controller, settings, els, button, pressed };
  }

  it("starts with code and memory, marked on the bar and the workspace", () => {
    const { els, pressed } = setup();
    expect(pressed()).toEqual(["editor", "memory"]);
    expect(els.workspace.className).toBe("shows-editor shows-memory");
  });

  it("switches on a tap, and remembers", () => {
    const { els, button, pressed, settings, controller } = setup();
    button("loop").click();
    expect(pressed()).toEqual(["memory", "loop"]);
    expect(els.workspace.classList.contains("shows-editor")).toBe(false);
    expect(els.workspace.classList.contains("shows-loop")).toBe(true);
    expect(settings.mobileViews.get()).toBe("memory,loop");
    button("memory").click();
    expect(controller.views).toEqual(["loop"]);
    button("loop").click(); // the only one: stays
    expect(controller.views).toEqual(["loop"]);
    els.viewSwitch.querySelector<HTMLButtonElement>("button:not([data-view])")!.click(); // not a window
    expect(controller.views).toEqual(["loop"]);
  });

  it("starts from what was saved", () => {
    const { pressed } = setup("loop,editor");
    expect(pressed()).toEqual(["editor", "loop"]);
  });
});
