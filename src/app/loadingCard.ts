/**
 * The loading card: while Python or PostgreSQL downloads (the first time
 * someone picks the language; later, while the browser's copy starts up), a
 * card over the canvas with a spinner and a bar, what's loading and how big
 * it is, so it's plain that something is happening. Once the worker counts
 * the bytes (worker/downloads.ts), the bar shows how much has arrived
 * ("42%"); when it all has, the runtime starts up, which takes a few
 * seconds more ("Starting Python"). Until the first count, the bar moves to
 * and fro. The toolbar's status says the same, with a small spinner
 * (styles.css, .status.is-loading).
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
    const bytes = status.kind === "loading" ? status.download : undefined;
    const share = bytes && bytes.total > 0 ? Math.min(1, bytes.loaded / bytes.total) : null;
    const starting = share !== null && share >= 1;
    set(".loading-verb", starting ? "Starting" : "Downloading");
    set(".loading-percent", share !== null && !starting ? ` · ${Math.floor(share * 100)}%` : "");
    const bar = this.card.querySelector<HTMLElement>(".loading-bar");
    if (bar) {
      // Counted: a bar that fills; not yet (or starting up, which can't be counted): one that moves.
      bar.classList.toggle("is-counted", share !== null && !starting);
      bar
        .querySelector<HTMLElement>("span")
        ?.style.setProperty("width", share !== null && !starting ? `${share * 100}%` : "");
      // A progressbar without a value is one that can't say how far (yet).
      if (share !== null && !starting) bar.setAttribute("aria-valuenow", String(Math.floor(share * 100)));
      else bar.removeAttribute("aria-valuenow");
    }
  }

  get visible(): boolean {
    return !this.card.hidden;
  }
}
