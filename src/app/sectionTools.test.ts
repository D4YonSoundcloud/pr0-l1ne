// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { toolsMenu } from "./sectionTools";

/**
 * A header with five tools 100 pixels wide. jsdom has no layout, so the
 * row's widths are worked out from the tools still on it and its own width.
 */
function header(width: number) {
  document.body.innerHTML = `
    <section id="win"><div class="section-head">
      <div class="section-tools" id="tools">
        <button id="a">A</button><button id="b">B</button><span id="c">C</span><button id="d">D</button><label id="e"><input type="checkbox"> E</label>
      </div>
    </div></section>`;
  const row = document.getElementById("tools")!;
  let room = width;
  Object.defineProperty(row, "clientWidth", { get: () => room });
  Object.defineProperty(row, "scrollWidth", {
    get: () => [...row.children].filter((c) => !(c as HTMLElement).hidden).length * 100,
  });
  const menu = toolsMenu(row, "More tools");
  return {
    row,
    menu,
    resize(next: number) {
      room = next;
      menu.arrange();
    },
    onRow: () => [...row.children].map((c) => c.id),
    inMenu: () => [...menu.menu.children].map((c) => c.id),
  };
}

describe("toolsMenu", () => {
  it("leaves everything on the row when it fits, with no ⋯ button", () => {
    const h = header(600);
    expect(h.onRow()).toEqual(["a", "b", "c", "d", "e"]);
    expect(h.menu.button.hidden).toBe(true);
  });

  it("moves what doesn't fit into the menu, from the end, keeping its order", () => {
    const h = header(320);
    expect(h.onRow()).toEqual(["a", "b", "c"]);
    expect(h.inMenu()).toEqual(["d", "e"]);
    expect(h.menu.button.hidden).toBe(false);
    // Wider again: they come back.
    h.resize(450);
    expect(h.onRow()).toEqual(["a", "b", "c", "d"]);
    h.resize(1000);
    expect(h.inMenu()).toEqual([]);
    expect(h.menu.button.hidden).toBe(true);
  });

  it("moves the tools themselves, so they keep their listeners", () => {
    const h = header(250);
    let clicks = 0;
    document.getElementById("d")!.addEventListener("click", () => clicks++);
    expect(h.inMenu()).toContain("d");
    document.getElementById("d")!.click();
    expect(clicks).toBe(1);
  });

  it("opens under the header and closes from outside, with Escape, or when everything fits again", () => {
    const h = header(250);
    const { button, menu } = h.menu;
    expect(menu.hidden).toBe(true);
    button.click();
    expect(menu.hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Using a tool in it leaves it open.
    menu.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu.hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu.hidden).toBe(true);
    button.click();
    menu.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    button.click();
    h.resize(1000);
    expect(menu.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("needs no ⋯ button when only hidden tools are left over", () => {
    const h = header(450);
    document.getElementById("e")!.hidden = true;
    h.menu.arrange();
    expect(h.menu.button.hidden).toBe(true);
    expect(h.inMenu()).toEqual([]);
  });

  it("says what it is to screen readers", () => {
    const { button, menu } = header(250).menu;
    expect(button.getAttribute("aria-label")).toBe("More tools");
    expect(button.getAttribute("aria-controls")).toBe(menu.id);
    expect(menu.getAttribute("role")).toBe("group");
  });
});
