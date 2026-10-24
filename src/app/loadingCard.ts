/**
 * The loading card: while Python or PostgreSQL downloads (the first time
 * someone picks the language; later, while the browser's copy starts up), a
 * card over the canvas with a spinner and a moving bar, what's loading and
 * how big it is, so it's plain that something is happening. The toolbar's
 * status says the same, with a small spinner (styles.css, .status.is-loading).
 *
 * Languages that are ready at once (JavaScript, TypeScript) never show it.
 */
import type { RunnerStatus } from "../worker/runner";
import type { Download } from "./runController";

export class LoadingCard {
  constructor(private readonly card: HTMLElement) {}

  show(status: RunnerStatus, download: Download | null): void {
    const loading = status.kind === "loading" && download !== null;
    this.card.hidden = !loading;
    if (!loading) return;
    const set = (selector: string, text: string) => {
      const el = this.card.querySelector(selector);
      if (el) el.textContent = text;
    };
    set(".loading-what", download.name);
    set(".loading-size", download.size);
  }

  get visible(): boolean {
    return !this.card.hidden;
  }
}
