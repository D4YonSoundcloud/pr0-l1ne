/**
 * The banner above the canvas: errors, hints and why a trace stopped early.
 * Its messages can hold buttons (`data-action="run"`) that do what they say.
 */

/**
 * What a message is about, so each kind looks different (styles.css):
 * - program  the program raised an error: its own output, not ours
 * - budget   it used up its steps or time, and was stopped
 * - tracer   PR0L1NE itself failed: a bug, worth reporting
 * - runtime  the language couldn't load (the network, or an outdated page)
 * - hint     a `viz:` hint that couldn't be applied
 * - shared   a program from a share link: someone else's code, not run yet
 */
export type BannerTone = "program" | "budget" | "tracer" | "runtime" | "hint" | "shared";

export class Banner {
  constructor(
    private readonly el: HTMLElement,
    actions: Record<string, () => void>,
  ) {
    el.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action && Object.hasOwn(actions, action)) actions[action]();
    });
  }

  /** Show a message (HTML: escape anything quoted from the program), or hide the banner with null. */
  show(html: string | null, tone: BannerTone = "program"): void {
    this.el.hidden = html === null;
    this.el.innerHTML = html ?? "";
    this.el.dataset.tone = tone;
  }
}
