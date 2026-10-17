// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Banner } from "./banner";

describe("Banner", () => {
  it("shows a message, and hides with null", () => {
    document.body.innerHTML = `<div id="banner" hidden></div>`;
    const el = document.getElementById("banner")!;
    const banner = new Banner(el, {});
    banner.show("<strong>Error</strong> on line 2");
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe("Error on line 2");
    banner.show(null);
    expect(el.hidden).toBe(true);
    expect(el.innerHTML).toBe("");
  });

  it("its buttons do what they say, and only that", () => {
    document.body.innerHTML = `<div id="banner"></div>`;
    const el = document.getElementById("banner")!;
    const run = vi.fn();
    const banner = new Banner(el, { run });
    banner.show(
      `Stopped. <button data-action="run"><span>Run</span></button> <button data-action="toString">?</button>`,
    );
    el.querySelector("span")!.click(); // inside the button
    el.querySelector<HTMLElement>('[data-action="toString"]')!.click(); // not one of its actions
    el.click(); // not a button
    expect(run).toHaveBeenCalledTimes(1);
  });
});
