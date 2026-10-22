/**
 * Saved programs: the "Open…" menu, Save, Save as, Delete, the save dialog,
 * and the name and unsaved-changes dot in the toolbar.
 *
 * Programs are stored by programs.ts; which one is open lives in the app
 * state (state.ts). This controller redraws its part of the toolbar
 * whenever the language or the open program changes, and asks the app to
 * load code when the person opens a program or an example.
 */
import type { Example } from "../examples/index";
import { LANGUAGES } from "../languages";
import type { Program, ProgramStore } from "../programs";
import type { AppStore } from "./state";

/** The page's elements this controller uses, by their ids (see elements.ts). */
export interface ProgramsElements {
  /** The "Open…" menu. */
  programs: HTMLSelectElement;
  programName: HTMLElement;
  programDirty: HTMLElement;
  programDirtyLabel: HTMLElement;
  save: HTMLButtonElement;
  delete: HTMLButtonElement;
  saveDialog: HTMLDialogElement;
  saveName: HTMLInputElement;
  saveHint: HTMLElement;
  /** A live region for screen readers ("Saved \"Sort\""). */
  announce: HTMLElement;
}

export interface ProgramsOptions {
  app: AppStore;
  programs: ProgramStore;
  els: ProgramsElements;
  editor: { getCode(): string; focus(): void };
  /** Put code in the editor and run it, as for a newly opened program. */
  load(code: string): void;
  /** Show an error (a full browser storage, say). */
  showError(message: string): void;
  confirm?(message: string): boolean;
}

export class ProgramsController {
  private savedTimer = 0;
  private readonly confirm: (message: string) => boolean;

  constructor(private readonly options: ProgramsOptions) {
    this.confirm = options.confirm ?? ((message) => window.confirm(message));
    const { els, app } = options;

    els.saveName.addEventListener("input", () => this.updateSaveHint());
    els.saveDialog.querySelector<HTMLButtonElement>('button[value="cancel"]')?.addEventListener("click", (event) => {
      event.preventDefault();
      els.saveDialog.close("cancel");
    });
    els.saveDialog.addEventListener("close", () => this.dialogClosed());
    els.save.addEventListener("click", () => this.save());
    els.delete.addEventListener("click", () => this.deleteOpen());
    els.programs.addEventListener("change", () => this.menuChosen());

    app.watch(
      (s) => s.language,
      () => this.fillMenu(),
    );
    app.watch(
      (s) => s.program,
      () => this.updateUI(),
    );
    app.watch(
      (s) => s.shared,
      () => this.updateUI(),
    );
    this.fillMenu();
    this.updateUI();
  }

  private get language() {
    return this.options.app.get().language;
  }

  private get open(): Program | null {
    return this.options.app.get().program;
  }

  private examples(): Example[] {
    return LANGUAGES[this.language].examples;
  }

  /** Unsaved work: edits to a saved program, code that's neither saved nor an example, or a shared program. */
  hasUnsavedChanges(): boolean {
    if (this.options.app.get().shared) return true;
    const code = this.options.editor.getCode();
    if (this.open) return code !== this.open.code;
    return code.trim() !== "" && !this.examples().some((example) => example.code === code);
  }

  /** The name, the unsaved dot and the Delete button. Call when the code changes. */
  updateUI(): void {
    const { els } = this.options;
    const open = this.open;
    const shared = this.options.app.get().shared;
    els.programName.textContent = open?.name ?? (shared ? "Shared program" : "Untitled");
    els.programName.title = open?.name ?? (shared ? "From a share link: not saved" : "Not saved yet");
    els.programName.classList.toggle("is-untitled", !open);
    const dirty = this.hasUnsavedChanges();
    els.programDirty.hidden = !dirty;
    els.programDirtyLabel.textContent = dirty ? "Unsaved changes" : "";
    els.delete.hidden = !open;
  }

