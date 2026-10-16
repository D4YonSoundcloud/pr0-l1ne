/**
 * Measure in the UI: the results panel (time, how far a stopped run got and
 * how long all of it would take, the hottest lines, work inside built-ins,
 * memory, output) and the editor's heat map (a tint and a count on every
 * line that ran).
 *
 * The run itself is trace/measurement.ts's Measurement, from a worker.
 */
import { h } from "./stylePanel";
import { compact, duration, type Measurement, projectedMs, totals, workWord } from "./trace/measurement";
import { formatBytes } from "./trace/memory";

export interface MeasureLabel {
  line: number;
  text: string;
  hover: string;
  /** 1 (cool) to 5 (hottest), on a log scale. */
  heat: number;
}

export const MEASURE_LIMITS: { label: string; ms: number }[] = [
  { label: "5 seconds", ms: 5_000 },
  { label: "20 seconds", ms: 20_000 },
  { label: "1 minute", ms: 60_000 },
  { label: "5 minutes", ms: 300_000 },
];

export interface MeasurePanelOptions {
  host: HTMLElement;
  reveal(line: number): void;
  labelsShown(): boolean;
  setLabelsShown(on: boolean): void;
  limit(): number;
  setLimit(ms: number): void;
  measureAgain(): void;
  /** The complexity estimate from the small run, if there is one ("O(n·k)"). */
  estimate(): string | null;
  onOpen(): void;
  /** "How it grows": growth runs (growthView.ts), drawn at the end. */
  growth: HTMLElement;
  /** Draw the growth section again (it reads the code). */
  renderGrowth(): void;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export class MeasurePanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private result: Measurement | null = null;
  private code = "";
  private stale = false;

