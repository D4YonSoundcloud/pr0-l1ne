/**
 * How a run is going, while it goes: a line in the toolbar (a bar, the
 * steps and seconds so far, and Stop), and for Run, a card over the canvas
 * with the stages (running the code, then preparing the drawing), the same
 * numbers, how long it can take at most, and Stop. The last drawing stays
 * behind the card, dimmed.
 *
 * Nothing shows until the tracer's first report (a quarter second in), so
 * a quick run, or a Live run while typing, never flickers. The numbers are
 * the tracer's own (trace/stream.ts RunProgress): steps recorded out of the
 * step budget, and seconds out of the time limit. Neither is a guess, so
 * the bar shows whichever is closer to its limit, and the time left is "at
 * most": the run ends when either runs out, or sooner when the program does.
 *
 * Then the trace is prepared (trace/prepare.ts): work over the whole run,
 * done a slice at a time, so the bar moves ("Finding graphs · 2,100 of
 * 6,552 steps") and the page answers meanwhile. That shows even after a
 * run too quick to report, but only once it takes more than a slice. Last,
 * "Drawing", for the first drawing, which the page can't do in slices yet.
 *
 * Screen readers hear when the card appears and when the stage changes, not
 * every update (the bars are progressbars with their values, for whoever
 * looks).
 */
import type { RunProgress } from "../trace/stream";
import type { Progress } from "../trace/work";
import type { Budget } from "./runController";

/** What the run controller tells the view (tests pass a fake). */
export interface ProgressView {
  /** A run starts: its budget (only Run gets the card) and its limits. */
  start(run: { budget: Budget; maxSteps: number; maxSeconds: number }): void;
  /** How far it's got. */
  update(progress: RunProgress): void;
  /** The trace arrived and is about to be prepared. True when the view is showing it (so let it paint first). */
  preparing(): boolean;
  /** How far preparing it has got (only when it takes more than a slice). */
  prepare(progress: Progress): void;
  /** Prepared, and about to be drawn. True when the view is showing it (so let it paint first). */
  drawing(): boolean;
  /** Drawn, or nothing to draw: hide it all. */
  done(): void;
}

export interface ProgressElements {
  /** The toolbar's line: a bar, text and Stop. */
  line: HTMLElement;
  /** The card over the canvas. */
  card: HTMLElement;
  /** The canvas, dimmed while the card shows. */
  canvas: HTMLElement;
  /** Says things to screen readers (a polite live region). */
  announce(text: string): void;
}

