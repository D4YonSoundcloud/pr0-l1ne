/**
 * Time and space complexity in the UI: the toolbar chip ("Time O(n²) ·
 * Space O(1)"), the panel that explains it, and the labels in the editor
 * ("× n" after a loop, "O(n log n)" after a function).
 *
 * The estimate itself is trace/complexity.ts. This file only shows it.
 */
import { h } from "./stylePanel";
import type { Estimate } from "./trace/complexity";

export interface CostLabel {
  line: number;
  text: string;
  hover: string;
  kind: "loop" | "function";
}

export interface ComplexityPanelOptions {
  host: HTMLElement;
  button: HTMLButtonElement;
  /** Jump the editor to a line. */
  reveal(line: number): void;
  /** Whether the editor shows its labels. */
  labelsShown(): boolean;
  setLabelsShown(on: boolean): void;
  /** Called when the panel opens, so other floating panels can close. */
  onOpen(): void;
}

const SIZED_BY = {
  code: "Sized from the code.",
  run: "Sized from the run: the code doesn't say how many times it runs.",
  both: "The code says how many times per pass; the run showed how that adds up.",
};

export class ComplexityPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private estimate: Estimate | null = null;
  private stale = false;

  constructor(private readonly options: ComplexityPanelOptions) {
    this.body = h("div", { class: "cx-body" });
    const close = h("button", { type: "button", class: "style-close", "aria-label": "Close complexity", title: "Close (Esc)" }, "×");
    close.addEventListener("click", () => this.toggle(false));
    this.el = h("section", { class: "style-panel cx-panel", id: "complexity-panel", role: "dialog", "aria-label": "Time and space complexity", hidden: true },
      h("header", { class: "style-head" },
        h("h2", { class: "style-title" }, "Complexity"),
        h("span", { class: "style-note" }, "Estimated from the code, checked against this run"),
        close),
      this.body);
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.toggle(false);
        options.button.focus();
      }
    });
    options.host.append(this.el);
    options.button.addEventListener("click", () => this.toggle());
    this.show(null, false);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(open = this.el.hidden): void {
    this.el.hidden = !open;
    this.options.button.setAttribute("aria-expanded", String(open));
    if (open) {
      this.options.onOpen();
      this.draw();
    }
  }

  /** New estimate (null: nothing to show). `stale`: the code has an error, so this is the last version that ran. */
  show(estimate: Estimate | null, stale: boolean): void {
    this.estimate = estimate;
    this.stale = stale;
    const b = this.options.button;
    b.replaceChildren();
    if (!estimate) {
      b.append(h("span", { class: "cx-chip-label" }, "Complexity"));
      b.title = "Time and space complexity: run a program first";
    } else {
      b.append(
        h("span", { class: "cx-chip-label" }, "Time"), h("span", { class: "cx-time" }, estimate.time),
        h("span", { class: "cx-chip-sep" }, "·"),
        h("span", { class: "cx-chip-label" }, "Space"), h("span", { class: "cx-space" }, estimate.space));
      b.title = `Time ${estimate.time}, extra space ${estimate.space}: estimated from the code's shape, checked against this run. Click for how.`;
    }
    b.classList.toggle("is-stale", stale);
    if (this.isOpen) this.draw();
  }

  private draw(): void {
    const e = this.estimate;
    this.body.replaceChildren();
    if (!e) {
      this.body.append(h("p", { class: "cx-empty" }, "Run a program to estimate how its time and memory grow with its input."));
      return;
    }
    if (this.stale) this.body.append(h("p", { class: "cx-stale" }, "The code has an error, so this is for the last version that ran."));

    this.body.append(h("div", { class: "cx-summary" },
      h("div", { class: "cx-big" }, h("span", { class: "cx-big-label" }, "Time"), h("span", { class: "cx-time" }, e.time)),
      h("div", { class: "cx-big" }, h("span", { class: "cx-big-label" }, "Extra space"), h("span", { class: "cx-space" }, e.space))));

    if (e.legend.length) {
      const list = h("dl", { class: "cx-legend" });
      for (const l of e.legend) {
        list.append(h("dt", {}, l.name), h("dd", {}, l.meaning, h("span", { class: "cx-value" }, ` (${l.value} in this run)`)));
      }
      this.body.append(list);
    }

    const toggle = h("input", { type: "checkbox", id: "cx-labels" }) as HTMLInputElement;
    toggle.checked = this.options.labelsShown();
    toggle.addEventListener("change", () => this.options.setLabelsShown(toggle.checked));
    this.body.append(h("label", { class: "cx-toggle", for: "cx-labels" }, toggle, " Show on loops and functions in the editor"));

    if (e.functions.length) {
      this.body.append(h("h3", { class: "style-subhead" }, "Functions"));
      for (const f of e.functions) {
        const row = this.row(f.line,
          h("span", { class: "cx-name" }, `${f.name}()`),
          h("span", { class: "cx-cost" }, h("span", { class: "cx-time" }, f.time), " time · ", h("span", { class: "cx-space" }, f.space), " space"));
        const details = h("ul", { class: "cx-why" });
        for (const w of f.why) details.append(h("li", {}, w));
        if (f.checked) details.append(h("li", { class: "cx-run" }, `In this run: ${f.checked}`));
        if (details.childElementCount) row.append(details);
        this.body.append(row);
      }
    }

    const loops = e.loops.filter((l) => l.line > 0);
    if (loops.length) {
      this.body.append(h("h3", { class: "style-subhead" }, "Loops"));
      for (const l of loops) {
        const row = this.row(l.line,
          h("span", { class: "cx-name" }, h("code", {}, l.why)),
          h("span", { class: `cx-label${l.fromRun ? " is-run" : ""}` }, l.label));
        const details = h("ul", { class: "cx-why" });
        details.append(h("li", {}, SIZED_BY[l.sizedBy]));
        if (l.checked) details.append(h("li", { class: "cx-run" }, `In this run: ${l.checked}`));
        row.append(details);
        this.body.append(row);
      }
    }

    if (e.notes.length) {
      this.body.append(h("h3", { class: "style-subhead" }, "Worth knowing"));
      const notes = h("ul", { class: "cx-notes" });
      for (const n of e.notes) notes.append(h("li", {}, n));
      this.body.append(notes);
    }

    this.body.append(h("p", { class: "cx-footer" },
      "Worst case for the code's shape: nested loops multiply, code in sequence adds, and recursion is solved by how its argument shrinks. ",
      "Loops and calls the code can't size are sized from this run, so a tiny input can mislead. ",
      `This run: ${e.run.join(", ")}.`));
  }

  private row(line: number, ...head: HTMLElement[]): HTMLElement {
    const button = h("button", { type: "button", class: "cx-row-head", title: `Go to line ${line}` },
      h("span", { class: "cx-line" }, `${line}`), ...head);
    button.addEventListener("click", () => this.options.reveal(line));
    return h("div", { class: "cx-row" }, button);
  }
}

