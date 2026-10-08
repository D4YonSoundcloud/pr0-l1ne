// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshot, transition } from "./animate";

interface Call { target: Element; keyframes: Keyframe[] }
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  // jsdom has no Web Animations; record what would be animated.
  (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: Keyframe[]) {
    calls.push({ target: this, keyframes });
    return {} as Animation;
  };
});
afterEach(() => {
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
});

function svg(markup: string): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`;
  return host.querySelector("svg")!;
}

const slides = () => calls.filter((c) => String(c.keyframes[0].transform ?? "").startsWith("translate"));

describe("transition", () => {
  it("slides a box from where it was", () => {
    const before = snapshot(svg(`<g data-flip="obj:o1" data-x="40" data-y="10"></g>`));
    const after = svg(`<g data-flip="obj:o1" data-x="100" data-y="70"></g>`);
    transition(before, after, 200);
    expect(slides()).toHaveLength(1);
    expect(slides()[0].keyframes[0].transform).toBe("translate(-60px, -60px)");
  });

  it("leaves things that didn't move alone, and fades new ones in", () => {
    const before = snapshot(svg(`<g data-flip="a" data-x="0" data-y="0"></g>`));
    const after = svg(`<g data-flip="a" data-x="0" data-y="0"></g><g data-flip="b" data-x="5" data-y="5"></g>`);
    transition(before, after, 200);
    expect(slides()).toHaveLength(0);
    const fades = calls.filter((c) => "opacity" in c.keyframes[0]);
    expect(fades.map((c) => c.target.getAttribute("data-flip"))).toEqual(["b"]);
  });

  it("slides swapped values between cells of the same list", () => {
    const cell = (slot: number, value: string, x: number) =>
      `<g data-cell="o1|${slot}" data-value="${value}" data-cx="${x}" data-cy="0"></g>`;
    const before = snapshot(svg(cell(0, "p:int:5", 0) + cell(1, "p:int:2", 34) + cell(2, "p:int:9", 68)));
    const after = svg(cell(0, "p:int:2", 0) + cell(1, "p:int:5", 34) + cell(2, "p:int:9", 68));
    transition(before, after, 200);
    const moved = slides().map((c) => [c.target.getAttribute("data-cell"), c.keyframes[0].transform]);
    expect(moved).toEqual([["o1|0", "translate(34px, 0px)"], ["o1|1", "translate(-34px, 0px)"]]);
  });

  it("doesn't slide values between different lists", () => {
    const before = snapshot(svg(`<g data-cell="o1|0" data-value="v" data-cx="0" data-cy="0"></g>`));
    const after = svg(`<g data-cell="o2|0" data-value="v" data-cx="0" data-cy="0"></g><g data-cell="o1|0" data-value="w" data-cx="0" data-cy="0"></g>`);
    transition(before, after, 200);
    expect(slides()).toHaveLength(0);
  });

  it("never animates arrows", () => {
    const arrows = `<path class="ref-arrow" d="M0,0 L9,9"></path><path class="link-arrow" d="M0,0 L9,9"></path><path class="change-arrow" d="M0,0 L9,9"></path>`;
    transition(snapshot(svg(`<path class="ref-arrow" d="M0,0 L1,1"></path>`)), svg(arrows), 200);
    expect(calls).toHaveLength(0);
  });

  it("does nothing without a previous drawing or a duration", () => {
    transition(null, svg(`<g data-flip="a" data-x="1" data-y="1"></g>`), 200);
    transition(snapshot(svg(`<g data-flip="a" data-x="0" data-y="0"></g>`)), svg(`<g data-flip="a" data-x="9" data-y="9"></g>`), 0);
    expect(calls).toHaveLength(0);
  });
});