/** Seconds as people say them: "41 s", "1 min 40 s". */
export function seconds(value: number): string {
  const s = Math.max(0, Math.round(value));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

export class RunProgressView implements ProgressView {
  private run: { budget: Budget; maxSteps: number; maxSeconds: number } | null = null;
  private lineShown = false;
  private cardShown = false;
  private prepareShown = false;

  constructor(
    private readonly els: ProgressElements,
    onStop: () => void,
  ) {
    for (const button of [...els.line.querySelectorAll("button"), ...els.card.querySelectorAll("button")])
      button.addEventListener("click", onStop);
  }

  start(run: { budget: Budget; maxSteps: number; maxSeconds: number }): void {
    this.run = run;
    this.hide();
  }

  update(progress: RunProgress): void {
    const run = this.run;
    if (!run) return;
    const share = Math.min(1, Math.max(progress.steps / run.maxSteps, progress.seconds / run.maxSeconds));
    const percent = String(Math.round(share * 100));
    const steps = `${progress.steps.toLocaleString()} step${progress.steps === 1 ? "" : "s"}`;
    const time = `${seconds(progress.seconds)} of ${seconds(run.maxSeconds)}`;
    const left = `At most ${seconds(run.maxSeconds - progress.seconds)} left`;

    const { line, card, canvas } = this.els;
    this.setBar(line.querySelector(".run-progress-bar"), percent);
    this.setText(line.querySelector(".run-progress-text"), `Running · ${steps} · ${time}`);
    line.title = `${left}. Line ${progress.line} is running. Stop shows what was recorded so far.`;
    if (!this.lineShown) {
      this.lineShown = true;
      line.hidden = false;
    }

    if (run.budget !== "run") return;
    this.setBar(card.querySelector(".run-card-bar"), percent);
    this.setText(
      card.querySelector(".run-card-numbers"),
      `${steps} of ${run.maxSteps.toLocaleString()} · ${time} · line ${progress.line}`,
    );
    this.setText(card.querySelector(".run-card-left"), `${left} (sooner if your code finishes)`);
    if (!this.cardShown) {
      this.cardShown = true;
      this.stage("run");
      card.hidden = false;
      canvas.classList.add("is-running");
      this.els.announce("Running your code. Stop shows what was recorded so far.");
    }
  }

  preparing(): boolean {
    if (!this.lineShown && !this.cardShown) return false;
    this.toPrepare();
    return true;
  }

  prepare(progress: Progress): void {
    const run = this.run;
    if (!run) return;
    // Shown now if the run was too quick to: preparing is what takes the time.
    if (!this.lineShown) {
      this.lineShown = true;
      this.els.line.hidden = false;
    }
    if (run.budget === "run" && !this.cardShown) {
      this.cardShown = true;
      this.els.card.hidden = false;
      this.els.canvas.classList.add("is-running");
    }
    this.toPrepare();
    const percent = String(Math.round(Math.min(1, Math.max(0, progress.share)) * 100));
    const steps = `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} steps`;
    this.setBar(this.els.line.querySelector(".run-progress-bar"), percent);
    this.setText(this.els.line.querySelector(".run-progress-text"), `Preparing · ${progress.label} · ${steps}`);
    if (!this.cardShown) return;
    this.setBar(this.els.card.querySelector(".run-card-bar"), percent);
    this.setText(this.els.card.querySelector(".run-card-numbers"), `${progress.label}: ${steps}`);
  }

  drawing(): boolean {
    if (!this.lineShown && !this.cardShown) return false;
    this.toPrepare();
    this.setBar(this.els.line.querySelector(".run-progress-bar"), "100");
    this.setText(this.els.line.querySelector(".run-progress-text"), "Drawing…");
    if (this.cardShown) {
      this.setBar(this.els.card.querySelector(".run-card-bar"), "100");
      this.setText(this.els.card.querySelector(".run-card-numbers"), "Drawing the first step");
    }
    return true;
  }

  /** On to preparing the drawing (once): the stage moves on, Stop goes (the run is over). */
  private toPrepare(): void {
    if (this.prepareShown) return;
    this.prepareShown = true;
    this.setText(this.els.line.querySelector(".run-progress-text"), "Preparing the drawing…");
    this.els.line.querySelector<HTMLButtonElement>("button")?.setAttribute("hidden", "");
    if (this.cardShown) {
      this.stage("prepare");
      this.setText(this.els.card.querySelector(".run-card-left"), "");
      this.els.card.querySelector<HTMLButtonElement>("button")?.setAttribute("hidden", "");
    }
    this.els.announce("Preparing the drawing.");
  }

  done(): void {
    this.run = null;
    this.hide();
  }

  private hide(): void {
    const { line, card, canvas } = this.els;
    line.hidden = true;
    card.hidden = true;
    canvas.classList.remove("is-running");
    for (const button of [...line.querySelectorAll("button"), ...card.querySelectorAll("button")])
      button.removeAttribute("hidden");
    this.lineShown = false;
    this.cardShown = false;
    this.prepareShown = false;
  }

  /** Mark the card's stages: those before `now` done, `now` current. */
  private stage(now: "run" | "prepare"): void {
    const order = ["run", "prepare"];
    for (const li of this.els.card.querySelectorAll<HTMLElement>("[data-stage]")) {
      const at = order.indexOf(li.dataset.stage ?? "");
      li.classList.toggle("is-done", at < order.indexOf(now));
      li.classList.toggle("is-current", at === order.indexOf(now));
      if (at === order.indexOf(now)) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    }
  }

  private setBar(bar: Element | null, percent: string): void {
    if (!bar) return;
    bar.setAttribute("aria-valuenow", percent);
    (bar.firstElementChild as HTMLElement | null)?.style.setProperty("width", `${percent}%`);
  }

  private setText(el: Element | null, text: string): void {
    if (el && el.textContent !== text) el.textContent = text;
  }
}
