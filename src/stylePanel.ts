/**
 * The Style panel: every appearance setting (see appearance.ts), applied as
 * you change it. It's not a modal dialog: it floats over the editor, so the
 * canvas stays in view and keeps working while you adjust it.
 */
import {
  type Appearance,
  ARROW_KEYS,
  ARROW_THEMES,
  type ArrowMode,
  COLOR_FIELDS,
  clone,
  EASINGS,
  FONTS,
  type GridStyle,
  isEasing,
  type PaneStyle,
  PRESETS,
} from "./appearance";
import type { RendererKind } from "./settings";

/** The Rendering section's choice (see app/rendererSwitch.ts). */
export interface RenderingChoice {
  get(): RendererKind;
  /** Switch renderers; resolves once the windows are drawn, rejects (switched back) if it couldn't. */
  set(kind: RendererKind): Promise<void>;
}

/** What each renderer is like, in the person's terms (shown under the choice). */
export const RENDERER_INFO: Record<RendererKind, { label: string; about: string }> = {
  svg: {
    label: "SVG",
    about:
      "Every box, arrow and value is part of the page, and each step changes only what changed. Stepping is quickest, it's sharp at any zoom, and screen readers can read the values. With very large drawings, panning and zooming can stutter.",
  },
  canvas: {
    label: "Canvas 2D",
    about:
      "Drawn with PixiJS on one canvas the size of the window, only what's in view. Panning and zooming stay smooth however big the drawing gets, but each step takes a little longer to show, since the canvas is painted whole. Text is pixels: it's redrawn sharp once you stop zooming, and screen readers can't read the diagram itself.",
  },
};

/** The two side by side: [question, SVG, Canvas 2D]. */
export const RENDERER_COMPARISON: [string, string, string][] = [
  ["Stepping", "Quicker", "A little slower"],
  ["Panning and zooming big drawings", "Can stutter", "Smooth"],
  ["Zoomed in", "Always sharp", "Sharp once you stop zooming"],
  ["Screen readers", "Read the values", "Read only the window names"],
  ["Save SVG", "Yes", "Yes, the same file"],
];

export interface StylePanelOptions {
  /** The panel is placed inside this element (the editor pane). */
  host: HTMLElement;
  /** The toolbar button that opens and closes it. */
  button: HTMLButtonElement;
  get(): Appearance;
  /** Called on every change, with the new settings. */
  set(next: Appearance): void;
  /** Re-draw the current step with its animation, to preview easing. */
  replay(): void;
  /** Called when the panel opens, so other floating panels can close. */
  onOpen?(): void;
  /** The Rendering section: SVG or Canvas 2D. Absent: not shown. */
  rendering?: RenderingChoice;
}

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false) continue;
    el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

