// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SPACING, defaultSpacing, setSpacing, spacing } from "../render/spacing";
import { MAX_NAME } from "../spacingPanel";
import { cleanName, parseSavedLayouts, SpacingController } from "./spacingController";
import { makeApp, manualTimers } from "./testHelpers";

afterEach(() => setSpacing(defaultSpacing()));

function setup(storage?: ReturnType<typeof makeApp>["storage"]) {
  document.body.innerHTML = `<section id="editor-pane"></section><button id="layout-settings"></button>`;
  const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const { settings, storage: store } = makeApp(storage);
  const timers = manualTimers();
  const frames: (() => void)[] = [];
  let redraws = 0;
  const opened: string[] = [];
  const controller = new SpacingController({
    settings,
    els: { editorPane: $("#editor-pane"), layoutSettings: $<HTMLButtonElement>("#layout-settings") },
    redraw: () => redraws++,
    onOpen: () => opened.push("layout"),
    ...timers,
    requestFrame: (callback) => frames.push(callback),
  });
  return {
    controller,
    settings,
    storage: store,
    timers,
    opened,
    $,
    /** Run the frame the redraw waits for. */
    paint() {
      for (const frame of frames.splice(0)) frame();
    },
    get redraws() {
      return redraws;
    },
  };
}

/** Move a slider (or type in a number box) the way a person does. */
function input(el: HTMLInputElement, value: number, event = "input") {
  el.value = String(value);
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

describe("SpacingController", () => {
  it("uses the saved spacing from the start", () => {
    const first = setup();
    first.settings.spacing.set(JSON.stringify({ lane: 11, rowGap: 50 }));
    setup(first.storage);
    expect(spacing.lane).toBe(11);
    expect(spacing.rowGap).toBe(50);
    expect(spacing.stackGap).toBe(DEFAULT_SPACING.stackGap);
  });

  it("redraws once a frame however many changes come, and saves once they pause", () => {
    const t = setup();
    t.controller.set({ ...defaultSpacing(), lane: 9 });
    t.controller.set({ ...defaultSpacing(), lane: 10 });
    expect(spacing.lane).toBe(10); // applied at once, for whatever draws next
    expect(t.redraws).toBe(0);
    t.paint();
    expect(t.redraws).toBe(1);
    expect(t.settings.spacing.get()).toBeNull();
    t.timers.run();
    expect(JSON.parse(t.settings.spacing.get()!)).toEqual({ lane: 10 });
  });

  it("saves, switches between and deletes named layouts", () => {
    const t = setup();
    expect(t.controller.choice()).toEqual({ kind: "default" });
    t.controller.set({ ...defaultSpacing(), columnGap: 120 });
    expect(t.controller.choice()).toEqual({ kind: "custom" });
    expect(t.controller.save("  Roomy   columns ")).toEqual({ ok: true, name: "Roomy columns", replaced: false });
    expect(t.controller.choice()).toEqual({ kind: "saved", name: "Roomy columns" });

    t.controller.load(null);
    expect(spacing.columnGap).toBe(DEFAULT_SPACING.columnGap);
    expect(t.controller.choice()).toEqual({ kind: "default" });
    t.controller.load("Roomy columns");
    expect(spacing.columnGap).toBe(120);

    // Saving under the same name replaces it.
    t.controller.set({ ...t.controller.get(), rowGap: 60 });
    expect(t.controller.save("Roomy columns")).toMatchObject({ ok: true, replaced: true });
    expect(t.controller.layouts()).toHaveLength(1);

    // Saved in this browser: a new page has them, and the spacing that was on screen.
    t.timers.run();
    const again = setup(t.storage);
    expect(again.controller.layouts().map((l) => l.name)).toEqual(["Roomy columns"]);
    expect(again.controller.layouts()[0].values.rowGap).toBe(60);

    again.controller.remove("Roomy columns");
    expect(again.controller.layouts()).toEqual([]);
    expect(spacing.rowGap).toBe(60); // what's on screen stays
    expect(again.controller.choice()).toEqual({ kind: "custom" });
  });

  it("won't save without a name", () => {
    const t = setup();
    expect(t.controller.save("   ")).toMatchObject({ ok: false });
    expect(t.controller.layouts()).toEqual([]);
  });

  it("reads saved layouts defensively", () => {
    expect(parseSavedLayouts("nope")).toEqual([]);
    expect(parseSavedLayouts(JSON.stringify({ name: "x" }))).toEqual([]);
    const read = parseSavedLayouts(
      JSON.stringify([
        { name: "A", values: { lane: 3 } },
        { name: "A", values: {} },
        { values: {} },
        { name: " " },
        null,
      ]),
    );
    expect(read.map((l) => l.name)).toEqual(["A"]);
    expect(read[0].values.lane).toBe(3);
    expect(cleanName("x".repeat(100))).toHaveLength(MAX_NAME);
  });
});

describe("the Layout panel", () => {
  const slider = (key: string) => document.querySelector<HTMLInputElement>(`input[type=range][data-key="${key}"]`)!;
  const number = (key: string) => document.querySelector<HTMLInputElement>(`input[type=number][data-key="${key}"]`)!;
  const menu = () => document.querySelector<HTMLSelectElement>("[data-testid=layout-menu]")!;
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("#layout-panel button")].find((b) => b.textContent === text)!;

  it("opens from its toolbar button, and closes with Escape", () => {
    const t = setup();
    const panel = t.$("#layout-panel");
    expect(panel.hidden).toBe(true);
    t.$<HTMLButtonElement>("#layout-settings").click();
    expect(panel.hidden).toBe(false);
    expect(t.opened).toEqual(["layout"]);
    expect(t.$("#layout-settings").getAttribute("aria-expanded")).toBe("true");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
  });

  it("has a slider for every setting, starting at its value", () => {
    setup();
    expect(document.querySelectorAll("#layout-panel input[type=range]").length).toBe(
      Object.keys(DEFAULT_SPACING).length,
    );
    expect(slider("lane").value).toBe(String(DEFAULT_SPACING.lane));
    expect(number("rowGap").value).toBe(String(DEFAULT_SPACING.rowGap));
  });

  it("applies a slider as it moves, and shows the change", () => {
    const t = setup();
    input(slider("columnGap"), 140);
    expect(spacing.columnGap).toBe(140);
    expect(number("columnGap").value).toBe("140");
    t.paint();
    expect(t.redraws).toBe(1);
    const row = slider("columnGap").closest(".spacing-field")!;
    expect(row.classList.contains("is-changed")).toBe(true);
    expect(menu().value).toBe("custom");
    // Its own reset button puts it back.
    (row.querySelector(".spacing-reset") as HTMLButtonElement).click();
    expect(spacing.columnGap).toBe(DEFAULT_SPACING.columnGap);
    expect(row.classList.contains("is-changed")).toBe(false);
    expect(menu().value).toBe("default");
  });

  it("takes typed values only once they're in range, and clamps on leaving the box", () => {
    setup();
    const box = number("lane");
    input(box, 1); // on the way to 12: too small, so nothing happens yet
    expect(spacing.lane).toBe(DEFAULT_SPACING.lane);
    input(box, 12);
    expect(spacing.lane).toBe(12);
    input(box, 500, "change");
    expect(spacing.lane).toBe(20);
  });

  it("saves a layout by name, lists it, and switches back and forth", () => {
    const t = setup();
    input(slider("rowGap"), 70);
    const name = t.$<HTMLInputElement>("#layout-panel input[type=text]");
    name.value = "Airy rows";
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(t.$("#layout-panel .style-status").textContent).toBe("Saved “Airy rows”.");
    expect([...menu().options].map((o) => o.textContent)).toEqual(["Default", "Airy rows"]);
    expect(menu().value).toBe("saved:Airy rows");

    menu().value = "default";
    menu().dispatchEvent(new Event("change"));
    expect(spacing.rowGap).toBe(DEFAULT_SPACING.rowGap);
    expect(slider("rowGap").value).toBe(String(DEFAULT_SPACING.rowGap));

    menu().value = "saved:Airy rows";
    menu().dispatchEvent(new Event("change"));
    expect(spacing.rowGap).toBe(70);

    button("Delete").click();
    expect([...menu().options].map((o) => o.textContent)).toEqual(["Default", "Custom (not saved)"]);
    expect(spacing.rowGap).toBe(70);
  });

  it("says why it can't save without a name", () => {
    const t = setup();
    button("Save").click();
    const status = t.$("#layout-panel .style-status");
    expect(status.textContent).toMatch(/name/);
    expect(status.classList.contains("is-warning")).toBe(true);
  });

  it("resets a section, or everything", () => {
    setup();
    input(slider("lane"), 15);
    input(slider("rowGap"), 80);
    const arrows = document.querySelector('#layout-panel [data-group="arrows"]')!;
    [...arrows.querySelectorAll("button")].find((b) => b.textContent === "Reset section")!.click();
    expect(spacing.lane).toBe(DEFAULT_SPACING.lane);
    expect(spacing.rowGap).toBe(80);
    button("Reset all").click();
    expect(spacing.rowGap).toBe(DEFAULT_SPACING.rowGap);
  });
});
