/**
 * Under the code, two tabs: Output (what the program printed so far) and
 * Changes (what changed at the step on screen, in words: `i: 1 → 2`,
 * `nums[2]: 5 → 3`; trace/changes.ts). The changes are worked out where
 * the trace is (the layout worker), only while the tab is open. Read out
 * to screen readers as each step is shown (not while playing, which would
 * be a step's worth of words several times a second).
 */
import type { LayoutService } from "../layout/service";
import type { Settings } from "../settings";
import type { StepChange, StepChanges } from "../trace/changes";
import type { ValueTarget } from "../trace/history";
import type { AppStore } from "./state";

export interface ChangesElements {
  outputTab: HTMLButtonElement;
  changesTab: HTMLButtonElement;
  output: HTMLElement;
  changes: HTMLElement;
}

export interface ChangesOptions {
  app: AppStore;
  settings: Pick<Settings, "consoleTab">;
  layout: Pick<LayoutService, "changes">;
  els: ChangesElements;
  /** A change's name opens its value's history (app/historyController.ts). */
  history?: { show(target: ValueTarget, at: HTMLElement): void };
}

export class ChangesView {
  /** Requests made, to show only the last one's answer. */
  private asked = 0;
  /** Resolves once the step asked for last is listed (tests wait for it). */
  private listing: Promise<void> = Promise.resolve();

  constructor(private readonly options: ChangesOptions) {
    const { els, settings } = options;
    els.outputTab.addEventListener("click", () => this.open("output"));
    els.changesTab.addEventListener("click", () => this.open("changes"));
    // Tabs: the arrow keys move between them (and open the one they reach), as in any tab list.
    for (const tab of [els.outputTab, els.changesTab])
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? "output"
            : event.key === "End"
              ? "changes"
              : tab === els.outputTab
                ? "changes"
                : "output";
        this.open(next);
        (next === "output" ? els.outputTab : els.changesTab).focus();
      });
    this.show(settings.consoleTab.get());
    options.app.watch(
      (s) => s.playing,
      (playing) => els.changes.setAttribute("aria-live", playing ? "off" : "polite"),
    );
    els.changes.setAttribute("aria-live", "polite");
  }

  /** Is the Changes tab open? */
  get isOpen(): boolean {
    return this.options.settings.consoleTab.get() === "changes";
  }

  /** Open a tab (and remember it). */
  open(tab: "output" | "changes"): void {
    this.options.settings.consoleTab.set(tab);
    this.show(tab);
    if (tab === "changes") this.render();
  }

  private show(tab: "output" | "changes"): void {
    const { els } = this.options;
    const changes = tab === "changes";
    els.outputTab.setAttribute("aria-selected", String(!changes));
    els.changesTab.setAttribute("aria-selected", String(changes));
    els.outputTab.tabIndex = changes ? -1 : 0;
    els.changesTab.tabIndex = changes ? 0 : -1;
    els.output.hidden = changes;
    els.changes.hidden = !changes;
  }

  /** List what changed at the step on screen (StepView calls this after every move and run). */
  render(): void {
    if (!this.isOpen) return;
    const { app, layout } = this.options;
    const { trace, stepIndex } = app.get();
    const asked = ++this.asked;
    if (!trace?.steps) {
      this.note("");
      return;
    }
    if (trace.sql) {
      this.note("A SQL step is its tables: the canvas shows what each clause did.");
      return;
    }
    if (stepIndex === 0) {
      this.note("The run starts here: nothing has changed yet.");
      return;
    }
    this.listing = layout.changes(stepIndex).then((changes) => {
      // A newer step asked for, or the trace changed, meanwhile.
      if (asked !== this.asked || app.get().trace !== trace) return;
      this.list(changes);
    });
  }

  /** Resolves once the step asked for last is listed. */
  listed(): Promise<void> {
    return this.listing;
  }

  private note(text: string): void {
    const p = document.createElement("p");
    p.className = "changes-note";
    p.textContent = text;
    this.options.els.changes.replaceChildren(...(text ? [p] : []));
  }

  private list({ changes, more }: StepChanges): void {
    if (!changes.length) {
      this.note("Nothing changed at this step.");
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "changes-list";
    for (const change of changes) ul.append(item(change, this.options.history));
    if (more) {
      const li = document.createElement("li");
      li.className = "change-tag";
      li.textContent = `and ${more.toLocaleString()} more`;
      ul.append(li);
    }
    this.options.els.changes.replaceChildren(ul);
  }
}

/** One change: its name, its value before (struck through) and after; "new" or "gone" when it appeared or went. */
function item(change: StepChange, history: ChangesOptions["history"]): HTMLLIElement {
  const li = document.createElement("li");
  const span = (className: string, text: string) => {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = text;
    return el;
  };
  /** Words for screen readers, where the page shows an arrow or a strike-through. */
  const said = (text: string) => span("visually-hidden", text);
  const target = change.target;
  if (target && history) {
    // Its name opens its history: every value it had over the run, and a way to each change.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "change-name change-name-button";
    button.textContent = change.name;
    button.title = `${change.name} over the whole run: its values, and the steps where it changed`;
    button.addEventListener("click", () => history.show(target, button));
    li.append(button);
  } else li.append(span("change-name", change.name));
  if (change.frame) li.append(span("change-frame", ` in ${change.frame}()`));
  li.append(": ");
  if (change.before === null) {
    li.append(span("change-after", change.after ?? ""), " ", span("change-tag", "new"));
  } else if (change.after === null) {
    li.append(span("change-before", change.before), " ", span("change-tag", "gone"));
  } else {
    const arrow = span("change-arrow", " → ");
    arrow.setAttribute("aria-hidden", "true");
    li.append(
      said("from "),
      span("change-before", change.before),
      arrow,
      said("to "),
      span("change-after", change.after),
    );
  }
  return li;
}
