/**
 * Inputs you can switch between (trace/inputs.ts): the code window's Input
 * button shows when the program has a `viz: input` hint, and its menu lists
 * each input's variants (as written, sorted, reversed, random, empty, one
 * item, …) with the value each would run. Choosing one runs the program
 * with it; the code in the editor isn't changed, but the line is dimmed and
 * a note after it says what's run instead. Live keeps running with the
 * choices as the code is edited: the variants are made again from the
 * value as it's written now. A random one keeps its values (its seed) until
 * it's rolled again (↻). The choices go when the language or the program
 * does.
 */
import type { LanguageId } from "../languages";
import {
  applyInputs,
  findInputs,
  type InputChoice,
  type InputLanguage,
  type InputVar,
  variantsOf,
  WRITTEN,
} from "../trace/inputs";
import type { AppStore } from "./state";

export interface InputOptions {
  app: AppStore;
  els: { inputButton: HTMLButtonElement; inputMenu: HTMLElement };
  editor: {
    getCode(): string;
    setInputNotes(notes: { from: number; to: number; text: string; hover: string }[]): void;
  };
  /** Run the program again (an input was chosen). */
  run(): void;
  /** The input it's run with changed (Measure's last result is for another one). */
  changed?(): void;
  /** A new random seed (tests pass their own). */
  seed?(): number;
}

/** A value in the menu and the editor's note is cut to about this many characters. */
const SHORT = 48;