export class StylePanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  /** Re-read every control's value from the settings (after a preset or reset). */
  private syncs: (() => void)[] = [];
  private readonly open = new Set<string>(["rendering", "memory", "loop"]);

  constructor(private readonly options: StylePanelOptions) {
    this.body = h("div", { class: "style-body" });
    const close = h(
      "button",
      { type: "button", class: "style-close", "aria-label": "Close style settings", title: "Close (Esc)" },
      "×",
    );
    close.addEventListener("click", () => this.toggle(false));
    this.el = h(
      "section",
      { class: "style-panel", id: "style-panel", role: "dialog", "aria-label": "Canvas style", hidden: true },
      h(
        "header",
        { class: "style-head" },
        h("h2", { class: "style-title" }, "Canvas style"),
        h("span", { class: "style-note" }, "Changes apply as you make them"),
        close,
      ),
      this.body,
    );
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.toggle(false);
        options.button.focus();
      }
    });
    options.host.append(this.el);
    options.button.addEventListener("click", () => this.toggle());
    this.build();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  toggle(open = this.el.hidden): void {
    this.el.hidden = !open;
    this.options.button.setAttribute("aria-expanded", String(open));
    if (open) {
      this.options.onOpen?.();
      this.sync();
    }
  }

  /** Change settings: everything goes through here. */
  private update(change: (a: Appearance) => void, keepTheme = false): void {
    const next = clone(this.options.get());
    change(next);
    if (!keepTheme) next.theme = "custom";
    this.options.set(next);
    this.syncThemeOnly();
  }

  private sync(): void {
    for (const sync of this.syncs) sync();
  }

  private themeSelect!: HTMLSelectElement;
  private syncThemeOnly(): void {
    const theme = this.options.get().theme;
    this.themeSelect.value = PRESETS.some((p) => p.theme === theme) ? theme : "custom";
  }

  private build(): void {
    this.syncs = [];
    this.body.replaceChildren(
      this.themeRow(),
      ...(this.options.rendering
        ? [this.section("rendering", "Rendering", this.renderingControls(this.options.rendering))]
        : []),
      this.section("memory", "Memory window", this.paneControls("memory")),
      this.section("loop", "Loop history window", this.paneControls("loop")),
      this.section("colors", "Colors", this.colorControls()),
      this.section("arrows", "Arrows", this.arrowControls()),
      this.section("lines", "Lines and text", this.lineControls()),
      this.section("output", "Printed output", this.outputControls()),
      this.footer(),
    );
    this.sync();
  }

  private section(key: string, title: string, content: Node): HTMLElement {
    const details = h(
      "details",
      { class: "style-section", open: this.open.has(key) },
      h("summary", {}, title),
      content,
    );
    details.addEventListener("toggle", () => {
      if (details.open) this.open.add(key);
      else this.open.delete(key);
    });
    return details;
  }

  private themeRow(): HTMLElement {
    const id = nextId("theme");
    this.themeSelect = h("select", { id, class: "style-select" });
    for (const preset of PRESETS) this.themeSelect.append(new Option(preset.theme, preset.theme));
    this.themeSelect.append(new Option("Custom", "custom"));
    this.themeSelect.addEventListener("change", () => {
      const preset = PRESETS.find((p) => p.theme === this.themeSelect.value);
      if (!preset) return;
      this.options.set(clone(preset));
      this.sync();
    });
    this.syncs.push(() => this.syncThemeOnly());
    const reset = h("button", { type: "button", class: "button quiet small" }, "Reset all");
    reset.title = "Back to the default Graph paper look";
    reset.addEventListener("click", () => {
      this.options.set(clone(PRESETS[0]));
      this.sync();
    });
    return h("div", { class: "style-row style-theme" }, h("label", { for: id }, "Theme"), this.themeSelect, reset);
  }

  /** SVG or Canvas 2D, what each is like, and how the switch went. */
  private renderingControls(rendering: RenderingChoice): HTMLElement {
    const about = h("p", { class: "style-help" });
    const status = h("p", { class: "style-status", role: "status", "aria-live": "polite" });
    const kinds: RendererKind[] = ["svg", "canvas"];
    const choice = this.choice<RendererKind>(
      "Draw with",
      kinds.map((value) => ({ label: RENDERER_INFO[value].label, value })),
      () => rendering.get(),
      (kind) => {
        if (kind === rendering.get()) return;
        status.textContent = kind === "canvas" ? "Starting the canvas renderer…" : "";
        status.classList.remove("is-warning");
        rendering
          .set(kind)
          .then(() => {
            status.textContent = "";
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
            status.textContent = `The canvas renderer couldn't start in this browser${reason}, so it's still SVG.`;
            status.classList.add("is-warning");
          })
          .finally(() => this.sync());
        syncAbout();
      },
    );
    const syncAbout = () => {
      about.textContent = RENDERER_INFO[rendering.get()].about;
    };
    this.syncs.push(syncAbout);
    const table = h(
      "table",
      { class: "style-compare" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { scope: "col" }, ""),
          ...kinds.map((k) => h("th", { scope: "col" }, RENDERER_INFO[k].label)),
        ),
      ),
      h(
        "tbody",
        {},
        ...RENDERER_COMPARISON.map(([what, svgSays, canvasSays]) =>
          h("tr", {}, h("th", { scope: "row" }, what), h("td", {}, svgSays), h("td", {}, canvasSays)),
        ),
      ),
    );
    return h(
      "div",
      { class: "style-group" },
      choice,
      about,
      status,
      table,
      h(
        "p",
        { class: "style-help" },
        "Both draw exactly the same picture. Save SVG, in each window's toolbar, saves a vector file you can open in a drawing app, whichever you use.",
      ),
    );
  }

  // ---------------------------------------------------------- controls

  private color(label: string, read: () => string, write: (value: string) => void): HTMLElement {
    const id = nextId("color");
    const input = h("input", { id, type: "color", class: "style-color" });
    const hex = h("code", { class: "style-hex" });
    input.addEventListener("input", () => {
      write(input.value);
      hex.textContent = input.value;
    });
    this.syncs.push(() => {
      input.value = read();
      hex.textContent = read();
    });
    return h(
      "div",
      { class: "style-row" },
      h("label", { for: id }, label),
      h("span", { class: "style-color-wrap" }, input, hex),
    );
  }

  private range(
    label: string,
    min: number,
    max: number,
    step: number,
    unit: string,
    read: () => number,
    write: (value: number) => void,
    format = (v: number) => `${v}${unit}`,
  ): HTMLElement {
    const id = nextId("range");
    const input = h("input", { id, type: "range", min, max, step, class: "style-range" });
    const out = h("output", { for: id, class: "style-value" });
    input.addEventListener("input", () => {
      write(Number(input.value));
      out.textContent = format(Number(input.value));
    });
    this.syncs.push(() => {
      input.value = String(read());
      out.textContent = format(read());
    });
    return h("div", { class: "style-row" }, h("label", { for: id }, label), input, out);
  }

  private choice<T extends string>(
    label: string,
    choices: { label: string; value: T }[],
    read: () => T,
    write: (value: T) => void,
  ): HTMLElement {
    const group = h("div", { class: "segmented style-segmented", role: "group", "aria-label": label });
    const buttons = choices.map((choice) => {
      const button = h("button", { type: "button", class: "segment", "data-value": choice.value }, choice.label);
      button.addEventListener("click", () => {
        write(choice.value);
        sync();
      });
      group.append(button);
      return button;
    });
    const sync = () => {
      for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.value === read()));
    };
    this.syncs.push(sync);
    return h("div", { class: "style-row" }, h("span", { class: "style-label" }, label), group);
  }

  private paneControls(pane: "memory" | "loop"): HTMLElement {
    const p = () => this.options.get()[pane];
    const set = (change: (style: PaneStyle) => void) => this.update((a) => change(a[pane]));
    const box = h("div", { class: "style-group" });

    box.append(
      h("h3", { class: "style-subhead" }, "Background"),
      this.color(
        "Color",
        () => p().background,
        (v) =>
          set((s) => {
            s.background = v;
          }),
      ),
      this.choice<GridStyle>(
        "Grid",
        [
          { label: "Lines", value: "lines" },
          { label: "Dots", value: "dots" },
          { label: "None", value: "none" },
        ],
        () => p().grid,
        (v) =>
          set((s) => {
            s.grid = v;
          }),
      ),
      this.color(
        "Grid color",
        () => p().gridColor,
        (v) =>
          set((s) => {
            s.gridColor = v;
          }),
      ),
      this.range(
        "Grid size",
        8,
        64,
        2,
        " px",
        () => p().gridSize,
        (v) =>
          set((s) => {
            s.gridSize = v;
          }),
      ),
      h("h3", { class: "style-subhead" }, "Animation between steps"),
      this.easingControls(pane),
      this.range(
        "Duration",
        0,
        1000,
        10,
        " ms",
        () => p().duration,
        (v) =>
          set((s) => {
            s.duration = v;
          }),
        (v) => (v === 0 ? "off" : `${v} ms`),
      ),
      this.checkbox(
        "Fade in",
        () => p().enterFade,
        (v) =>
          set((s) => {
            s.enterFade = v;
          }),
        "Boxes and values that weren't there a step ago fade in",
      ),
      this.checkbox(
        "Slide in",
        () => p().enterSlide,
        (v) =>
          set((s) => {
            s.enterSlide = v;
          }),
        "Boxes and values that weren't there a step ago slide in from the left, with this window's easing and duration",
      ),
    );
    if (pane === "loop") {
      const copy = h("button", { type: "button", class: "button quiet small" }, "Same as the memory window");
      copy.addEventListener("click", () => {
        this.update((a) => {
          a.loop = { ...a.memory };
        });
        this.sync();
      });
      box.append(h("div", { class: "style-row style-actions" }, copy));
    }
    return box;
  }

  /** Easing: a preset or your own cubic-bezier, with a preview you play by clicking. */
  private easingControls(pane: "memory" | "loop"): HTMLElement {
    const read = () => this.options.get()[pane];
    const id = nextId("easing");
    const select = h("select", { id, class: "style-select" });
    for (const easing of EASINGS) select.append(new Option(easing.label, easing.value));
    select.append(new Option("Custom…", "custom"));
    const custom = h("input", {
      type: "text",
      class: "style-text",
      spellcheck: false,
      "aria-label": "Custom easing",
      placeholder: "cubic-bezier(0.2, 0.7, 0.2, 1)",
    });
    const curve = svg("svg", {
      class: "easing-curve",
      viewBox: "-0.1 -0.45 1.2 1.9",
      width: 58,
      height: 92,
      "aria-hidden": "true",
    });
    const ball = h("span", { class: "easing-ball" });
    const hint = h("span", { class: "easing-hint" }, "▶ Click to preview");
    const track = h(
      "button",
      {
        type: "button",
        class: "easing-track",
        title: "Play: the dot moves once with the easing and duration you've chosen",
      },
      hint,
      ball,
    );
    // One run across the track, with this window's easing and duration, then back to the start.
    let playing: Animation | null = null;
    track.addEventListener("click", () => {
      const { easing, duration } = read();
      playing?.cancel();
      track.classList.add("is-playing");
      const run = ball.animate([{ left: "4px" }, { left: "calc(100% - 20px)" }], {
        duration: Math.max(duration, 1),
        easing,
        fill: "forwards",
      });
      playing = run;
      run.finished
        .then(() => new Promise((r) => setTimeout(r, 450)))
        .then(() => {
          if (playing !== run) return;
          run.cancel();
          playing = null;
          track.classList.remove("is-playing");
        })
        .catch(() => {
          /* cancelled by a newer click */
        });
    });

    const draw = () => {
      const { easing, duration } = read();
      const known = EASINGS.some((e) => e.value === easing);
      if (document.activeElement !== custom) custom.value = easing;
      select.value = known ? easing : "custom";
      custom.hidden = known;
      custom.classList.toggle("is-invalid", !isEasing(custom.value));
      const pts = bezierPoints(easing);
      curve.replaceChildren(
        svg("path", { class: "easing-axes", d: "M0,1 H1 M0,1 V0" }),
        svg("path", { class: "easing-path", d: `M0,1 C${pts[0]},${1 - pts[1]} ${pts[2]},${1 - pts[3]} 1,0` }),
      );
      track.setAttribute("aria-label", `Preview the easing: ${duration} ms`);
    };
    select.addEventListener("change", () => {
      if (select.value === "custom") {
        // Start from the current curve, ready to edit.
        custom.hidden = false;
        custom.focus();
        custom.select();
        return;
      }
      this.update((a) => {
        a[pane].easing = select.value;
      });
      draw();
    });
    custom.addEventListener("input", () => {
      const value = custom.value.trim();
      custom.classList.toggle("is-invalid", !isEasing(value));
      if (!isEasing(value)) return;
      this.update((a) => {
        a[pane].easing = value;
      });
      draw();
    });
    this.syncs.push(draw);
    return h(
      "div",
      { class: "style-easing" },
      h("div", { class: "style-row" }, h("label", { for: id }, "Easing"), select),
      h("div", { class: "style-row" }, h("span", { class: "style-label" }), custom),
      h("div", { class: "easing-preview" }, curve, track),
    );
  }

  private colorControls(): HTMLElement {
    const box = h("div", { class: "style-group" });
    let group = "";
    for (const field of COLOR_FIELDS) {
      if (field.group === "Arrows") continue; // their own section
      if (field.group !== group) {
        group = field.group;
        box.append(h("h3", { class: "style-subhead" }, group));
      }
      box.append(
        this.color(
          field.label,
          () => this.options.get().colors[field.key],
          (v) =>
            this.update((a) => {
              a.colors[field.key] = v;
            }),
        ),
      );
    }
    return box;
  }

  /** Arrows: colored by kind or all one color, a set of colors to start from, dashes, and each kind's color. */
  private arrowControls(): HTMLElement {
    const box = h("div", { class: "style-group" });
    box.append(
      this.choice<ArrowMode>(
        "Colors",
        [
          { label: "By kind", value: "kind" },
          { label: "One color", value: "one" },
        ],
        () => this.options.get().arrowMode,
        (v) =>
          this.update((a) => {
            a.arrowMode = v;
          }),
      ),
    );
    const id = nextId("arrow-theme");
    const themes = h("select", { id, class: "style-select" });
    themes.append(new Option("Choose a set…", ""));
    for (const theme of ARROW_THEMES) themes.append(new Option(theme.name, theme.name));
    themes.addEventListener("change", () => {
      const theme = ARROW_THEMES.find((t) => t.name === themes.value);
      themes.value = "";
      if (!theme) return;
      this.update((a) => {
        ARROW_KEYS.forEach((key, i) => {
          a.colors[key] = theme.colors[i];
        });
        a.arrowDashes = !!theme.dashes;
        a.arrowMode = "kind";
      });
      this.sync();
    });
    box.append(h("div", { class: "style-row" }, h("label", { for: id }, "Start from"), themes));
    box.append(
      this.checkbox(
        "Dashes for each kind",
        () => this.options.get().arrowDashes,
        (v) =>
          this.update((a) => {
            a.arrowDashes = v;
          }),
        "Tell the kinds apart by dashes too, not only color: for printing, or for color blindness",
      ),
    );
    for (const field of COLOR_FIELDS.filter((f) => f.group === "Arrows"))
      box.append(
        this.color(
          field.label,
          () => this.options.get().colors[field.key],
          (v) =>
            this.update((a) => {
              a.colors[field.key] = v;
            }),
        ),
      );
    box.append(
      h(
        "p",
        { class: "style-help" },
        "References are variables, lists and dicts pointing at things. Tree links go from a parent to its child; links (next) from an object to another of its class; back links are the way back of a two-way link, dashed; a link that closes a loop points back into the links it came along. In One color, every arrow uses the References color.",
      ),
    );
    return box;
  }

  private lineControls(): HTMLElement {
    const get = () => this.options.get();
    const id = nextId("font");
    const font = h("select", { id, class: "style-select" });
    for (const f of FONTS) font.append(new Option(f.label, f.value));
    font.addEventListener("change", () =>
      this.update((a) => {
        a.font = font.value;
      }),
    );
    this.syncs.push(() => {
      font.value = get().font;
    });
    const flashId = nextId("flash");
    const flash = h("input", { id: flashId, type: "checkbox" });
    flash.addEventListener("change", () =>
      this.update((a) => {
        a.flash = flash.checked;
      }),
    );
    this.syncs.push(() => {
      flash.checked = get().flash;
    });
    const xrayId = nextId("xray");
    const xray = h("input", { id: xrayId, type: "checkbox" });
    xray.addEventListener("change", () =>
      this.update((a) => {
        a.xray = xray.checked;
      }),
    );
    this.syncs.push(() => {
      xray.checked = get().xray;
    });
    return h(
      "div",
      { class: "style-group" },
      this.range(
        "Arrow thickness",
        0.5,
        3,
        0.1,
        "×",
        () => get().arrowWidth,
        (v) =>
          this.update((a) => {
            a.arrowWidth = v;
          }),
        (v) => `${v.toFixed(1)}×`,
      ),
      this.range(
        "Box outlines",
        0.5,
        3,
        0.25,
        " px",
        () => get().borderWidth,
        (v) =>
          this.update((a) => {
            a.borderWidth = v;
          }),
      ),
      this.range(
        "Cell corners",
        0,
        12,
        1,
        " px",
        () => get().cellRadius,
        (v) =>
          this.update((a) => {
            a.cellRadius = v;
          }),
      ),
      h("div", { class: "style-row" }, h("label", { for: id }, "Code font"), font),
      h("div", { class: "style-row" }, h("label", { for: flashId }, "Flash changed cells"), flash),
      h(
        "div",
        {
          class: "style-row",
          title: "Arrows run behind boxes. With this on, a faint dashed line shows where one passes behind a box.",
        },
        h("label", { for: xrayId }, "Show arrows through boxes"),
        xray,
      ),
    );
  }

  /** A labeled checkbox row. */
  private checkbox(label: string, read: () => boolean, write: (value: boolean) => void, title = ""): HTMLElement {
    const id = nextId("check");
    const box = h("input", { id, type: "checkbox" });
    box.addEventListener("change", () => write(box.checked));
    this.syncs.push(() => {
      box.checked = read();
    });
    return h("div", { class: "style-row", title }, h("label", { for: id }, label), box);
  }

  /** How the printed-output card arrives, and the dimming around it. */
  private outputControls(): HTMLElement {
    const get = () => this.options.get().output;
    const toggle = (label: string, key: "fade" | "slide" | "dimFade", title: string) =>
      this.checkbox(
        label,
        () => get()[key],
        (v) =>
          this.update((a) => {
            a.output[key] = v;
          }),
        title,
      );
    return h(
      "div",
      { class: "style-group" },
      toggle("Fade in", "fade", "The card fades in on a step that prints"),
      toggle("Slide in", "slide", "The card slides in from the left"),
      toggle(
        "Fade the dimming",
        "dimFade",
        "With Dim others on, the rest fades down and back up, instead of switching at once",
      ),
      this.range(
        "Duration",
        0,
        1000,
        20,
        " ms",
        () => get().duration,
        (v) =>
          this.update((a) => {
            a.output.duration = v;
          }),
        (v) => `${v} ms`,
      ),
      h("p", { class: "style-note style-hint" }, "Turn both Fade in and Slide in off for a card that just appears."),
    );
  }

  private footer(): HTMLElement {
    const replay = h("button", { type: "button", class: "button small" }, "▶ Replay this step");
    replay.title = "Animate from the previous step to this one, to see the easing";
    replay.addEventListener("click", () => this.options.replay());
    return h("footer", { class: "style-foot" }, replay, h("span", { class: "style-note" }, "Saved in this browser."));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/** Control points of an easing, for drawing its curve. */
export function bezierPoints(easing: string): [number, number, number, number] {
  const named: Record<string, [number, number, number, number]> = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
  };
  if (named[easing]) return named[easing];
  const m = /cubic-bezier\(([^)]*)\)/.exec(easing);
  const nums = m ? m[1].split(",").map(Number) : [];
  return nums.length === 4 && nums.every(Number.isFinite) ? (nums as [number, number, number, number]) : [0, 0, 1, 1];
}