/** The editor labels for an estimate. */
export function costLabels(e: Estimate | null): CostLabel[] {
  if (!e) return [];
  const out: CostLabel[] = [];
  for (const f of e.functions) {
    out.push({
      line: f.line, kind: "function", text: `${f.time} time · ${f.space} space`,
      hover: [`**${f.name}()**: ${f.time} time, ${f.space} extra space`, ...f.why.map((w) => `- ${w}`), ...(f.checked ? [`- In this run: ${f.checked}`] : [])].join("\n"),
    });
  }
  const byLine = new Map<number, string[]>();
  for (const l of e.loops) {
    if (l.line <= 0) continue;
    const list = byLine.get(l.line) ?? [];
    list.push(l.label);
    byLine.set(l.line, list);
    const hover = [`**${l.label}**: \`${l.why}\``, `- ${SIZED_BY[l.sizedBy]}`, ...(l.checked ? [`- In this run: ${l.checked}`] : [])].join("\n");
    if (list.length === 1) out.push({ line: l.line, kind: "loop", text: l.label, hover });
    else {
      const existing = out.find((o) => o.line === l.line && o.kind === "loop")!;
      existing.text = list.join(", ");
      existing.hover += `\n\n${hover}`;
    }
  }
  if (e.legend.length) {
    const legend = e.legend.map((l) => `${l.name} = ${l.meaning}`).join(", ");
    for (const o of out) o.hover += `\n\n_${legend}_`;
  }
  return out;
}
