// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAINT, fakeStyles, svgOf } from "../testing/canvasStyles";
import { download, standaloneSvg, styleFor } from "./export";

afterEach(() => vi.restoreAllMocks());

describe("styleFor", () => {
  it("writes shapes' paint as hex with opacities", () => {
    expect(
      styleFor("rect", {
        ...DEFAULT_PAINT,
        fill: "rgba(255, 0, 0, 0.5)",
        stroke: "color(srgb 0 0 1)",
        strokeWidth: 1.5,
        dash: [3, 3],
        dashOffset: 1,
        cap: "round",
        join: "bevel",
        rx: 3,
        opacity: 0.28,
      }),
    ).toBe(
      "opacity:0.28;fill:#ff0000;fill-opacity:0.5;stroke:#0000ff;stroke-width:1.5;stroke-dasharray:3 3;stroke-dashoffset:1;stroke-linecap:round;stroke-linejoin:bevel;rx:3px",
    );
    expect(styleFor("path", { ...DEFAULT_PAINT, fill: "none" })).toBe("fill:none;stroke:none");
  });

  it("writes text's font, and only what differs from the defaults", () => {
    expect(styleFor("text", { ...DEFAULT_PAINT, fontFamily: "monospace", fontSize: 13 })).toBe(
      "fill:#000000;stroke:none;font-family:monospace;font-size:13px",
    );
    expect(
      styleFor("tspan", {
        ...DEFAULT_PAINT,
        fontWeight: "700",
        fontStyle: "italic",
        letterSpacing: 0.13,
        whiteSpace: "pre",
        paintOrder: "stroke",
      }),
    ).toContain("font-weight:700;font-style:italic;letter-spacing:0.13px;white-space:pre;paint-order:stroke");
  });

  it("writes groups' opacity only, and hides what's hidden", () => {
    expect(styleFor("g", { ...DEFAULT_PAINT, opacity: 0.5 })).toBe("opacity:0.5");
    expect(styleFor("g", DEFAULT_PAINT)).toBe("");
    expect(styleFor("rect", { ...DEFAULT_PAINT, hidden: true })).toBe("display:none");
  });
});

describe("standaloneSvg", () => {
  it("inlines every element's style, drops the app's data attributes, and adds the paper", () => {
    const svg = svgOf(
      `<defs><marker id="m"><path d="M0,0"/></marker></defs><g class="node" data-flip="a" data-x="1"><rect class="r" width="5" height="5"/></g>`,
    );
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("aria-hidden", "true");
    const out = standaloneSvg(
      svg,
      fakeStyles((el) => (el.classList.contains("r") ? { fill: "rgb(255, 255, 0)" } : {})),
      "rgb(240, 240, 240)",
    );
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg')).toBe(true);
    const doc = new DOMParser().parseFromString(out, "image/svg+xml");
    const root = doc.documentElement;
    expect(root.localName).toBe("svg");
    expect(root.getAttribute("viewBox")).toBe("0 0 200 100");
    expect(root.hasAttribute("aria-hidden")).toBe(false);
    expect(out).not.toContain("data-");
    expect(root.querySelector("rect.r")!.getAttribute("style")).toBe("fill:#ffff00;stroke:none");
    // The paper goes behind everything, after the arrowhead definitions.
    const paper = root.children[1];
    expect(paper.getAttribute("width")).toBe("100%");
    expect(paper.getAttribute("style")).toBe("fill:#f0f0f0");
    // The original isn't touched.
    expect(svg.querySelector("[data-flip]")).not.toBeNull();
  });

  it("leaves out the paper when there's no color, and keeps an existing viewBox", () => {
    const svg = svgOf(`<rect width="5" height="5"/>`);
    svg.setAttribute("viewBox", "0 0 50 50");
    const out = standaloneSvg(svg, fakeStyles(), "transparent");
    const root = new DOMParser().parseFromString(out, "image/svg+xml").documentElement;
    expect(root.getAttribute("viewBox")).toBe("0 0 50 50");
    expect(root.querySelectorAll("rect")).toHaveLength(1);
    const plain = svgOf(`<rect width="5" height="5"/>`);
    plain.removeAttribute("width");
    const noSize = new DOMParser().parseFromString(standaloneSvg(plain, fakeStyles()), "image/svg+xml").documentElement;
    expect(noSize.hasAttribute("viewBox")).toBe(false);
    // No <defs>: the paper is first.
    const papered = new DOMParser().parseFromString(
      standaloneSvg(svgOf(`<rect/>`), fakeStyles(), "#ffffff"),
      "image/svg+xml",
    );
    expect(papered.documentElement.children[0].getAttribute("width")).toBe("100%");
  });
});

describe("download", () => {
  it("hands the browser a file", () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    vi.useFakeTimers();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe("picture.svg");
      expect(this.href).toBe("blob:x");
    });
    download("picture.svg", "<svg/>");
    expect(clicked).toHaveBeenCalledOnce();
    expect(document.querySelector("a")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
    vi.useRealTimers();
  });
});
