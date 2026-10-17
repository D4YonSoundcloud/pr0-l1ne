// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES } from "../languages";
import { ProgramStore } from "../programs";
import { createSettings, type KeyValueStorage } from "../settings";
import { ProgramsController } from "./programsController";
import { AppStore } from "./state";

// jsdom has no <dialog> yet: open, close with a return value, fire "close".
beforeEach(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement, value?: string) {
    if (value !== undefined) this.returnValue = value;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

/** The toolbar's program controls, a fake editor, and a controller over them. */
function setup(storage = memoryStorage()) {
  document.body.innerHTML = `
    <select id="menu"></select>
    <span id="name"></span><span id="dirty" hidden></span><span id="dirty-label"></span>
    <button id="save">Save</button><button id="delete" hidden>Delete</button>
    <dialog id="dialog"><input id="dialog-name" /><p id="hint"></p><button value="cancel">Cancel</button></dialog>
    <div id="announce"></div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const settings = createSettings(storage);
  const programs = new ProgramStore(settings.programStorage());
  const app = new AppStore(settings, programs);
  const editor = { code: LANGUAGES.javascript.examples[0].code, getCode: () => editor.code, focus: vi.fn() };
  const loaded: string[] = [];
  const errors: string[] = [];
  const confirm = vi.fn(() => true);
  const controller = new ProgramsController({
    app,
    programs,
    els: {
      programs: $("menu"),
      programName: $("name"),
      programDirty: $("dirty"),
      programDirtyLabel: $("dirty-label"),
      save: $("save"),
      delete: $("delete"),
      saveDialog: $("dialog"),
      saveName: $("dialog-name"),
      saveHint: $("hint"),
      announce: $("announce"),
    },
    editor,
    load: (code) => {
      loaded.push(code);
      editor.code = code;
    },
    showError: (message) => errors.push(message),
    confirm,
  });
  const menu = $<HTMLSelectElement>("menu");
  const choose = (value: string) => {
    menu.value = value;
    menu.dispatchEvent(new Event("change"));
  };
  const saveAs = (name: string) => {
    controller.saveAs();
    $<HTMLInputElement>("dialog-name").value = name;
    $<HTMLDialogElement>("dialog").close("save");
  };
  return { app, programs, settings, editor, controller, loaded, errors, confirm, menu, choose, saveAs, $, storage };
}

const optionLabels = (menu: HTMLSelectElement) => [...menu.options].map((o) => o.textContent);

describe("ProgramsController", () => {
  it("starts untitled, with the examples in the Open menu", () => {
    const { $, menu } = setup();
    expect($("name").textContent).toBe("Untitled");
    expect($("dirty").hidden).toBe(true); // an example isn't unsaved work
    expect(optionLabels(menu)).toContain(LANGUAGES.javascript.examples[0].name);
  });

  it("marks edited code as unsaved", () => {
    const { $, editor, controller } = setup();
    editor.code = "let mine = 1;";
    controller.updateUI();
    expect($("dirty").hidden).toBe(false);
    expect($("dirty-label").textContent).toBe("Unsaved changes");
  });

  it("asks for a name the first time, then saves over it", () => {
    const { $, editor, controller, programs, saveAs, app } = setup();
    editor.code = "let mine = 1;";
    controller.save();
    expect(($("dialog") as HTMLDialogElement).open).toBe(true);
    saveAs("Mine");
    expect(app.get().program?.name).toBe("Mine");
    expect($("name").textContent).toBe("Mine");
    expect($("dirty").hidden).toBe(true);
    expect($("announce").textContent).toBe('Saved "Mine"');

    editor.code = "let mine = 2;";
    controller.save(); // no dialog this time
    expect(programs.list("javascript").map((p) => [p.name, p.code])).toEqual([["Mine", "let mine = 2;"]]);
  });

  it("lists saved programs first in the Open menu", () => {
    const { editor, saveAs, menu } = setup();
    editor.code = "let a = 1;";
    saveAs("Alpha");
    expect(optionLabels(menu).slice(0, 2)).toEqual(["Open…", "Alpha"]);
  });

  it("warns before saving over another program with the same name", () => {
    const { $, editor, saveAs, controller, choose, programs } = setup();
    editor.code = "let a = 1;";
    saveAs("Alpha");
    choose("example:0"); // now an example is open, not Alpha
    editor.code = "let b = 2;";
    controller.saveAs();
    const name = $<HTMLInputElement>("dialog-name");
    const hint = $("hint");
    name.value = "beta";
    name.dispatchEvent(new Event("input"));
    expect(hint.classList.contains("is-warning")).toBe(false);
    name.value = "ALPHA "; // names match ignoring case and spaces
    name.dispatchEvent(new Event("input"));
    expect(hint.classList.contains("is-warning")).toBe(true);
    expect(hint.textContent).toMatch(/already exists. Saving replaces it/);
    ($("dialog") as HTMLDialogElement).close("save");
    expect(programs.list("javascript").map((p) => [p.name, p.code])).toEqual([["ALPHA", "let b = 2;"]]);
  });

  it("opens an example, asking first when there's unsaved work", () => {
    const { editor, controller, choose, confirm, loaded, app } = setup();
    editor.code = "let mine = 1;";
    controller.updateUI();
    confirm.mockReturnValueOnce(false);
    choose("example:1");
    expect(loaded).toEqual([]); // said no
    choose("example:1");
    expect(confirm).toHaveBeenLastCalledWith("Discard your unsaved program?");
    expect(loaded).toEqual([LANGUAGES.javascript.examples[1].code]);
    expect(app.get().program).toBeNull();
  });

  it("opens a saved program", () => {
    const { editor, saveAs, choose, loaded, app, programs } = setup();
    editor.code = "let a = 1;";
    saveAs("Alpha");
    choose("example:0");
    const alpha = programs.list("javascript")[0];
    choose(`saved:${alpha.id}`);
    expect(loaded.at(-1)).toBe("let a = 1;");
    expect(app.get().program?.id).toBe(alpha.id);
  });

  it("deletes the open program but keeps its code in the editor", () => {
    const { $, editor, saveAs, programs, app, loaded } = setup();
    editor.code = "let a = 1;";
    saveAs("Alpha");
    $("delete").click();
    expect(programs.list("javascript")).toEqual([]);
    expect(app.get().program).toBeNull();
    expect(editor.code).toBe("let a = 1;");
    expect(loaded).toEqual([]);
    expect($("announce").textContent).toBe('Deleted "Alpha"');
  });

  it("follows the language: its own programs, and the one left open in it", () => {
    const storage = memoryStorage();
    const first = setup(storage);
    first.editor.code = "let a = 1;";
    first.saveAs("JS one");
    first.app.setLanguage("python");
    expect(first.app.get().program).toBeNull();
    expect(optionLabels(first.menu)).not.toContain("JS one");
    expect(optionLabels(first.menu)).toContain(LANGUAGES.python.examples[0].name);
    first.app.setLanguage("javascript");
    expect(first.app.get().program?.name).toBe("JS one");

    // A reload reopens it too.
    const again = setup(storage);
    expect(again.app.get().program?.name).toBe("JS one");
  });

  it("reports a full browser storage instead of losing the save silently", () => {
    const full = memoryStorage();
    full.setItem = (key) => {
      if (key.endsWith("programs")) throw new Error("QuotaExceededError");
    };
    const { editor, saveAs, errors, app } = setup(full);
    editor.code = "let a = 1;";
    saveAs("Alpha");
    expect(errors).toHaveLength(1);
    expect(app.get().program).toBeNull();
  });
});
