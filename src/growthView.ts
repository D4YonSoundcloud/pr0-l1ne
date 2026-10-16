/**
 * "How it grows", in the Measure panel: growth runs at a ladder of sizes
 * (trace/growth.ts), drawn as two log-log charts (work and time against
 * the size) with the fitted curve, the code's estimate for comparison, and
 * earlier versions kept to compare against.
 */

import { h } from "./stylePanel";
import {
  compareGrowth,
  type Fit,
  fitGrowth,
  type GrowthPoint,
  ladder,
  modelLabel,
  predict,
  type SizeVar,
  type StaticGrowth,
  shape,
  type Verdict,
} from "./trace/growth";
import { compact, duration } from "./trace/measurement";

/** One program's growth runs. */
export interface GrowthSeries {
  label: string;
  /** The variable on the x axis, and the ones that grew with it. */
  x: string;
  scaled: string[];
  points: GrowthPoint[];
  /** Why the ladder stopped before its last size, if it did. */
  stopped?: { x: number; why: string };
  /** The code's estimate, in terms of the scaled variables, when it could be tied to them. */
  expected?: StaticGrowth | null;
}

export interface GrowthViewOptions {
  /** The program's size variables, and problems with its hints. */
  sizes(): { vars: SizeVar[]; problems: string[] };
  /** Where `viz: size` would go, for a program without one: a top-level `name = number`. */
  suggestion(): { name: string; line: number } | null;
  addHint(name: string, line: number): void;
  start(scaled: string[]): void;
  stop(): void;
  /** Kept series are stored per language family. */
  storageKey(): string;
}

const COLORS = ["#7cc4ff", "#ffb37a", "#8be08b", "#d6a4ff", "#ff8fb1", "#f2e27a"];
const MAX_KEPT = 5;

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

export class GrowthView {
  readonly el: HTMLElement;
  private current: GrowthSeries | null = null;
  private kept: GrowthSeries[] = [];
  private progress: string | null = null;
  private scaledChoice: string | null = null;

  constructor(private readonly options: GrowthViewOptions) {
    this.el = h("section", { class: "gr", "aria-label": "How it grows" });
    this.loadKept();
  }

  get running(): boolean {
    return this.progress !== null;
  }

  setProgress(text: string | null): void {
    this.progress = text;
    this.render();
  }

  setResult(series: GrowthSeries): void {
    this.current = series;
    this.progress = null;
    this.render();
  }

  /** The language changed: its own kept series. */
  reload(): void {
    this.current = null;
    this.loadKept();
    this.render();
  }

  private loadKept(): void {
    try {
      const raw = localStorage.getItem(this.options.storageKey());
      this.kept = raw ? (JSON.parse(raw) as GrowthSeries[]).slice(0, MAX_KEPT) : [];
    } catch {
      this.kept = [];
    }
  }

  private saveKept(): void {
    try {
      localStorage.setItem(this.options.storageKey(), JSON.stringify(this.kept));
    } catch {
      // storage unavailable: kept for this visit only
    }
  }

