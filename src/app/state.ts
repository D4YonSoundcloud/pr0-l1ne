/**
 * The app's state, and the named actions that change it.
 *
 * Controllers read the state (`app.get()`), change it only through the
 * actions here, and react to changes with `app.watch(...)`. Each action also
 * saves what should be remembered between visits (settings.ts).
 *
 * The state grows as more of main.ts moves into controllers (see
 * docs/development.md, "How the app is put together").
 */
import type { LanguageId } from "../languages";
import type { Program, ProgramStore } from "../programs";
import type { Settings } from "../settings";
import type { Trace } from "../trace/types";
import { Store } from "./store";

/** Playback speeds offered, in steps per second. */
export const SPEEDS = [0.5, 1, 2, 4, 8, 16] as const;
const DEFAULT_SPEED = 2;

export interface AppState {
  /** The language in the editor. */
  readonly language: LanguageId;
  /** The saved program open in the editor, or null for unsaved code or an example. */
  readonly program: Program | null;
  /** The step on screen (an index into the trace's steps). */
  readonly stepIndex: number;
  /** Playing through the steps on a timer. */
  readonly playing: boolean;
  /** Playback speed, in steps per second (one of SPEEDS). */
  readonly speed: number;
  /** The trace on screen (hints applied), or null before the first run. */
  readonly trace: Trace | null;
  /** The code that trace ran, so Measure can tell whether it still matches. */
  readonly tracedCode: string | null;
  /**
   * The picture is from older code: the latest run failed to start (a
   * syntax error mid-typing), crashed or timed out. It's shown dimmed.
   */
  readonly stale: boolean;
  /** Measure (or a growth run) is using the runner; traced runs wait until it's done. */
  readonly measuring: boolean;
  /**
   * The editor holds a program from a share link, unedited and not saved
   * (see shareController.ts). It's nobody's saved program, and nothing is
   * remembered or run until the person edits it, runs it or saves it.
   */
  readonly shared: boolean;
}

export class AppStore extends Store<AppState> {
  constructor(
    private readonly settings: Settings,
    private readonly programs: ProgramStore,
  ) {
    // First visit: JavaScript, which is ready at once. Python downloads about
    // 6 MB the first time, so it only loads when someone picks it.
    const language = settings.language.get() ?? "javascript";
    const speed = settings.speed.get();
    super({
      language,
      program: AppStore.openProgramFor(settings, programs, language),
      stepIndex: 0,
      playing: false,
      speed: speed !== null && (SPEEDS as readonly number[]).includes(speed) ? speed : DEFAULT_SPEED,
      trace: null,
      tracedCode: null,
      stale: false,
      measuring: false,
      shared: false,
    });
  }

  private static openProgramFor(settings: Settings, programs: ProgramStore, language: LanguageId): Program | null {
    return programs.get(settings.openProgram(language).get()) ?? null;
  }

  /**
   * Switch language, reopening the program that was open in it. The trace
   * goes: it has nothing to do with the other language's code.
   */
  setLanguage(language: LanguageId): void {
    if (language === this.get().language) return;
    this.settings.language.set(language);
    this.update("setLanguage", {
      language,
      program: AppStore.openProgramFor(this.settings, this.programs, language),
      trace: null,
      tracedCode: null,
      stale: false,
      stepIndex: 0,
      shared: false,
    });
  }

  /** Show a step (already within the trace: see PlaybackController.goTo). */
  setStep(stepIndex: number): void {
    this.update("setStep", { stepIndex });
  }

  setPlaying(playing: boolean): void {
    this.update("setPlaying", { playing });
  }

  setSpeed(speed: number): void {
    if (!(SPEEDS as readonly number[]).includes(speed)) return;
    this.settings.speed.set(speed);
    this.update("setSpeed", { speed });
  }

  /** A run finished: show its trace, at `stepIndex`. */
  showTrace(trace: Trace, code: string, stepIndex: number): void {
    this.update("showTrace", { trace, tracedCode: code, stale: false, stepIndex });
  }

  /** The latest run didn't produce a picture: keep the old one, dimmed. */
  markStale(): void {
    this.update("markStale", { stale: true });
  }

  setMeasuring(measuring: boolean): void {
    this.update("setMeasuring", { measuring });
  }

  /** The saved program now open (null: the code isn't a saved program). */
  setProgram(program: Program | null): void {
    this.settings.openProgram(this.get().language).set(program?.id ?? "");
    this.update("setProgram", { program, shared: false });
  }

  /**
   * A program from a share link is in the editor (in the current language).
   * No saved program is open, and none of the person's own is forgotten:
   * which program they had open isn't remembered as closed. The picture
   * goes, since it was of other code.
   */
  openShared(): void {
    this.update("openShared", {
      program: null,
      shared: true,
      trace: null,
      tracedCode: null,
      stale: false,
      stepIndex: 0,
    });
  }

  /** The shared program was edited: it's ordinary unsaved code now. */
  keepShared(): void {
    if (this.get().shared) this.update("keepShared", { shared: false });
  }
}
