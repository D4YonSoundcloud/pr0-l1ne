// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ProgramStore } from "../programs";
import { createSettings, type KeyValueStorage } from "../settings";
import type { Trace } from "../trace/types";
import { PlaybackController, type StepAnimation } from "./playbackController";
import { AppStore } from "./state";

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

/** Playback controls over a trace of `steps` steps, with timers run by hand. */
function setup(steps = 10, storage = memoryStorage()) {
  document.body.innerHTML = `
    <button id="play">Play</button><select id="speed"></select>
    <button id="first"></button><button id="prev"></button><button id="next"></button><button id="last"></button>
    <input id="scrubber" type="range" />
    <div class="style-panel"><button id="in-panel"></button></div>
    <input id="field" />`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const settings = createSettings(storage);
  const app = new AppStore(settings, new ProgramStore(settings.programStorage()));
  let count = steps;
  const shown: { step: number; animation: StepAnimation }[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let reduced = false;
  const playback = new PlaybackController({
    app,
    els: {
      play: $("play"),
      speed: $("speed"),
      first: $("first"),
      prev: $("prev"),
      next: $("next"),
      last: $("last"),
      scrubber: $("scrubber"),
    },
    stepCount: () => count,
    show: (animation) => {
      shown.push({ step: app.get().stepIndex, animation });
      playback.updateControls();
    },
    ownsKeys: (target) => !!target.closest(".style-panel"),
    reducedMotion: () => reduced,
    setTimeout: (callback) => {
      timers.set(nextTimer, callback);
      return nextTimer++;
    },
    clearTimeout: (id) => void timers.delete(id),
  });
  /** Fire the pending playback timer (there's at most one). */
  const tick = () => {
    const [id, callback] = [...timers][0] ?? [];
    if (!callback) return false;
    timers.delete(id);
    callback();
    return true;
  };
  const key = (k: string, init: KeyboardEventInit = {}, target: HTMLElement = document.body) => {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return { handled: playback.handleKey(event), event };
  };
  return {
    app,
    settings,
    playback,
    shown,
    tick,
    key,
    $,
    setCount: (n: number) => {
      count = n;
    },
    setReduced: (on: boolean) => {
      reduced = on;
    },
  };
}

describe("PlaybackController", () => {
  it("skips the first two steps (an empty program) and stays within the trace", () => {
    const { playback, app } = setup(10);
    expect(playback.firstStep()).toBe(2);
    playback.goTo(0);
    expect(app.get().stepIndex).toBe(2);
    playback.goTo(Number.POSITIVE_INFINITY);
    expect(app.get().stepIndex).toBe(9);
  });

  it("starts a SQL trace at its first step: every stage is worth seeing", () => {
    const { playback, app } = setup(4);
    const step = { event: "line", line: 1, stack: [], heap: {}, stdoutLength: 0, loops: [] };
    const trace = { steps: [step, step, step, step], stdout: "", error: null, sql: { statements: [], stages: [] } };
    app.showTrace(trace as unknown as Trace, "", 3);
    expect(playback.firstStep()).toBe(0);
    playback.goTo(0);
    expect(app.get().stepIndex).toBe(0);
  });

  it("animates single steps, not jumps, and never when motion is reduced", () => {
    const { playback, shown, setReduced } = setup(10);
    playback.goTo(2);
    playback.step(1);
    expect(shown.at(-1)).toEqual({ step: 3, animation: { playing: false } });
    playback.goTo(8);
    expect(shown.at(-1)).toEqual({ step: 8, animation: null });
    setReduced(true);
    playback.step(-1);
    expect(shown.at(-1)).toEqual({ step: 7, animation: null });
  });

  it("tells the renderers the animation only while drawing", () => {
    const { playback } = setup(10);
    let during: StepAnimation | undefined;
    const original = playback.updateControls.bind(playback);
    playback.updateControls = () => {
      during = playback.animation;
      original();
    };
    playback.goTo(2);
    playback.step(1);
    expect(during).toEqual({ playing: false });
    expect(playback.animation).toBeNull();
  });

  it("keeps the buttons and scrubber in step", () => {
    const { playback, $ } = setup(10);
    playback.goTo(2);
    expect($<HTMLButtonElement>("prev").disabled).toBe(true);
    expect($<HTMLButtonElement>("next").disabled).toBe(false);
    expect($<HTMLInputElement>("scrubber").min).toBe("2");
    expect($<HTMLInputElement>("scrubber").max).toBe("9");
    playback.goTo(9);
    expect($<HTMLButtonElement>("next").disabled).toBe(true);
    expect($<HTMLInputElement>("scrubber").value).toBe("9");
  });

  it("disables everything when there's nothing to step through", () => {
    const { playback, $, setCount } = setup(10);
    setCount(0);
    playback.updateControls();
    expect($<HTMLButtonElement>("play").disabled).toBe(true);
    expect($<HTMLInputElement>("scrubber").disabled).toBe(true);
    playback.goTo(5); // nothing happens
  });

  it("plays to the end on a timer, then stops", () => {
    const { playback, app, tick, $ } = setup(5);
    playback.goTo(2);
    playback.togglePlay();
    expect(app.get().playing).toBe(true);
    expect($("play").textContent).toBe("Pause");
    while (tick()) {}
    expect(app.get().stepIndex).toBe(4);
    expect(app.get().playing).toBe(false);
    expect($("play").textContent).toBe("Play");
  });

  it("plays again from the start when already at the end", () => {
    const { playback, app } = setup(5);
    playback.goTo(4);
    playback.setPlaying(true);
    expect(app.get().stepIndex).toBe(2);
  });

  it("pauses when you step by hand", () => {
    const { playback, app, tick } = setup(10);
    playback.goTo(2);
    playback.setPlaying(true);
    tick();
    playback.step(1);
    expect(app.get().playing).toBe(false);
  });

  it("Ctrl/Cmd + Enter plays, and again goes back to where it started", () => {
    const { playback, app, tick, key } = setup(10);
    playback.goTo(4);
    expect(key("Enter", { ctrlKey: true }).handled).toBe(true);
    tick();
    tick();
    expect(app.get().stepIndex).toBe(6);
    key("Enter", { metaKey: true });
    expect(app.get().stepIndex).toBe(4);
    expect(app.get().playing).toBe(false);
  });

  it("remembers the speed, and only offers the listed ones", () => {
    const storage = memoryStorage();
    const { playback, app, $ } = setup(10, storage);
    playback.setSpeed(8);
    expect(app.get().speed).toBe(8);
    playback.setSpeed(3);
    expect(app.get().speed).toBe(8);
    expect(setup(10, storage).app.get().speed).toBe(8);
    expect([...$<HTMLSelectElement>("speed").options].map((o) => o.value)).toEqual(["0.5", "1", "2", "4", "8", "16"]);
  });

  it("steps with the arrows, Home, End and F10", () => {
    const { playback, app, key } = setup(10);
    playback.goTo(5);
    key("ArrowRight");
    expect(app.get().stepIndex).toBe(6);
    key("ArrowLeft");
    key("F10", { shiftKey: true });
    expect(app.get().stepIndex).toBe(4);
    key("End");
    expect(app.get().stepIndex).toBe(9);
    key("Home");
    expect(app.get().stepIndex).toBe(2);
  });

  it("leaves keys alone where they mean something else", () => {
    const { playback, app, key, $ } = setup(10);
    playback.goTo(5);
    expect(key("ArrowRight", {}, $("field")).handled).toBe(false); // typing in a field
    expect(key(" ", {}, $("play")).handled).toBe(false); // Space presses a button
    expect(key("ArrowRight", {}, $("in-panel")).handled).toBe(false); // the Style panel's own keys
    expect(key("F10", {}, $("in-panel")).handled).toBe(true); // ...but F10 still steps
    expect(key("x").handled).toBe(false);
    expect(app.get().stepIndex).toBe(6);
  });

  it("Space plays and pauses", () => {
    const { playback, app, key } = setup(10);
    playback.goTo(2);
    key(" ");
    expect(app.get().playing).toBe(true);
    key(" ");
    expect(app.get().playing).toBe(false);
  });

  it("replays a step: draws the one before, then animates into it", () => {
    const { playback, shown } = setup(10);
    playback.goTo(5);
    shown.length = 0;
    playback.replay();
    expect(shown).toEqual([
      { step: 4, animation: null },
      { step: 5, animation: { playing: false } },
    ]);
  });
});
