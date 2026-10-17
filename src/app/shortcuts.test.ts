// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { handleShortcut, installShortcuts, type ShortcutActions } from "./shortcuts";

function setup() {
  document.body.innerHTML = `<div class="monaco-editor"><textarea id="code"></textarea></div><button id="b"></button>`;
  let dialogOpen = false;
  const actions = {
    run: vi.fn(),
    measure: vi.fn(),
    save: vi.fn(),
    saveAs: vi.fn(),
    dialogOpen: () => dialogOpen,
    step: vi.fn(() => true),
  } satisfies ShortcutActions;
  const press = (key: string, init: KeyboardEventInit = {}, target: HTMLElement = document.body) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: target });
    return { handled: handleShortcut(event, actions), prevented: event.defaultPrevented };
  };
  return {
    actions,
    press,
    openDialog: () => {
      dialogOpen = true;
    },
  };
}

describe("page shortcuts", () => {
  it("Ctrl + ' runs and Ctrl + Shift + ' measures", () => {
    const { actions, press } = setup();
    expect(press("'", { ctrlKey: true, code: "Quote" })).toEqual({ handled: true, prevented: true });
    press('"', { ctrlKey: true, shiftKey: true, code: "Quote" });
    expect(actions.run).toHaveBeenCalledTimes(1);
    expect(actions.measure).toHaveBeenCalledTimes(1);
  });

  it("Ctrl/Cmd + S saves instead of saving the page, and + Shift is Save as", () => {
    const { actions, press } = setup();
    expect(press("s", { metaKey: true }).prevented).toBe(true);
    press("S", { ctrlKey: true, shiftKey: true });
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(actions.saveAs).toHaveBeenCalledTimes(1);
  });

  it("leaves the editor's keys to the editor", () => {
    const { actions, press } = setup();
    const code = document.getElementById("code")!;
    expect(press("'", { ctrlKey: true }, code).handled).toBe(false);
    expect(press("ArrowRight", {}, code).handled).toBe(false);
    expect(actions.run).not.toHaveBeenCalled();
    expect(actions.step).not.toHaveBeenCalled();
  });

  it("passes the stepping keys on, except to an open save dialog", () => {
    const { actions, press, openDialog } = setup();
    expect(press("ArrowRight").handled).toBe(true);
    expect(press("Enter", { ctrlKey: true }).handled).toBe(true);
    expect(actions.step).toHaveBeenCalledTimes(2);
    openDialog();
    expect(press("ArrowRight").handled).toBe(false);
    expect(press("s", { ctrlKey: true }).handled).toBe(true); // still never the browser's Save page...
    expect(actions.save).not.toHaveBeenCalled(); // ...but the dialog is already saving
    expect(actions.step).toHaveBeenCalledTimes(2);
  });

  it("listens on the whole page", () => {
    const { actions } = setup();
    installShortcuts(actions);
    document
      .getElementById("b")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "'", ctrlKey: true, bubbles: true }));
    expect(actions.run).toHaveBeenCalledTimes(1);
  });
});