  render(): void {
    const { vars, problems } = this.options.sizes();
    const body: (HTMLElement | null)[] = [h("h3", { class: "style-subhead" }, "How it grows")];

    if (!vars.length && !problems.length) {
      const suggestion = this.options.suggestion();
      body.push(
        h(
          "p",
          { class: "ms-note gr-intro" },
          "Mark the input size with a hint, like ",
          h("code", {}, "viz: size n"),
          ", and Measure reruns the program at n/64, n/16, n/4 and n, to show how its work and time grow.",
        ),
      );
      if (suggestion) {
        const add = h("button", { type: "button", class: "button small" }, `Add viz: size ${suggestion.name}`);
        add.addEventListener("click", () => this.options.addHint(suggestion.name, suggestion.line));
        body.push(h("div", { class: "style-row style-actions" }, add));
      }
    }
    for (const p of problems) body.push(h("p", { class: "cx-stale" }, p));

    if (vars.length) {
      const names = vars.map((v) => v.name);
      const choices = [names, ...(names.length > 1 ? names.map((n) => [n]) : [])];
      const key = (c: string[]) => c.join(",");
      if (!this.scaledChoice || !choices.some((c) => key(c) === this.scaledChoice)) this.scaledChoice = key(names);
      const scaled = this.scaledChoice.split(",");
      const rungs = ladder(vars, scaled);
      const x = scaled[0];
      body.push(
        h(
          "p",
          { class: "ms-note" },
          `Runs at ${x} = ${rungs.map((r) => r.x.toLocaleString()).join(", ")}`,
          scaled.length > 1 ? ` (with ${scaled.slice(1).join(" and ")} growing along)` : "",
          ", counting the work each time.",
        ),
      );
      const row = h("div", { class: "style-row style-actions gr-controls" });
      if (choices.length > 1) {
        const select = h("select", { class: "style-select", "aria-label": "Which sizes grow" }) as HTMLSelectElement;
        for (const c of choices)
          select.append(new Option(c.length > 1 ? `${c.join(" and ")} grow together` : `only ${c[0]} grows`, key(c)));
        select.value = this.scaledChoice;
        select.disabled = this.running;
        select.addEventListener("change", () => {
          this.scaledChoice = select.value;
          this.render();
        });
        row.append(select);
      }
      const go = h(
        "button",
        { type: "button", class: `button small${this.running ? " is-measuring" : ""}`, id: "growth-run" },
        this.running ? "Stop" : this.current ? "Measure growth again" : "Measure growth",
      );
      go.addEventListener("click", () => (this.running ? this.options.stop() : this.options.start(scaled)));
      row.append(go);
      body.push(row);
    }
    if (this.progress) body.push(h("p", { class: "ms-note gr-progress", role: "status" }, this.progress));

    const shown = [...(this.current ? [this.current] : []), ...this.kept];
    if (shown.some((s) => s.points.length)) body.push(...this.results(shown));
    this.el.replaceChildren(...body.filter((b): b is HTMLElement => !!b));
  }

