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
    });
  }

  private static openProgramFor(settings: Settings, programs: ProgramStore, language: LanguageId): Program | null {
    return programs.get(settings.openProgram(language).get()) ?? null;
  }

  /** Switch language, reopening the program that was open in it. */
  setLanguage(language: LanguageId): void {
    if (language === this.get().language) return;
    this.settings.language.set(language);
    this.update("setLanguage", {
      language,
      program: AppStore.openProgramFor(this.settings, this.programs, language),
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

  /** The saved program now open (null: the code isn't a saved program). */
  setProgram(program: Program | null): void {
    this.settings.openProgram(this.get().language).set(program?.id ?? "");
    this.update("setProgram", { program });
  }
}
