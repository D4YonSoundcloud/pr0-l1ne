// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseAppearance } from "../appearance";
import type { RendererKind } from "../settings";
import { RENDERER_COMPARISON, RENDERER_INFO, type RenderingChoice } from "../stylePanel";
import type { StepAnimation } from "./playbackController";
import { StyleController, type StyledView } from "./styleController";
import { makeApp, manualTimers } from "./testHelpers";

function fakeView() {
  const calls: string[] = [];
  const view: StyledView = {
    setAppearance(style) {
      if (style.gridSize !== undefined) calls.push(`grid ${style.gridSize}`);
      if (style.zoom) calls.push(`zoom ${style.zoom.duration} ${style.zoom.easing}`);
    },
  };
  return { view, calls };
}

function setup(storage?: ReturnType<typeof makeApp>["storage"], rendering?: RenderingChoice) {
  document.body.innerHTML = `
    <section id="editor-pane"></section><button id="style"></button>
    <div id="canvas"><section id="memory-section"></section><section id="loop-section"></section></div>`;
  const $ = (id: string) => document.getElementById(id)!;
  const { app, settings, storage: store } = makeApp(storage);
  const memory = fakeView();
  const loop = fakeView();
  const timers = manualTimers();
  let animation: StepAnimation = null;
  const opened: string[] = [];
  const style = new StyleController({
    app,
    settings,
    els: {
      editorPane: $("editor-pane"),
      style: $("style") as HTMLButtonElement,
      canvas: $("canvas"),
      memorySection: $("memory-section"),
      loopSection: $("loop-section"),
    },
    views: { memory: memory.view, loop: loop.view },
    animation: () => animation,
    replay: () => {},
    onOpen: () => opened.push("style"),
    rendering,
    ...timers,
  });
  return {
    app,
    settings,
    storage: store,
    style,
    memory,
    loop,
    timers,
    opened,
    $,
    animate: (a: StepAnimation) => {
      animation = a;
    },
  };
}

describe("StyleController", () => {
  it("applies the style to both windows at once", () => {
    const { memory, loop, style, $ } = setup();
    const a = style.get();
    expect(memory.calls).toContain(`zoom ${a.memory.duration} ${a.memory.easing}`);
    expect(loop.calls).toContain(`zoom ${a.loop.duration} ${a.loop.easing}`);
    expect($("canvas").getAttribute("style")).toMatch(/--/); // CSS variables
  });

  it("saves a change once changes pause", () => {
    const { style, settings, timers, storage } = setup();
    const next = structuredClone(style.get());
    next.memory.duration = 700;
    style.set(next);
    next.memory.duration = 900;
    style.set(structuredClone(next));
    expect(settings.appearance.get()).toBeNull();
    expect(timers.size).toBe(1);
    timers.run();
    expect(parseAppearance(settings.appearance.get()).memory.duration).toBe(900);
    expect(setup(storage).style.get().memory.duration).toBe(900);
  });

  it("animates single steps for the window's duration, shortened while playing", () => {
    const { style, app, animate } = setup();
    const next = structuredClone(style.get());
    next.memory.duration = 600;
    style.set(next);
    expect(style.animationFor("memory").duration).toBe(0); // a jump: no animation
    animate({ playing: false });
    expect(style.animationFor("memory").duration).toBe(600);
    app.setSpeed(4); // 250 ms a step
    animate({ playing: true });
    expect(style.animationFor("memory").duration).toBe(188); // ends before the next step
    expect(style.animationFor("memory").enter).toEqual({ fade: next.memory.enterFade, slide: next.memory.enterSlide });
  });

  it("opens from its button, closing the others, and closes when another opens", () => {
    const { style, opened, $ } = setup();
    $("style").click();
    expect(opened).toEqual(["style"]);
    expect(style.panel.isOpen).toBe(true);
    style.close();
    expect(style.panel.isOpen).toBe(false);
  });

  describe("the Rendering section", () => {
    function rendering(outcome: () => Promise<void> = () => Promise.resolve()) {
      let kind: RendererKind = "svg";
      const asked: RendererKind[] = [];
      const choice: RenderingChoice = {
        get: () => kind,
        set: (next) => {
          asked.push(next);
          kind = next;
          return outcome().catch((error: unknown) => {
            kind = "svg"; // couldn't: back on SVG
            throw error;
          });
        },
      };
      return { choice, asked };
    }
    const section = () =>
      [...document.querySelectorAll<HTMLDetailsElement>(".style-section")].find(
        (d) => d.querySelector("summary")?.textContent === "Rendering",
      );
    const button = (label: string) =>
      [...section()!.querySelectorAll<HTMLButtonElement>(".segment")].find((b) => b.textContent === label)!;
    const flush = () => new Promise((r) => setTimeout(r, 0));

    it("isn't there without a choice to make", () => {
      setup();
      expect(section()).toBeUndefined();
    });

    it("shows the choice, what each is like, and the two side by side", () => {
      const { choice } = rendering();
      setup(undefined, choice);
      const s = section()!;
      expect(s.open).toBe(true);
      expect(button("SVG").getAttribute("aria-pressed")).toBe("true");
      expect(s.querySelector(".style-help")!.textContent).toBe(RENDERER_INFO.svg.about);
      const rows = [...s.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent));
      expect(rows).toEqual(RENDERER_COMPARISON);
      expect(s.textContent).toContain("Save SVG");
    });

    it("switches, saying so while the canvas starts", async () => {
      let finish: () => void = () => {};
      const { choice, asked } = rendering(() => new Promise<void>((r) => (finish = r)));
      setup(undefined, choice);
      button("Canvas 2D").click();
      expect(asked).toEqual(["canvas"]);
      const status = section()!.querySelector(".style-status")!;
      expect(status.textContent).toBe("Starting the canvas renderer…");
      expect(section()!.querySelector(".style-help")!.textContent).toBe(RENDERER_INFO.canvas.about);
      expect(button("Canvas 2D").getAttribute("aria-pressed")).toBe("true");
      finish();
      await flush();
      expect(status.textContent).toBe("");
      button("Canvas 2D").click(); // already: nothing to do
      expect(asked).toEqual(["canvas"]);
      button("SVG").click();
      expect(asked).toEqual(["canvas", "svg"]);
      expect(status.textContent).toBe("");
    });

    it("says when the canvas can't start, and shows SVG chosen again", async () => {
      const { choice } = rendering(() => Promise.reject(new Error("no 2D canvas")));
      setup(undefined, choice);
      button("Canvas 2D").click();
      await flush();
      const status = section()!.querySelector(".style-status")!;
      expect(status.textContent).toBe(
        "The canvas renderer couldn't start in this browser (no 2D canvas), so it's still SVG.",
      );
      expect(status.classList.contains("is-warning")).toBe(true);
      expect(button("SVG").getAttribute("aria-pressed")).toBe("true");
      expect(section()!.querySelector(".style-help")!.textContent).toBe(RENDERER_INFO.svg.about);
    });

    it("leaves out a reason it doesn't have", async () => {
      const { choice } = rendering(() => Promise.reject("nope"));
      setup(undefined, choice);
      button("Canvas 2D").click();
      await flush();
      expect(section()!.querySelector(".style-status")!.textContent).toBe(
        "The canvas renderer couldn't start in this browser, so it's still SVG.",
      );
    });
  });
});
