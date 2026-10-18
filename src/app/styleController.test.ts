// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseAppearance } from "../appearance";
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

function setup(storage?: ReturnType<typeof makeApp>["storage"]) {
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
});
