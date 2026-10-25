/**
 * The Layout panel: the memory and loop views' spacing (render/spacing.ts),
 * applied as you change it, and layouts saved by name. Like the Style panel
 * it floats over the editor, so the canvas stays in view while you adjust
 * it, and it uses the Style panel's look (the style-* classes).
 */
import type { SpacingController } from "./app/spacingController";
import {
  clampSpacing,
  DEFAULT_SPACING,
  defaultSpacing,
  SPACING_FIELDS,
  SPACING_GROUPS,
  type SpacingField,
  type SpacingGroup,
} from "./render/spacing";
import { h } from "./stylePanel";

export interface SpacingPanelOptions {
  /** The panel is placed inside this element (the editor pane). */
  host: HTMLElement;
  /** The toolbar button that opens and closes it. */
  button: HTMLButtonElement;
  controller: Pick<SpacingController, "get" | "set" | "layouts" | "choice" | "load" | "save" | "remove">;
  /** Called when the panel opens, so other floating panels can close. */
  onOpen?(): void;
}

/** Longest name a saved layout can have. */
export const MAX_NAME = 40;

const DEFAULT_VALUE = "default";
const CUSTOM_VALUE = "custom";
/** Saved layouts' menu values: a prefix, so a layout called "default" can't clash. */
const SAVED_PREFIX = "saved:";

let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