const short = (text: string, max = SHORT) => {
  const flat = text.replace(/\s*\n\s*/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const inputLanguage = (language: LanguageId): InputLanguage | null => (language === "sql" ? null : language);

export class InputController {
  /** The variant chosen for each input, by its variable's name. */
  private readonly choices = new Map<string, InputChoice>();
  /** Each input's seed for its random values (the menu shows them before they're chosen). */
  private readonly seeds = new Map<string, number>();
  /** The program's inputs, as its code is now. */
  private inputs: InputVar[] = [];
  private readonly seed: () => number;

  constructor(private readonly options: InputOptions) {
    const { app, els } = options;
    this.seed = options.seed ?? (() => Math.floor(Math.random() * 2 ** 31) + 1);
    // Another language or program: its inputs are others.
    app.watch(
      (s) => s.language,
      () => this.forget(),
    );
    app.watch(
      (s) => s.program?.id ?? null,
      () => this.forget(),
    );
    els.inputButton.addEventListener("click", () => this.toggleMenu());
    els.inputMenu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.toggleMenu(false);
      els.inputButton.focus();
    });
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (!els.inputMenu.hidden && !els.inputMenu.contains(target) && !els.inputButton.contains(target))
        this.toggleMenu(false);
    });
    this.refresh();
  }

  /** The code that's run for the editor's: the inputs chosen swapped in, and problems with `viz: input` hints. */
  prepare(code: string, language: LanguageId): { code: string; warnings: { line: number; message: string }[] } {
    const lang = inputLanguage(language);
    if (!lang) return { code, warnings: [] };
    return { code: applyInputs(code, lang, this.choices).code, warnings: findInputs(code, lang).problems };
  }

  /** The code in the editor changed: its inputs, the button, the notes and the menu again. */
  codeChanged(): void {
    this.refresh();
  }

  /** The variant chosen for an input (as written when none is). */
  chosen(name: string): string {
    return this.choices.get(name)?.variant ?? WRITTEN;
  }

  /** Run with another value for an input. Random again: new random values. */
  choose(name: string, variant: string): void {
    const was = this.choices.get(name);
    // The random values the menu showed; chosen again, new ones.
    if (variant === "random" && was?.variant === "random") this.seeds.set(name, this.seed());
    if (variant === WRITTEN) this.choices.delete(name);
    else this.choices.set(name, { variant, seed: this.seedFor(name) });
    this.refresh();
    this.options.changed?.();
    this.options.run();
  }

  /** An input's seed for its random values: the same until they're rolled again. */
  private seedFor(name: string): number {
    let seed = this.seeds.get(name);
    if (seed === undefined) {
      seed = this.seed();
      this.seeds.set(name, seed);
    }
    return seed;
  }

  /** Every input as written again. */
  reset(): void {
    if (!this.choices.size) return;
    this.choices.clear();
    this.refresh();
    this.options.changed?.();
    this.options.run();
  }

  toggleMenu(open = this.options.els.inputMenu.hidden): void {
    const { inputButton: button, inputMenu: menu } = this.options.els;
    if (open && !this.inputs.length) open = false;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.renderMenu();
    this.placeMenu();
    menu.querySelector<HTMLInputElement>("input:checked")?.focus();
  }

  private forget(): void {
    this.choices.clear();
    this.seeds.clear();
    this.toggleMenu(false);
    this.refresh();
  }

  private language(): InputLanguage | null {
    return inputLanguage(this.options.app.get().language);
  }

  private refresh(): void {
    const { els, editor } = this.options;
    const lang = this.language();
    const code = editor.getCode();
    this.inputs = lang ? findInputs(code, lang).inputs : [];
    const button = els.inputButton;
    button.hidden = !this.inputs.length;
    if (!this.inputs.length && !els.inputMenu.hidden) this.toggleMenu(false);

    // What runs instead, beside each input that's switched.
    const notes: { from: number; to: number; text: string; hover: string }[] = [];
    const switched: string[] = [];
    for (const input of this.inputs) {
      const choice = this.choices.get(input.name);
      if (!choice || choice.variant === WRITTEN || !lang) continue;
      const variant = variantsOf(input, lang, choice.seed).find((v) => v.id === choice.variant);
      if (!variant) continue;
      switched.push(variant.label);
      notes.push({
        from: input.line,
        to: input.line + input.written.split("\n").length - 1,
        text: `▸ runs with ${variant.label.toLowerCase()}: ${short(variant.text)}`,
        hover: `**${input.name} runs with ${variant.label.toLowerCase()}:** \`${short(variant.text, 400)}\`\n\nThe code isn't changed. Choose another input in the code window's **Input** menu.`,
      });
    }
    editor.setInputNotes(notes);
    const label = button.querySelector<HTMLElement>(".input-button-label") ?? button;
    label.textContent =
      switched.length === 0
        ? "Input"
        : switched.length === 1
          ? `Input: ${switched[0]}`
          : `Inputs: ${switched.length} switched`;
    button.classList.toggle("is-switched", switched.length > 0);
    button.title = switched.length
      ? `Running with other input values (${switched.join(", ")}). Choose another, or as written.`
      : "Run the program with other input values: sorted, reversed, random, empty, one item (viz: input)";
    if (!els.inputMenu.hidden) this.renderMenu();
  }

  private renderMenu(): void {
    const menu = this.options.els.inputMenu;
    const lang = this.language();
    if (!lang) return;
    const focused = menu.contains(document.activeElement) ? (document.activeElement as HTMLElement).id : "";
    const groups = this.inputs.map((input) => {
      const group = document.createElement("fieldset");
      group.className = "input-group";
      const legend = document.createElement("legend");
      const name = document.createElement("code");
      name.textContent = input.name;
      const where = document.createElement("span");
      where.className = "input-line";
      where.textContent = `line ${input.line}`;
      legend.append(name, where);
      group.append(legend);
      for (const variant of variantsOf(input, lang, this.seedFor(input.name))) {
        const row = document.createElement("div");
        row.className = "input-option";
        const id = `input-${input.name}-${variant.id}`;
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `input-${input.name}`;
        radio.id = id;
        radio.value = variant.id;
        radio.checked = this.chosen(input.name) === variant.id;
        radio.addEventListener("change", () => this.choose(input.name, variant.id));
        const label = document.createElement("label");
        label.htmlFor = id;
        const text = document.createElement("span");
        text.className = "input-option-label";
        text.textContent = variant.label;
        const value = document.createElement("code");
        value.className = "input-option-value";
        value.textContent = short(variant.text);
        value.title = short(variant.text, 400);
        label.append(text, value);
        row.append(radio, label);
        if (variant.id === "random" && radio.checked) {
          const again = document.createElement("button");
          again.type = "button";
          again.id = `input-${input.name}-again`;
          again.className = "input-again";
          again.textContent = "↻";
          again.title = "New random values";
          again.setAttribute("aria-label", `New random values for ${input.name}`);
          again.addEventListener("click", () => this.choose(input.name, "random"));
          row.append(again);
        }
        group.append(row);
      }
      return group;
    });
    const foot = document.createElement("div");
    foot.className = "input-foot";
    const note = document.createElement("p");
    note.className = "input-note-text";
    note.textContent = "The code isn't changed: the value is swapped in when it runs.";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.id = "input-reset";
    reset.className = "input-reset";
    reset.textContent = "All as written";
    reset.disabled = this.choices.size === 0;
    reset.addEventListener("click", () => this.reset());
    foot.append(note, reset);
    menu.replaceChildren(...groups, foot);
    if (focused) document.getElementById(focused)?.focus();
  }

  /** Under the button, inside the window. */
  private placeMenu(): void {
    const { inputButton: button, inputMenu: menu } = this.options.els;
    const r = button.getBoundingClientRect();
    const w = menu.offsetWidth || 320;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8)))}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
  }
}