  constructor(private readonly options: MeasurePanelOptions) {
    this.body = h("div", { class: "cx-body ms-body" });
    const close = h(
      "button",
      { type: "button", class: "style-close", "aria-label": "Close measurements", title: "Close (Esc)" },
      "×",
    );
    close.addEventListener("click", () => this.toggle(false));
    this.el = h(
      "section",
      {
        class: "style-panel cx-panel ms-panel",
        id: "measure-panel",
        role: "dialog",
        "aria-label": "Measurements",
        hidden: true,
      },
      h(
        "header",
        { class: "style-head" },
        h("h2", { class: "style-title" }, "Measure"),
        h("span", { class: "style-note" }, "The whole program, at full size, counted"),
        close,
      ),
      this.body,
    );
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.toggle(false);
      }
    });
    options.host.append(this.el);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(open = this.el.hidden): void {
    this.el.hidden = !open;
    if (open) {
      this.options.onOpen();
      this.draw();
    }
  }

  show(result: Measurement, code: string): void {
    this.result = result;
    this.code = code;
    this.stale = false;
    this.toggle(true);
  }

  /** The code changed since this was measured. */
  markStale(): void {
    if (this.stale || !this.result) return;
    this.stale = true;
    if (this.isOpen) this.draw();
  }

  get hasResult(): boolean {
    return !!this.result;
  }

  private draw(): void {
    const r = this.result;
    this.body.replaceChildren();
    if (!r) {
      this.body.append(
        h(
          "p",
          { class: "cx-empty" },
          "Measure runs the whole program at full size, counting how many times every line runs instead of tracing it, so it works for inputs far too big to step through.",
        ),
      );
      this.body.append(this.controls());
      this.options.renderGrowth();
      this.body.append(this.options.growth);
      return;
    }
    if (this.stale) this.body.append(h("p", { class: "cx-stale" }, "The code has changed since this was measured."));

    // What happened.
    const sourceLine = (line: number) => (this.code.split("\n")[line - 1] ?? "").trim();
    const summary = h("div", { class: "ms-summary" });
    if (r.status === "done") {
      const time = r.plainMs ?? r.ms;
      summary.append(
        h(
          "div",
          { class: "cx-big" },
          h("span", { class: "cx-big-label" }, r.plainMs !== null ? "Time" : "Time, while counting"),
          h("span", { class: "ms-time" }, duration(time)),
        ),
      );
      if (r.plainMs !== null)
        summary.append(
          h(
            "p",
            { class: "ms-note" },
            `${duration(r.ms)} with the counters added. Times depend on this computer and browser.`,
          ),
        );
      else
        summary.append(
          h(
            "p",
            { class: "ms-note" },
            "Too long to run a second time without the counters, which usually make a program 2 to 4 times slower.",
          ),
        );
    } else if (r.status === "limit") {
      const projected = projectedMs(r);
      const loop = r.stoppedAt?.loop;
      summary.append(
        h(
          "div",
          { class: "cx-big" },
          h("span", { class: "cx-big-label" }, "Stopped at the time limit"),
          h("span", { class: "ms-time is-limit" }, duration(r.ms)),
        ),
        h(
          "p",
          { class: "ms-note" },
          loop
            ? `${plural(loop.done, "pass")} of ${loop.total.toLocaleString()} through the loop on line ${loop.line} (${pct(loop.done / loop.total)}).`
            : "No loop with a known length was running, so how far it got can't be said.",
        ),
      );
      if (projected !== null) {
        summary.append(
          h(
            "p",
            { class: "ms-projection" },
            "At that rate the whole run would take about ",
            h("strong", {}, duration(projected)),
            " while counting; without the counters, usually 2 to 4 times less. (That assumes every pass takes about as long as the ones so far.)",
          ),
        );
      }
    } else {
      const e = r.error!;
      summary.append(
        h(
          "div",
          { class: "cx-big" },
          h("span", { class: "cx-big-label" }, "Stopped by an error"),
          h("span", { class: "ms-time is-error" }, e.type),
        ),
        h("p", { class: "ms-note" }, `${e.line ? `Line ${e.line}: ` : ""}${e.message}`),
      );
    }
    this.body.append(summary);

    // Totals.
    const t = totals(r);
    const stats = h("dl", { class: "ms-stats" });
    const stat = (label: string, value: string, title = "") =>
      stats.append(h("dt", { title }, label), h("dd", { title }, value));
    stat("Lines run", t.lines.toLocaleString(), "Every statement that ran, counted once each time it ran");
    if (t.work)
      stat(
        "Inside built-ins",
        `${t.work.toLocaleString()} items`,
        "Items moved, scanned, copied or sorted inside built-in operations like insert(0, x), shift(), x in list, slices and sorting",
      );
    if (r.peakBytes !== null)
      stat("Peak memory", formatBytes(r.peakBytes, false), "The most memory the program used at once (64-bit Python)");
    if (r.heldBytes !== null)
      stat(
        "Held at the end",
        formatBytes(r.heldBytes, false),
        "What the program's variables hold when it ends (64-bit Python sizes)",
      );
    const estimate = this.options.estimate();
    if (estimate) stat("Estimated", estimate, "The time complexity estimated from the code and the small, traced run");
    this.body.append(stats);

    // Hottest lines.
    const rows = hotLines(r).slice(0, 8);
    if (rows.length) {
      this.body.append(h("h3", { class: "style-subhead" }, "Hottest lines"));
      const max = rows[0].weight || 1;
      for (const row of rows) {
        const button = h(
          "button",
          { type: "button", class: "cx-row-head ms-row", title: `Go to line ${row.line}` },
          h("span", { class: "cx-line" }, String(row.line)),
          h("span", { class: "cx-name" }, h("code", {}, sourceLine(row.line) || " ")),
          h("span", { class: "ms-count" }, row.text),
        );
        button.addEventListener("click", () => this.options.reveal(row.line));
        const bar = h("span", { class: "ms-bar" });
        bar.style.setProperty("--share", `${Math.max(2, (100 * Math.log1p(row.weight)) / Math.log1p(max))}%`);
        this.body.append(h("div", { class: "cx-row" }, button, bar));
      }
    }

    // Output.
    if (r.stdout || r.droppedOutput) {
      const lines = r.stdout.replace(/\n$/, "").split("\n");
      const shown = lines.slice(-10);
      const more = lines.length - shown.length;
      this.body.append(
        h("h3", { class: "style-subhead" }, "Output"),
        h("pre", { class: "ms-output" }, (more > 0 ? `… ${plural(more, "earlier line")}\n` : "") + shown.join("\n")),
      );
      if (r.droppedOutput)
        this.body.append(
          h("p", { class: "ms-note" }, `${r.droppedOutput.toLocaleString()} more characters of output weren't kept.`),
        );
    }

    this.body.append(this.controls());
    this.options.renderGrowth();
    this.body.append(this.options.growth);
    this.body.append(
      h(
        "p",
        { class: "cx-footer" },
        "Measure runs the whole program with counters instead of a trace: how many times each line ran is exact. Times are this browser's",
        r.plainMs !== null ? "" : ", with counting",
        ". Python here is WebAssembly, a few times slower than Python on a desktop.",
      ),
    );
  }

  private controls(): HTMLElement {
    const limit = h("select", {
      class: "style-select",
      id: "ms-limit",
      "aria-label": "Time limit",
    }) as HTMLSelectElement;
    for (const l of MEASURE_LIMITS) limit.append(new Option(l.label, String(l.ms)));
    limit.value = String(this.options.limit());
    limit.addEventListener("change", () => this.options.setLimit(Number(limit.value)));
    const labels = h("input", { type: "checkbox", id: "ms-labels" }) as HTMLInputElement;
    labels.checked = this.options.labelsShown();
    labels.addEventListener("change", () => this.options.setLabelsShown(labels.checked));
    const again = h("button", { type: "button", class: "button small" }, this.result ? "Measure again" : "Measure");
    again.addEventListener("click", () => this.options.measureAgain());
    return h(
      "div",
      { class: "ms-controls" },
      h("div", { class: "style-row" }, h("label", { for: "ms-limit" }, "Time limit"), limit),
      h("label", { class: "cx-toggle", for: "ms-labels" }, labels, " Show counts on the lines in the editor"),
      h("div", { class: "style-row style-actions" }, again),
    );
  }
}