export class SpacingPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  /** Re-read every control's value (after a load or reset). */
  private syncs: (() => void)[] = [];
  private readonly open = new Set<SpacingGroup>(["arrows", "boxes", "loop"]);
  private menu!: HTMLSelectElement;
  private nameInput!: HTMLInputElement;
  private deleteButton!: HTMLButtonElement;
  private status!: HTMLElement;

  constructor(private readonly options: SpacingPanelOptions) {
    this.body = h("div", { class: "style-body" });
    const close = h(
      "button",
      { type: "button", class: "style-close", "aria-label": "Close layout settings", title: "Close (Esc)" },
      "×",
    );
    close.addEventListener("click", () => this.toggle(false));
    this.el = h(
      "section",
      { class: "style-panel spacing-panel", id: "layout-panel", role: "dialog", "aria-label": "Layout", hidden: true },
      h(
        "header",
        { class: "style-head" },
        h("h2", { class: "style-title" }, "Layout"),
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

  private get c() {
    return this.options.controller;
  }

  private sync(): void {
    for (const sync of this.syncs) sync();
  }

  private say(text: string, warning = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("is-warning", warning);
  }

  private build(): void {
    this.syncs = [];
    this.body.replaceChildren(
      ...this.layoutRows(),
      ...SPACING_GROUPS.map((group) => this.section(group.key, group.title)),
      h(
        "footer",
        { class: "style-foot" },
        h(
          "span",
          { class: "style-note" },
          "Saved in this browser. Boxes you've dragged stay where you put them (Reset layout in the memory window puts them back).",
        ),
      ),
    );
    this.sync();
  }

  // ---------------------------------------------------------- saved layouts

  private layoutRows(): HTMLElement[] {
    const menuId = nextId("layout-menu");
    this.menu = h("select", { id: menuId, class: "style-select", "data-testid": "layout-menu" });
    this.menu.addEventListener("change", () => {
      const value = this.menu.value;
      if (value === DEFAULT_VALUE) this.c.load(null);
      else if (value.startsWith(SAVED_PREFIX)) this.c.load(value.slice(SAVED_PREFIX.length));
      this.say("");
      this.sync();
    });
    const reset = h("button", { type: "button", class: "button quiet small" }, "Reset all");
    reset.title = "Back to the default spacing";
    reset.addEventListener("click", () => {
      this.c.set(defaultSpacing());
      this.say("Back to the default spacing.");
      this.sync();
    });

    const nameId = nextId("layout-name");
    this.nameInput = h("input", {
      id: nameId,
      type: "text",
      class: "style-text",
      maxlength: MAX_NAME,
      spellcheck: false,
      placeholder: "Name this layout",
      autocomplete: "off",
    });
    const save = h("button", { type: "button", class: "button small" }, "Save");
    save.title = "Save the spacing on screen under this name (a layout of the same name is replaced)";
    const doSave = () => {
      const result = this.c.save(this.nameInput.value);
      if (!result.ok) {
        this.say(result.reason, true);
        this.nameInput.focus();
        return;
      }
      this.say(result.replaced ? `Updated “${result.name}”.` : `Saved “${result.name}”.`);
      this.sync();
    };
    save.addEventListener("click", doSave);
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSave();
      }
    });
    this.deleteButton = h("button", { type: "button", class: "button quiet small" }, "Delete");
    this.deleteButton.addEventListener("click", () => {
      const choice = this.c.choice();
      if (choice.kind !== "saved") return;
      this.c.remove(choice.name);
      this.say(`Deleted “${choice.name}”. The spacing on screen hasn't changed.`);
      this.sync();
    });

    this.status = h("p", { class: "style-status", role: "status", "aria-live": "polite" });
    this.syncs.push(() => this.syncMenu());
    return [
      h("div", { class: "style-row style-theme" }, h("label", { for: menuId }, "Layout"), this.menu, reset),
      h(
        "div",
        { class: "style-row spacing-save" },
        h("label", { for: nameId }, "Save as"),
        this.nameInput,
        h("span", { class: "spacing-save-buttons" }, save, this.deleteButton),
      ),
      this.status,
    ];
  }

  private syncMenu(): void {
    const choice = this.c.choice();
    const options = [new Option("Default", DEFAULT_VALUE)];
    for (const layout of this.c.layouts()) options.push(new Option(layout.name, SAVED_PREFIX + layout.name));
    if (choice.kind === "custom") options.push(new Option("Custom (not saved)", CUSTOM_VALUE));
    this.menu.replaceChildren(...options);
    this.menu.value =
      choice.kind === "default" ? DEFAULT_VALUE : choice.kind === "saved" ? SAVED_PREFIX + choice.name : CUSTOM_VALUE;
    this.deleteButton.hidden = choice.kind !== "saved";
    if (choice.kind === "saved" && document.activeElement !== this.nameInput) this.nameInput.value = choice.name;
  }

  // ---------------------------------------------------------- the settings

  private section(group: SpacingGroup, title: string): HTMLElement {
    const fields = SPACING_FIELDS.filter((f) => f.group === group);
    const resetGroup = h("button", { type: "button", class: "button quiet small" }, "Reset section");
    resetGroup.addEventListener("click", () => {
      const next = { ...this.c.get() };
      for (const f of fields) next[f.key] = DEFAULT_SPACING[f.key];
      this.c.set(next);
      this.say("");
      this.sync();
    });
    const details = h(
      "details",
      { class: "style-section", open: this.open.has(group), "data-group": group },
      h("summary", {}, title),
      h(
        "div",
        { class: "style-group" },
        ...fields.map((f) => this.field(f)),
        h("div", { class: "style-row style-actions" }, resetGroup),
      ),
    );
    details.addEventListener("toggle", () => {
      if (details.open) this.open.add(group);
      else this.open.delete(group);
    });
    return details;
  }

  /** A slider, the exact value (typed or stepped), and a button back to the default. */
  private field(field: SpacingField): HTMLElement {
    const id = nextId(`spacing-${field.key}`);
    const helpId = `${id}-help`;
    const range = h("input", {
      id,
      type: "range",
      min: field.min,
      max: field.max,
      step: field.step,
      class: "style-range",
      "aria-describedby": helpId,
      "data-key": field.key,
    });
    const number = h("input", {
      type: "number",
      min: field.min,
      max: field.max,
      step: field.step,
      class: "style-text spacing-number",
      "aria-label": `${field.label}, in pixels`,
      "data-key": field.key,
    });
    const reset = h(
      "button",
      {
        type: "button",
        class: "spacing-reset",
        "aria-label": `${field.label}: back to the default, ${DEFAULT_SPACING[field.key]}`,
        title: `Back to the default (${DEFAULT_SPACING[field.key]})`,
      },
      "↺",
    );
    const write = (value: number) => {
      const next = { ...this.c.get(), [field.key]: clampSpacing(field.key, value) };
      this.c.set(next);
      this.syncMenu();
      syncRow();
    };
    range.addEventListener("input", () => write(Number(range.value)));
    number.addEventListener("input", () => {
      // Typing "1" on the way to "14" mustn't jump the layout to the minimum: only use values in range.
      const value = number.valueAsNumber;
      if (Number.isFinite(value) && value >= field.min && value <= field.max) write(value);
    });
    number.addEventListener("change", () => {
      write(Number.isFinite(number.valueAsNumber) ? number.valueAsNumber : DEFAULT_SPACING[field.key]);
    });
    reset.addEventListener("click", () => write(DEFAULT_SPACING[field.key]));
    const row = h(
      "div",
      { class: "spacing-field" },
      h("div", { class: "style-row spacing-row" }, h("label", { for: id }, field.label), range, number, reset),
      h("p", { class: "spacing-help", id: helpId }, field.help),
    );
    const syncRow = () => {
      const value = this.c.get()[field.key];
      range.value = String(value);
      if (document.activeElement !== number) number.value = String(value);
      const changed = value !== DEFAULT_SPACING[field.key];
      reset.hidden = !changed;
      row.classList.toggle("is-changed", changed);
    };
    this.syncs.push(syncRow);
    return row;
  }
}
