// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { svgOf } from "../../testing/canvasStyles";
import { fromComputed, ProbeStyles, parseDash } from "./styles";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("parseDash", () => {
  it("reads dash arrays, and none", () => {
    expect(parseDash("3px, 3px")).toEqual([3, 3]);
    expect(parseDash("5 3")).toEqual([5, 3]);
    expect(parseDash("none")).toEqual([]);
    expect(parseDash("")).toEqual([]);
    expect(parseDash("0 0")).toEqual([]);
    expect(parseDash("a b")).toEqual([]);
  });
});

describe("fromComputed", () => {
  const style = (values: Record<string, string>) =>
    ({ getPropertyValue: (name: string) => values[name] ?? "" }) as CSSStyleDeclaration;

  it("reads what the canvas needs, with SVG's defaults for what's missing", () => {
    const paint = fromComputed(
      style({
        fill: "rgb(1, 2, 3)",
        "stroke-width": "1.5px",
        rx: "4px",
        "font-size": "12px",
        "letter-spacing": "0.5px",
        "text-anchor": "middle",
        display: "none",
      }),
    );
    expect(paint).toMatchObject({
      fill: "rgb(1, 2, 3)",
      strokeWidth: 1.5,
      rx: 4,
      fontSize: 12,
      letterSpacing: 0.5,
      textAnchor: "middle",
      hidden: true,
      fillOpacity: 1,
      opacity: 1,
      fontWeight: "400",
      baseline: "auto",
      cap: "butt",
      join: "miter",
    });
    const blank = fromComputed(style({ rx: "auto", "letter-spacing": "normal", visibility: "hidden" }));
    expect(blank.rx).toBeNull();
    expect(blank.letterSpacing).toBe(0);
    expect(blank.hidden).toBe(true);
    expect(blank.fontSize).toBe(13);
  });
});

describe("ProbeStyles", () => {
  it("reads each element's style from the page's CSS, by its chain of classes", () => {
    document.head.innerHTML = `<style>
      .memory-svg .node > rect { fill: rgb(255, 0, 0); stroke-width: 2px; }
      .memory-svg.has-output .node > rect { fill: rgb(0, 0, 255); }
      .cell rect { stroke: rgb(0, 128, 0); }
    </style>`;
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const styles = new ProbeStyles(host);
    expect(host.querySelector("svg.canvas-probe")).not.toBeNull();

    const svg = svgOf(`<g class="node"><rect/><g class="cell"><rect fill="rgb(9, 9, 9)"/></g></g><title>t</title>`);
    svg.setAttribute("class", "memory-svg");
    const read = styles.read(svg);
    const [nodeRect, cellRect] = svg.querySelectorAll("rect");
    expect(read.get(nodeRect)).toMatchObject({ fill: "rgb(255, 0, 0)", strokeWidth: 2 });
    expect(read.get(cellRect)).toMatchObject({ stroke: "rgb(0, 128, 0)" });
    // Presentation attributes are copied onto the probe, so the browser's cascade sees them
    // (jsdom doesn't apply them to computed styles; browsers do).
    expect(host.querySelector(".canvas-probe .cell > rect")!.getAttribute("fill")).toBe("rgb(9, 9, 9)");
    // Titles are never drawn: no style needed.
    expect(read.has(svg.querySelector("title")!)).toBe(false);
    const chains = styles.size;

    // The same drawing again: nothing new to read.
    styles.read(svg);
    expect(styles.size).toBe(chains);

    // The drawing's own classes are part of the chain.
    svg.setAttribute("class", "memory-svg has-output");
    expect(styles.read(svg).get(nodeRect)?.fill).toBe("rgb(0, 0, 255)");
    expect(styles.size).toBeGreaterThan(chains);
  });

  it("reads custom properties on the drawing, and starts afresh when cleared", () => {
    document.head.innerHTML = `<style>#host { --flash: mark 1s; } .loop-svg { --flash: none; }</style>`;
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const styles = new ProbeStyles(host);
    expect(styles.variable("--flash")).toBe("mark 1s"); // nothing read yet: the probe's own
    const svg = svgOf(`<rect/>`);
    svg.setAttribute("class", "loop-svg");
    styles.read(svg);
    expect(styles.variable("--flash")).toBe("none");
    styles.clear();
    expect(styles.size).toBe(0);
    expect(host.querySelector(".canvas-probe")!.children).toHaveLength(0);
    styles.dispose();
    expect(host.querySelector(".canvas-probe")).toBeNull();
  });
});

describe("ProbeStyles levels of detail", () => {
  const probes = (host: Element) => [...host.querySelectorAll(":scope > .canvas-probe")];

  it("keeps the probe it reads from in the page when the look changes after going back to a level", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const styles = new ProbeStyles(host);
    styles.setLevel(2);
    styles.setLevel(0); // back to a level it has a probe for
    styles.setLevel(2);
    styles.clear(); // the look changed (a window was resized, the Style panel...)
    // Exactly one probe, the current level's, in the page: read styles come from it.
    expect(probes(host).map((p) => p.getAttribute("class"))).toEqual(["canvas-probe lod-2"]);
    styles.setLevel(0);
    expect(probes(host).map((p) => p.getAttribute("class"))).toEqual(["canvas-probe lod-0"]);
    styles.setLevel(2);
    expect(probes(host)).toHaveLength(1);
    styles.dispose();
    expect(probes(host)).toHaveLength(0);
    host.remove();
  });

  it("never has more than one probe in the page, however the levels change", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const styles = new ProbeStyles(host);
    for (const lod of [1, 2, 3, 2, 1, 0, 4, 0, 3, 3, 1]) {
      styles.setLevel(lod);
      if (lod === 0) styles.clear();
      expect(probes(host)).toHaveLength(1);
      expect(probes(host)[0].getAttribute("class")).toBe(`canvas-probe lod-${lod}`);
    }
    styles.dispose();
    host.remove();
  });
});