  private results(shown: GrowthSeries[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    const cur = this.current;
    const colorOf = (s: GrowthSeries) =>
      s === cur ? COLORS[0] : COLORS[1 + (this.kept.indexOf(s) % (COLORS.length - 1))];
    const opsFit = (s: GrowthSeries) => fitGrowth(s.points.map((p) => ({ x: p.x, y: p.ops })));
    // Times under a millisecond are mostly the clock's resolution: drawn, but not fitted.
    const timeFit = (s: GrowthSeries) => fitGrowth(s.points.filter((p) => p.ms >= 1).map((p) => ({ x: p.x, y: p.ms })));

    // The verdict for the current run.
    if (cur?.points.length) {
      const fit = opsFit(cur);
      if (fit) {
        out.push(
          h(
            "div",
            { class: "gr-verdict" },
            h("span", { class: "cx-big-label" }, "Measured growth"),
            h("span", { class: "gr-model" }, `O(${modelLabel(fit.model, cur.x)})`),
            h(
              "span",
              { class: "ms-note" },
              ` work ×${compact(cur.points[cur.points.length - 1].ops / cur.points[0].ops)} from ${cur.x} = ${cur.points[0].x.toLocaleString()} to ${cur.points[cur.points.length - 1].x.toLocaleString()}`,
            ),
          ),
        );
        const verdict: Verdict | null = cur.expected ? compareGrowth(fit, cur.expected, cur.x) : null;
        if (verdict) out.push(h("p", { class: `gr-compare is-${verdict.kind}` }, verdict.text));
        else
          out.push(
            h(
              "p",
              { class: "ms-note" },
              "The code's estimate couldn't be tied to these sizes, so there's nothing to compare it with.",
            ),
          );
      } else {
        out.push(h("p", { class: "ms-note" }, "Only one size finished: at least two are needed to see growth."));
      }
      if (cur.stopped) {
        const tf = timeFit(cur);
        out.push(
          h(
            "p",
            { class: "ms-projection" },
            cur.stopped.why,
            tf ? ` At the measured rate, ${cur.x} = ${cur.stopped.x.toLocaleString()} would take about ` : "",
            tf ? h("strong", {}, duration(predict(tf, cur.stopped.x))) : "",
            tf ? "." : "",
          ),
        );
      }
    }

    out.push(
      this.chart("Work", "lines run + items handled by built-ins", shown, colorOf, (p) => p.ops, opsFit, compact),
    );
    out.push(this.chart("Time", "this browser", shown, colorOf, (p) => p.ms, timeFit, duration));

    // Legend, with keep / rename / remove.
    const legend = h("ul", { class: "gr-legend" });
    for (const s of shown) {
      const fit = opsFit(s);
      const chip = h("span", { class: "gr-chip" });
      chip.style.background = colorOf(s);
      const item = h("li", {}, chip);
      if (s === cur) {
        item.append(h("span", { class: "gr-name" }, "This version"));
      } else {
        const name = h("input", {
          type: "text",
          class: "gr-rename",
          value: s.label,
          "aria-label": "Name of this kept version",
          maxlength: 40,
        }) as HTMLInputElement;
        name.addEventListener("change", () => {
          s.label = name.value.trim() || s.label;
          this.saveKept();
        });
        item.append(name);
      }
      item.append(h("span", { class: "gr-fit" }, fit ? `O(${modelLabel(fit.model, s.x)})` : "–"));
      if (s === cur) {
        const keep = h(
          "button",
          {
            type: "button",
            class: "button small",
            title: "Keep these results on the charts, to compare with another version of the code",
          },
          "Keep for comparison",
        );
        keep.addEventListener("click", () => {
          this.kept = [{ ...s, label: `Version ${this.kept.length + 1}` }, ...this.kept].slice(0, MAX_KEPT);
          this.current = null;
          this.saveKept();
          this.render();
        });
        item.append(keep);
      } else {
        const remove = h(
          "button",
          { type: "button", class: "gr-remove", "aria-label": `Remove ${s.label}`, title: "Remove" },
          "×",
        );
        remove.addEventListener("click", () => {
          this.kept = this.kept.filter((k) => k !== s);
          this.saveKept();
          this.render();
        });
        item.append(remove);
      }
      legend.append(item);
    }
    if (cur?.expected && !cur.expected.explosive) {
      const chip = h("span", { class: "gr-chip is-expected" });
      legend.append(
        h(
          "li",
          {},
          chip,
          h("span", { class: "gr-name" }, "The code's estimate"),
          h("span", { class: "gr-fit" }, cur.expected.label),
        ),
      );
    }
    out.push(legend);

    // The numbers.
    if (cur?.points.length) {
      const table = h(
        "table",
        { class: "gr-table" },
        h("thead", {}, h("tr", {}, h("th", {}, cur.x), h("th", {}, "Work"), h("th", {}, "Time"))),
      );
      const tbody = h("tbody");
      for (const p of cur.points) {
        tbody.append(
          h(
            "tr",
            {},
            h("td", {}, p.x.toLocaleString()),
            h("td", { title: p.ops.toLocaleString() }, compact(p.ops)),
            h(
              "td",
              { title: p.plain ? "The program run untouched" : "While counting (too long to run again untouched)" },
              `${duration(p.ms)}${p.plain ? "" : "*"}`,
            ),
          ),
        );
      }
      table.append(tbody);
      out.push(table);
      if (cur.points.some((p) => !p.plain))
        out.push(h("p", { class: "ms-note" }, "* Timed while counting, which is usually 2 to 4 times slower."));
    }
    return out;
  }

  /** A log-log chart of every series, with fitted curves (and the code's estimate, dashed). */
  private chart(
    title: string,
    note: string,
    shown: GrowthSeries[],
    colorOf: (s: GrowthSeries) => string,
    y: (p: GrowthPoint) => number,
    fitOf: (s: GrowthSeries) => Fit | null,
    format: (v: number) => string,
  ): HTMLElement {
    const W = 400,
      H = 190,
      L = 54,
      R = 12,
      T = 10,
      B = 30;
    const all = shown.flatMap((s) => s.points.filter((p) => y(p) > 0).map((p) => ({ x: p.x, y: y(p) })));
    const fig = h("figure", { class: "gr-figure" }, h("figcaption", {}, h("strong", {}, title), ` · ${note}`));
    if (all.length < 1) return fig;
    const cur = this.current;
    // The code's estimate, through the current run's largest size.
    const expected = cur?.expected && !cur.expected.explosive && title === "Work" ? cur.expected : null;
    const anchor = cur?.points[cur.points.length - 1];
    const expectedAt = (x: number) =>
      anchor && expected ? (y(anchor) * shape(expected.model, x)) / shape(expected.model, anchor.x) : NaN;

    let [x0, x1] = [Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x))];
    let ys = all.map((p) => p.y);
    if (expected && anchor) ys = ys.concat([expectedAt(x0), expectedAt(x1)].filter((v) => v > 0));
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    if (x1 / x0 < 4) {
      x0 /= 2;
      x1 *= 2;
    }
    if (y1 / y0 < 10) {
      y0 /= 3;
      y1 *= 3;
    }
    const lx0 = Math.log10(x0) - 0.08,
      lx1 = Math.log10(x1) + 0.08;
    const ly0 = Math.log10(y0) - 0.15,
      ly1 = Math.log10(y1) + 0.15;
    const px = (x: number) => L + ((Math.log10(x) - lx0) / (lx1 - lx0)) * (W - L - R);
    const py = (v: number) => T + (1 - (Math.log10(v) - ly0) / (ly1 - ly0)) * (H - T - B);

