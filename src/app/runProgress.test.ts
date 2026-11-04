// @vitest-environment jsdom
/** The toolbar line and the card that show how a run is going. */
import { beforeEach, describe, expect, it } from "vitest";
import { RunProgressView, seconds } from "./runProgress";

function setup() {
  document.body.innerHTML = `
    <span id="line" hidden>
      <span class="run-progress-bar" role="progressbar"><span></span></span>
      <span class="run-progress-text"></span>
      <button>Stop</button>
    </span>
    <div id="card" hidden>
      <ol><li data-stage="run"></li><li data-stage="prepare"></li></ol>
      <div class="run-card-bar" role="progressbar"><span></span></div>
      <p class="run-card-numbers"></p>
      <p class="run-card-left"></p>
      <button>Stop and show what's recorded</button>
    </div>
    <div id="canvas"></div>`;
  const line = document.getElementById("line")!;
  const card = document.getElementById("card")!;
  const canvas = document.getElementById("canvas")!;
  const said: string[] = [];
  let stops = 0;
  const view = new RunProgressView({ line, card, canvas, announce: (t) => said.push(t) }, () => stops++);
  return { view, line, card, canvas, said, stops: () => stops };
}

const stage = (card: HTMLElement, name: string) => card.querySelector(`[data-stage="${name}"]`)!;

describe("seconds", () => {
  it("reads as people say it", () => {
    expect(seconds(0.4)).toBe("0 s");
    expect(seconds(41)).toBe("41 s");
    expect(seconds(120)).toBe("2 min");
    expect(seconds(100)).toBe("1 min 40 s");
    expect(seconds(-3)).toBe("0 s");
  });
});

describe("the progress view", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("shows nothing until the first report, so a quick run never flickers", () => {
    s.view.start({ budget: "run", maxSteps: 1000, maxSeconds: 120 });
    expect(s.line.hidden).toBe(true);
    expect(s.card.hidden).toBe(true);
    expect(s.view.preparing()).toBe(false);
    s.view.done();
    expect(s.said).toEqual([]);
  });

  it("for Run: the line and the card, with the numbers, the time left and the old drawing dimmed", () => {
    s.view.start({ budget: "run", maxSteps: 1000, maxSeconds: 120 });
    s.view.update({ steps: 250, seconds: 41, line: 7 });
    expect(s.line.hidden).toBe(false);
    expect(s.line.querySelector(".run-progress-text")!.textContent).toBe("Running · 250 steps · 41 s of 2 min");
    expect(s.line.title).toMatch(/^At most 1 min 19 s left\. Line 7/);
    expect(s.card.hidden).toBe(false);
    expect(s.card.querySelector(".run-card-numbers")!.textContent).toBe("250 steps of 1,000 · 41 s of 2 min · line 7");
    expect(s.card.querySelector(".run-card-left")!.textContent).toBe(
      "At most 1 min 19 s left (sooner if your code finishes)",
    );
    expect(s.canvas.classList.contains("is-running")).toBe(true);
    expect(stage(s.card, "run").classList.contains("is-current")).toBe(true);
    // The bar shows whichever limit is closer: steps here (25%) are behind time (34%).
    const bar = s.card.querySelector(".run-card-bar")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("34");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("34%");
    s.view.update({ steps: 900, seconds: 42, line: 7 });
    expect(bar.getAttribute("aria-valuenow")).toBe("90");
    expect(s.said).toHaveLength(1); // announced once, not every update
  });

  it("then preparing the drawing: Stop goes, the stage moves on; done hides it all", () => {
    s.view.start({ budget: "run", maxSteps: 1000, maxSeconds: 120 });
    s.view.update({ steps: 1, seconds: 0.3, line: 1 });
    expect(s.view.preparing()).toBe(true);
    expect(stage(s.card, "run").classList.contains("is-done")).toBe(true);
    expect(stage(s.card, "prepare").getAttribute("aria-current")).toBe("step");
    expect(s.line.querySelector("button")!.hidden).toBe(true);
    expect(s.card.querySelector("button")!.hidden).toBe(true);
    expect(s.said.at(-1)).toBe("Preparing the drawing.");
    s.view.done();
    expect(s.line.hidden).toBe(true);
    expect(s.card.hidden).toBe(true);
    expect(s.canvas.classList.contains("is-running")).toBe(false);
    expect(s.line.querySelector("button")!.hidden).toBe(false); // ready for the next run
  });

  it("preparing a trace that takes a while shows how far it's got, even after a run too quick to report", () => {
    s.view.start({ budget: "run", maxSteps: 1000, maxSeconds: 120 });
    expect(s.view.preparing()).toBe(false); // nothing showing yet
    s.view.prepare({ label: "Finding graphs", done: 2100, total: 5300, share: 0.4 });
    expect(s.line.hidden).toBe(false);
    expect(s.card.hidden).toBe(false);
    expect(s.canvas.classList.contains("is-running")).toBe(true);
    expect(s.line.querySelector(".run-progress-text")!.textContent).toBe(
      "Preparing · Finding graphs · 2,100 of 5,300 steps",
    );
    expect(s.card.querySelector(".run-card-numbers")!.textContent).toBe("Finding graphs: 2,100 of 5,300 steps");
    expect(s.card.querySelector(".run-card-bar")!.getAttribute("aria-valuenow")).toBe("40");
    expect(stage(s.card, "run").classList.contains("is-done")).toBe(true);
    expect(stage(s.card, "prepare").classList.contains("is-current")).toBe(true);
    expect(s.card.querySelector("button")!.hidden).toBe(true); // the run is over: nothing to stop
    s.view.prepare({ label: "Finding graphs", done: 4000, total: 5300, share: 0.75 });
    expect(s.said).toEqual(["Preparing the drawing."]); // once
    expect(s.view.drawing()).toBe(true);
    expect(s.line.querySelector(".run-progress-text")!.textContent).toBe("Drawing…");
    expect(s.card.querySelector(".run-card-bar")!.getAttribute("aria-valuenow")).toBe("100");
    s.view.done();
    expect(s.card.hidden).toBe(true);
  });

  it("nothing showing: drawing doesn't wait for a frame", () => {
    s.view.start({ budget: "run", maxSteps: 1000, maxSeconds: 120 });
    expect(s.view.drawing()).toBe(false);
    expect(s.line.hidden).toBe(true);
  });

  it("for a Live run: only the line, never the card", () => {
    s.view.start({ budget: "live", maxSteps: 1000, maxSeconds: 5 });
    s.view.update({ steps: 1, seconds: 1, line: 1 });
    expect(s.line.hidden).toBe(false);
    expect(s.card.hidden).toBe(true);
    expect(s.canvas.classList.contains("is-running")).toBe(false);
  });

  it("both Stop buttons stop the run", () => {
    for (const button of document.querySelectorAll("button")) button.click();
    expect(s.stops()).toBe(2);
  });

  it("a report after the run is done is ignored", () => {
    s.view.update({ steps: 1, seconds: 1, line: 1 });
    expect(s.line.hidden).toBe(true);
  });
});