  /** The "Open…" menu: your saved programs, then the examples by topic. */
  fillMenu(): void {
    const { els, programs } = this.options;
    els.programs.replaceChildren(new Option("Open…", "", true, true));
    const saved = programs.list(this.language);
    if (saved.length) {
      const group = document.createElement("optgroup");
      group.label = "Your programs";
      for (const program of saved) group.append(new Option(program.name, `saved:${program.id}`));
      els.programs.append(group);
    }
    // Examples, one group per topic, in the order the topics first appear.
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const [index, example] of this.examples().entries()) {
      const topic = example.group ?? "More";
      let group = groups.get(topic);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = `Examples: ${topic}`;
        groups.set(topic, group);
        els.programs.append(group);
      }
      group.append(new Option(example.name, `example:${index}`));
    }
  }

  /** Ctrl/Cmd + S: save over the open program, or ask for a name the first time. */
  save(): void {
    const open = this.open;
    if (open) this.write(open.name, open.id);
    else this.saveAs();
  }

  /** Ctrl/Cmd + Shift + S: always ask for a name. */
  saveAs(): void {
    const { els } = this.options;
    if (els.saveDialog.open) return;
    els.saveName.value = this.open?.name ?? "";
    this.updateSaveHint();
    els.saveDialog.returnValue = "";
    els.saveDialog.showModal();
    els.saveName.select();
  }

  private updateSaveHint(): void {
    const { els, programs } = this.options;
    const existing = programs.findByName(this.language, els.saveName.value);
    const replacing = !!existing && existing.id !== this.open?.id;
    els.saveHint.textContent = replacing
      ? `A ${LANGUAGES[this.language].label} program with this name already exists. Saving replaces it.`
      : "Saved programs stay in this browser.";
    els.saveHint.classList.toggle("is-warning", replacing);
  }

  private dialogClosed(): void {
    const { els, programs, editor } = this.options;
    if (els.saveDialog.returnValue !== "save") return;
    const name = els.saveName.value.trim();
    if (!name) return;
    // Saving under an existing name replaces that program (the hint warned).
    this.write(name, programs.findByName(this.language, name)?.id);
    editor.focus();
  }

  private write(name: string, id?: string): void {
    const { programs, app, editor, showError } = this.options;
    try {
      const program = programs.save({ id, name, language: this.language, code: editor.getCode() });
      app.setProgram(program);
      this.fillMenu();
      this.updateUI();
      this.showSaved(program);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }

  private showSaved(program: Program): void {
    const { els } = this.options;
    els.announce.textContent = `Saved "${program.name}"`;
    els.save.textContent = "Saved";
    window.clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      els.save.textContent = "Save";
    }, 1200);
  }

  private deleteOpen(): void {
    const { programs, app, els } = this.options;
    const open = this.open;
    if (!open) return;
    if (!this.confirm(`Delete "${open.name}"? This can't be undone.`)) return;
    programs.remove(open.id);
    // The code stays in the editor, now as an unsaved program.
    app.setProgram(null);
    this.fillMenu();
    this.updateUI();
    els.announce.textContent = `Deleted "${open.name}"`;
  }

  private menuChosen(): void {
    const { els, programs, app, load } = this.options;
    const [kind, key] = els.programs.value.split(/:(.*)/s);
    els.programs.value = "";
    const program = kind === "saved" ? programs.get(key) : undefined;
    const example = kind === "example" ? this.examples()[Number(key)] : undefined;
    if (!program && !example) return;
    if (program && program.id === this.open?.id && !this.hasUnsavedChanges()) return;

    if (this.hasUnsavedChanges()) {
      const what = this.open
        ? `your changes to "${this.open.name}"`
        : this.options.app.get().shared
          ? "the shared program"
          : "your unsaved program";
      if (!this.confirm(`Discard ${what}?`)) return;
    }
    app.setProgram(program ?? null); // before the code changes, so the dirty dot is right
    load(program?.code ?? example!.code);
    this.updateUI();
  }
}