const pct = (f: number) => `${f < 0.01 ? (100 * f).toFixed(2) : Math.round(100 * f)}%`;

interface Hot {
  line: number;
  weight: number;
  text: string;
  hover: string;
}

/** Every line that ran, hottest first, with its label text. */
function hotLines(r: Measurement): Hot[] {
  const lines = new Set([...Object.keys(r.lines), ...Object.keys(r.passes), ...Object.keys(r.work)].map(Number));
  const out: Hot[] = [];
  for (const line of lines) {
    if (!line) continue;
    const count = r.lines[line] ?? 0;
    const passes = r.passes[line];
    const work = r.work[line] ?? 0;
    const parts: string[] = [];
    const hover: string[] = [];
    if (passes !== undefined) {
      parts.push(`${compact(passes)} passes`);
      hover.push(`The loop's body ran **${passes.toLocaleString()}** times`);
      const total = r.totals[line];
      if (total !== undefined && r.status === "limit")
        hover.push(`(of ${total.toLocaleString()} it was going to make, the last time it started)`);
    } else if (count) {
      parts.push(`${compact(count)}×`);
      hover.push(`Ran **${count.toLocaleString()}** time${count === 1 ? "" : "s"}`);
    }
    if (work) {
      parts.push(`${compact(work)} ${workWord(r.workKind[line])}`);
      hover.push(`Built-ins on this line ${workWord(r.workKind[line])} **${work.toLocaleString()}** items in all`);
    }
    out.push({ line, weight: Math.max(count, passes ?? 0) + work, text: parts.join(" · "), hover: hover.join("\n\n") });
  }
  return out.sort((a, b) => b.weight - a.weight || a.line - b.line);
}

/** The editor's heat map: a tint by how hot each line was, and its count. */
export function measureLabels(r: Measurement | null): MeasureLabel[] {
  if (!r) return [];
  const rows = hotLines(r);
  const max = Math.max(1, ...rows.map((row) => row.weight));
  return rows.map((row) => ({
    line: row.line,
    text: row.text,
    hover: row.hover + (r.status === "limit" ? "\n\n_Counted until the run stopped at the time limit._" : ""),
    heat: Math.max(1, Math.min(5, Math.ceil((5 * Math.log1p(row.weight)) / Math.log1p(max)))),
  }));
}
