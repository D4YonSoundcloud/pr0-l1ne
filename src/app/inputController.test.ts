// @vitest-environment jsdom
/**
 * The Input menu (inputController.ts): shown only when the program has a
 * `viz: input`; its variants with their values; choosing one runs the
 * program with it swapped in (the editor's code unchanged, a note beside
 * the line); Random keeps the values the menu showed until ↻; All as
 * written; and a new language or program forgets the choices.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { InputController } from "./inputController";
import { makeApp } from "./testHelpers";

const CODE = `// viz: input
const nums = [5, 3, 8, 1];
// viz: input
let k = 4;
console.log(nums, k);
`;

beforeEach(() => {
  document.body.innerHTML = `<button id="input-button" hidden><span class="input-button-label"></span></button><div id="input-menu" hidden></div>`;
});

function setup(code = CODE) {
  const { app } = makeApp();
  app.setLanguage("javascript");
  let text = code;
  const notes: { from: number; to: number; text: string; hover: string }[][] = [];
  let runs = 0;
  let changed = 0;
  let seed = 100;
  const els = {
    inputButton: document.getElementById("input-button") as HTMLButtonElement,
    inputMenu: document.getElementById("input-menu") as HTMLElement,
  };
  const inputs = new InputController({
    app,
    els,
    editor: { getCode: () => text, setInputNotes: (n) => notes.push(n) },
    run: () => runs++,
    changed: () => changed++,
    seed: () => seed++,
  });
  return {
    app,
    inputs,
    els,
    notes: () => notes.at(-1),
    runs: () => runs,
    changed: () => changed,
    edit: (next: string) => {
      text = next;
      inputs.codeChanged();
    },
    ran: () => inputs.prepare(text, "javascript").code,
  };
}

const radios = () => [...document.querySelectorAll<HTMLInputElement>("#input-menu input[type=radio]")];
const pick = (name: string, variant: string) => {
  const radio = document.getElementById(`input-${name}-${variant}`) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(new Event("change"));
};

describe("the Input menu", () => {
  it("shows only when the program has an input, and lists each one's variants with their values", () => {
    const { els, edit } = setup("let a = 1;\n");
    expect(els.inputButton.hidden).toBe(true);
    edit(CODE);
    expect(els.inputButton.hidden).toBe(false);
    els.inputButton.click();
    expect(els.inputMenu.hidden).toBe(false);
    expect(els.inputButton.getAttribute("aria-expanded")).toBe("true");
    const groups = [...els.inputMenu.querySelectorAll("legend")].map((l) => l.textContent);
    expect(groups).toEqual(["numsline 2", "kline 4"]);
    const nums = radios().filter((r) => r.name === "input-nums");
    expect(nums.map((r) => r.value)).toEqual(["written", "sorted", "reversed", "random", "empty", "one", "same"]);
    expect(nums[0].checked).toBe(true);
    const sorted = document.querySelector('label[for="input-nums-sorted"]')!;
    expect(sorted.textContent).toBe("Sorted[1, 3, 5, 8]");
    els.inputMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(els.inputMenu.hidden).toBe(true);
  });

  it("runs with the value chosen swapped in, says so beside the line and on the button, and back as written", () => {
    const { els, inputs, notes, runs, changed, ran } = setup();
    els.inputButton.click();
    pick("nums", "sorted");
    expect(runs()).toBe(1);
    expect(changed()).toBe(1);
    expect(ran()).toBe(CODE.replace("[5, 3, 8, 1]", "[1, 3, 5, 8]"));
    expect(notes()).toEqual([
      {
        from: 2,
        to: 2,
        text: "▸ runs with sorted: [1, 3, 5, 8]",
        hover: expect.stringContaining("nums runs with sorted"),
      },
    ]);
    expect(els.inputButton.textContent).toBe("Input: Sorted");
    expect(els.inputButton.classList.contains("is-switched")).toBe(true);
    pick("k", "zero");
    expect(els.inputButton.textContent).toBe("Inputs: 2 switched");
    expect(ran()).toContain("let k = 0;");
    // The menu's drawn again: the choice is checked.
    expect((document.getElementById("input-nums-sorted") as HTMLInputElement).checked).toBe(true);
    (document.getElementById("input-reset") as HTMLButtonElement).click();
    expect(ran()).toBe(CODE);
    expect(notes()).toEqual([]);
    expect(els.inputButton.textContent).toBe("Input");
    expect(inputs.chosen("nums")).toBe("written");
  });

  it("random: the values the menu showed, kept as the code's edited, until ↻ rolls new ones", () => {
    const { els, ran, edit } = setup();
    els.inputButton.click();
    const shown = document.querySelector('label[for="input-nums-random"] .input-option-value')!.textContent!;
    pick("nums", "random");
    expect(ran()).toContain(`const nums = ${shown};`);
    // Live: the code edited, the same random values (it's the same length).
    edit(CODE.replace("console.log(nums, k);", "console.log(k, nums);"));
    expect(ran()).toContain(`const nums = ${shown};`);
    let rolled = shown;
    for (let i = 0; i < 5 && rolled === shown; i++) {
      (document.getElementById("input-nums-again") as HTMLButtonElement).click();
      rolled = /const nums = (\[.*\]);/.exec(ran())![1];
    }
    expect(rolled).not.toBe(shown);
  });

  it("follows the code as it's edited: the variants are of the value written now, and the button goes with the hint", () => {
    const { els, ran, edit, notes } = setup();
    els.inputButton.click();
    pick("nums", "sorted");
    edit(CODE.replace("[5, 3, 8, 1]", "[9, 2]"));
    expect(ran()).toContain("const nums = [2, 9];");
    expect(notes()![0].text).toBe("▸ runs with sorted: [2, 9]");
    edit("console.log(1);\n");
    expect(els.inputButton.hidden).toBe(true);
    expect(els.inputMenu.hidden).toBe(true);
    expect(notes()).toEqual([]);
  });

  it("forgets the choices for another language or program, and gives SQL none", () => {
    const { app, els, ran, inputs } = setup();
    els.inputButton.click();
    pick("nums", "empty");
    app.setLanguage("python");
    app.setLanguage("javascript");
    expect(ran()).toBe(CODE);
    expect(inputs.prepare(CODE, "sql")).toEqual({ code: CODE, warnings: [] });
  });

  it("says what's wrong with a hint it can't use, for the editor and the banner", () => {
    const { inputs } = setup();
    const { warnings } = inputs.prepare("// viz: input\nconst xs = make();\n", "javascript");
    expect(warnings).toEqual([
      { line: 1, message: expect.stringMatching(/^xs: "input" works on a value written out/) },
    ]);
  });
});
