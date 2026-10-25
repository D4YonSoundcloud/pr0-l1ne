// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { scrollableTools } from "./sectionTools";

function row(scrollWidth: number, clientWidth: number) {
  document.body.innerHTML = `<div class="section-tools"></div>`;
  const el = document.querySelector<HTMLElement>(".section-tools")!;
  Object.defineProperty(el, "scrollWidth", { value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { value: clientWidth });
  return el;
}

describe("scrollableTools", () => {
  it("fades the side with more to see", () => {
    const el = row(500, 200);
    const update = scrollableTools(el);
    expect(el.classList.contains("more-right")).toBe(true);
    expect(el.classList.contains("more-left")).toBe(false);
    el.scrollLeft = 300;
    update();
    expect(el.classList.contains("more-left")).toBe(true);
    expect(el.classList.contains("more-right")).toBe(false);
  });

  it("scrolls sideways with an up-and-down wheel, only when there's more", () => {
    const el = row(500, 200);
    scrollableTools(el);
    const wheel = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    el.dispatchEvent(wheel);
    expect(el.scrollLeft).toBe(40);
    expect(wheel.defaultPrevented).toBe(true);
    const fits = row(200, 200);
    scrollableTools(fits);
    const other = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    fits.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});