    const root = svg("svg", {
      class: "gr-chart",
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
      role: "img",
      "aria-label": `${title} against ${cur?.x ?? "size"}, on log scales`,
    });
    // Grid and ticks at powers of ten (and 2, 5 between when the range is small).
    const ticks = (lo: number, hi: number) => {
      const out: number[] = [];
      const fine = hi - lo < 2.2;
      for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) {
        for (const m of fine ? [1, 2, 5] : [1]) {
          const v = m * 10 ** e;
          if (Math.log10(v) >= lo && Math.log10(v) <= hi) out.push(v);
        }
      }
      return out;
    };
    for (const v of ticks(ly0, ly1)) {
      root.append(svg("line", { class: "gr-grid", x1: L, x2: W - R, y1: py(v), y2: py(v) }));
      root.append(
        svg(
          "text",
          { class: "gr-tick", x: L - 6, y: py(v), "text-anchor": "end", "dominant-baseline": "central" },
          format(v),
        ),
      );
    }
    for (const v of ticks(lx0, lx1)) {
      root.append(svg("line", { class: "gr-grid", x1: px(v), x2: px(v), y1: T, y2: H - B }));
      root.append(svg("text", { class: "gr-tick", x: px(v), y: H - B + 14, "text-anchor": "middle" }, compact(v)));
    }
    root.append(
      svg("text", { class: "gr-axis", x: W - R, y: H - 3, "text-anchor": "end" }, `${cur?.x ?? shown[0].x} →`),
    );
    // Curves stay inside the plot.
    const clipId = `gr-clip-${title.toLowerCase()}`;
    const defs = svg("defs");
    const clip = svg("clipPath", { id: clipId });
    clip.append(svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B }));
    defs.append(clip);
    root.append(defs);
    const plot = svg("g", { "clip-path": `url(#${clipId})` });
    root.append(plot);

    const curve = (f: (x: number) => number, a: number, b: number) => {
      const pts: string[] = [];
      for (let i = 0; i <= 40; i++) {
        const x = a * (b / a) ** (i / 40);
        const v = f(x);
        if (v > 0 && Number.isFinite(v)) pts.push(`${px(x).toFixed(1)},${py(v).toFixed(1)}`);
      }
      return pts.join(" ");
    };
    if (expected && anchor) {
      plot.append(svg("polyline", { class: "gr-expected", points: curve(expectedAt, x0, x1) }));
    }
    // Kept versions first, so the current one is drawn on top.
    for (const s of [...shown].reverse()) {
      const color = colorOf(s);
      const pts = s.points.filter((p) => y(p) > 0);
      const fit = fitOf(s);
      if (fit && pts.length > 1) {
        plot.append(
          svg("polyline", {
            class: "gr-fit-line",
            stroke: color,
            points: curve((x) => predict(fit, x), pts[0].x, pts[pts.length - 1].x),
          }),
        );
      }
      for (const p of pts) {
        const dot = svg("circle", { class: "gr-dot", cx: px(p.x), cy: py(y(p)), r: 4, fill: color });
        dot.append(
          svg(
            "title",
            {},
            `${s === cur ? "This version" : s.label}: ${s.x} = ${p.x.toLocaleString()}, ${format(y(p))}`,
          ),
        );
        root.append(dot);
      }
    }
    fig.append(root);
    const unshown = shown.reduce((n, s) => n + s.points.filter((p) => !(y(p) > 0)).length, 0);
    if (unshown)
      fig.append(
        h(
          "p",
          { class: "ms-note" },
          `${unshown === 1 ? "One run was" : `${unshown} runs were`} too quick for this browser's clock to time, so ${unshown === 1 ? "it isn't" : "they aren't"} drawn.`,
        ),
      );
    return fig;
  }
}
