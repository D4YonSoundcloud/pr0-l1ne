/**
 * Moving through the steps of a trace: first / previous / next / last, the
 * scrubber, Play and Pause on a timer, the speed menu, and the keys that do
 * the same (arrows, Home / End, Space, F10, Ctrl/Cmd + Enter).
 *
 * The step on screen, whether it's playing and the speed live in the app
 * state (state.ts). Drawing a step is the app's job: this controller calls
 * `show(animation)` after each move, saying whether the move should animate
 * (a single step forward or back does; jumps don't).
 */
import { type AppStore, SPEEDS } from "./state";

export interface PlaybackElements {
  play: HTMLButtonElement;
  speed: HTMLSelectElement;
  first: HTMLButtonElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  last: HTMLButtonElement;
  scrubber: HTMLInputElement;
}

/** How the step being drawn should animate, or null for no animation. */
export type StepAnimation = { playing: boolean } | null;

export interface PlaybackOptions {
  app: AppStore;
  els: PlaybackElements;
  /** How many steps the current trace has (0 when there's none). */
  stepCount(): number;
  /** Draw the step now in the app state. */
  show(animation: StepAnimation): void;
  /**
   * An area whose controls handle their own keys (the Style panel): Space,
   * arrows, Home and End there aren't stepping keys.
   */
  ownsKeys?(target: HTMLElement): boolean;
  /** The person asked for less motion (prefers-reduced-motion). */
  reducedMotion?(): boolean;
  /** Timers, replaceable in tests. */
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

/**
 * The first step worth showing. Every trace starts with "called Global" and
 * "next is line 1", which both show an empty program, so the timeline starts
 * at the third step: the state after line 1 ran.
 */
const SKIPPED_STEPS = 2;

export class PlaybackController {
  private timer = 0;
  /** The step the current (or last) playback started from. */
  private playOrigin: number | null = null;
  /** The animation for the step being drawn, while it's drawn. */
  private drawing: StepAnimation = null;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(private readonly options: PlaybackOptions) {
    this.setTimer = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));
    const { els, app } = options;

    for (const value of SPEEDS) {
      const label = `${value} ${value === 1 ? "step" : "steps"}/s`;
      els.speed.append(new Option(label, String(value), false, value === app.get().speed));
    }
    els.speed.addEventListener("change", () => this.setSpeed(Number(els.speed.value)));
    els.play.addEventListener("click", () => this.togglePlay());
    els.first.addEventListener("click", () => this.goTo(this.firstStep()));
    els.prev.addEventListener("click", () => this.step(-1));
    els.next.addEventListener("click", () => this.step(1));
    els.last.addEventListener("click", () => this.goTo(Number.POSITIVE_INFINITY));
    els.scrubber.addEventListener("input", () => this.goTo(Number(els.scrubber.value)));

