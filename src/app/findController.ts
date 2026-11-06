/**
 * Find a step where something's true: the box beside the Output and
 * Changes tabs takes a condition as a `viz: check` does (`best > 10`,
 * `len(stack) == 0`, `i == j and nums[i] > 3`), worked out where the trace
 * is (the layout worker, trace/history.ts findWhere) with each step's
 * variables. Enter or ▶: the next step after this one where it's true;
 * Shift + Enter or ◀: the one before. When there's none, or it doesn't
 * read, it says so beside the box.
 */
import type { LayoutService } from "../layout/service";
import type { AppStore } from "./state";

export interface FindOptions {
  app: AppStore;
  layout: Pick<LayoutService, "find">;
  els: { find: HTMLFormElement; findInput: HTMLInputElement; findPrev: HTMLButtonElement; findNote: HTMLElement };
  /** Go to a step (PlaybackController.goTo). */
  goTo(step: number): void;
  /** The timeline's first step (PlaybackController.firstStep). */
  firstStep(): number;
}

export class FindController {
  /** Searches made, to answer only the last one. */
  private asked = 0;
  /** Resolves once the last search is answered (tests wait for it). */
  private searching: Promise<void> = Promise.resolve();

  constructor(private readonly options: FindOptions) {
    const { els, app } = options;
    els.find.addEventListener("submit", (event) => {
      event.preventDefault();
      this.find(false);
    });
    els.findPrev.addEventListener("click", () => this.find(true));
    els.findInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        this.find(true);
      }
    });
    els.findInput.addEventListener("input", () => this.say(""));
    app.watch(
      (s) => s.trace,
      () => this.say(""),
    );
  }

  /** Go to the next step where the condition is true (`back`: the one before this step). */
  find(back: boolean): Promise<void> {
    const { app, layout, els } = this.options;
    const text = els.findInput.value.trim();
    const { trace, stale, stepIndex } = app.get();
    if (!text) {
      this.say("");
      return Promise.resolve();
    }
    if (!trace?.steps) {
      this.say("Run the code first.");
      return Promise.resolve();
    }
    if (stale) {
      this.say("The code changed since it ran: run it again first.");
      return Promise.resolve();
    }
    const asked = ++this.asked;
    this.searching = layout.find(text, stepIndex, back, this.options.firstStep()).then((found) => {
      if (asked !== this.asked || app.get().trace !== trace) return;
      if (found.error) this.say(`Can't read that: ${found.error}.`, true);
      else if (found.step === null)
        this.say(back ? "Not true at any step before this one." : "Not true at any step after this one.");
      else {
        this.say("");
        this.options.goTo(found.step);
      }
    });
    return this.searching;
  }

  /** Resolves once the last search is answered. */
  found(): Promise<void> {
    return this.searching;
  }

  private say(text: string, error = false): void {
    const note = this.options.els.findNote;
    note.textContent = text;
    note.classList.toggle("is-error", error);
  }
}