    app.watch(
      (s) => s.playing,
      (playing) => {
        els.play.textContent = playing ? "Pause" : "Play";
        els.play.setAttribute("aria-pressed", String(playing));
      },
    );
    this.updateControls();
  }

  private get state() {
    return this.options.app.get();
  }

  /** The first step worth showing. */
  firstStep(): number {
    const count = this.options.stepCount();
    return count ? Math.max(0, Math.min(SKIPPED_STEPS, count - 1)) : 0;
  }

  /** The animation for the step being drawn right now (for the app's renderers). */
  get animation(): StepAnimation {
    return this.drawing;
  }

  /**
   * Move to a step. A single step forward or back animates; jumps don't.
   * Any move that isn't playback pauses playback.
   */
  goTo(index: number, how: { playing?: boolean } = {}): void {
    const count = this.options.stepCount();
    if (!count) return;
    if (!how.playing) this.setPlaying(false);
    const next = Math.max(this.firstStep(), Math.min(count - 1, index));
    const single = Math.abs(next - this.state.stepIndex) === 1;
    const reduced = this.options.reducedMotion?.() ?? false;
    this.options.app.setStep(next);
    this.draw(single && !reduced ? { playing: !!how.playing } : null);
  }

  /** One step forward (1) or back (-1). */
  step(delta: number): void {
    this.goTo(this.state.stepIndex + delta);
  }

  /** Draw the step before this one, then animate into this one (previews the Style panel's easing). */
  replay(): void {
    const count = this.options.stepCount();
    if (!count) return;
    const target = this.state.stepIndex;
    const from = target > this.firstStep() ? target - 1 : target + 1;
    if (from >= count) return;
    this.options.app.setStep(from);
    this.draw(null);
    this.goTo(target);
  }

  private draw(animation: StepAnimation): void {
    this.drawing = animation;
    try {
      this.options.show(animation);
    } finally {
      this.drawing = null;
    }
  }

  togglePlay(): void {
    this.setPlaying(!this.state.playing);
  }

  setPlaying(on: boolean): void {
    this.clearTimer(this.timer);
    if (on === this.state.playing) {
      if (on) this.scheduleTick();
      return;
    }
    this.options.app.setPlaying(on);
    if (!on || !this.options.stepCount()) return;
    // At the end: play again from the start.
    if (this.state.stepIndex >= this.options.stepCount() - 1) this.goTo(this.firstStep(), { playing: true });
    this.playOrigin = this.state.stepIndex;
    this.scheduleTick();
  }

  /**
   * Ctrl/Cmd + Enter: play from the current step. Pressed again while
   * playing, it stops and goes back to the step playing started from, so
   * you can watch the same stretch again.
   */
  playOrRewind(): void {
    if (!this.options.stepCount()) return;
    if (this.state.playing && this.playOrigin !== null) {
      this.goTo(this.playOrigin); // goTo pauses
      return;
    }
    this.setPlaying(true);
  }

  setSpeed(speed: number): void {
    this.options.app.setSpeed(speed);
    this.options.els.speed.value = String(this.state.speed);
    if (this.state.playing) this.setPlaying(true); // restart the timer at the new speed
  }

  private scheduleTick(): void {
    this.timer = this.setTimer(() => {
      if (!this.state.playing) return;
      if (this.state.stepIndex >= this.options.stepCount() - 1) {
        this.setPlaying(false);
        return;
      }
      this.goTo(this.state.stepIndex + 1, { playing: true });
      this.scheduleTick();
    }, 1000 / this.state.speed);
  }

  /** The buttons and scrubber, for the current trace and step. Call after each draw. */
  updateControls(): void {
    const { els } = this.options;
    const total = this.options.stepCount();
    const first = this.firstStep();
    const index = this.state.stepIndex;
    els.scrubber.min = String(first);
    els.scrubber.max = String(Math.max(first, total - 1));
    els.scrubber.value = String(index);
    els.scrubber.disabled = total - first <= 1;
    els.play.disabled = total - first <= 1;
    els.first.disabled = els.prev.disabled = index <= first;
    els.next.disabled = els.last.disabled = index >= total - 1;
  }

  /**
   * The stepping keys, for a keydown outside the editor. Returns true when
   * the key was one of them (and has been handled).
   * - Ctrl/Cmd + Enter: play, or go back to where playing started
   * - F10 / Shift + F10: next / previous step (as in VS Code's debugger)
   * - Space: play or pause; arrows, Home and End: move (not while typing
   *   in a field, or on a button, where those keys already mean something)
   */
  handleKey(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    const handled = (action: () => void) => {
      event.preventDefault();
      action();
      return true;
    };
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") return handled(() => this.playOrRewind());
    if (event.key === "F10") return handled(() => this.step(event.shiftKey ? -1 : 1));
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return false;
    if (target && this.options.ownsKeys?.(target)) return false;
    if (event.key === " ") {
      if (target instanceof HTMLButtonElement || target instanceof HTMLTextAreaElement) return false;
      return handled(() => this.togglePlay());
    }
    const moves: Record<string, () => void> = {
      ArrowLeft: () => this.step(-1),
      ArrowRight: () => this.step(1),
      Home: () => this.goTo(this.firstStep()),
      End: () => this.goTo(Number.POSITIVE_INFINITY),
    };
    const move = moves[event.key];
    return move ? handled(move) : false;
  }
}
