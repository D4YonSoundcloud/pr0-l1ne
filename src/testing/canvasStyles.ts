/**
 * Styles for canvas-renderer tests, without a browser: jsdom can't resolve
 * the app's CSS (variables, color-mix()), so tests say how each element is
 * styled with a small function instead of the probe (render/canvas/styles.ts).
 */
import type { ComputedPaint, StyleSource } from "../render/canvas/styles";

/** What an element gets when the rules say nothing: SVG's defaults. */
export const DEFAULT_PAINT: ComputedPaint = {
  fill: "rgb(0, 0, 0)",
  fillOpacity: 1,
  stroke: "none",
  strokeOpacity: 1,
  strokeWidth: 1,
  dash: [],
  dashOffset: 0,
  opacity: 1,
  rx: null,
  fontFamily: "monospace",
  fontSize: 13,
  fontWeight: "400",
  fontStyle: "normal",
  letterSpacing: 0,
  textAnchor: "start",
  baseline: "auto",
  whiteSpace: "normal",
  hidden: false,
  paintOrder: "normal",
  cap: "butt",
  join: "miter",
};

/**
 * A StyleSource from a rule per element. Text-anchor and dominant-baseline
 * come from attributes, as in the browser, unless the rule sets them.
 */
export function fakeStyles(
  rule: (el: Element) => Partial<ComputedPaint> = () => ({}),
  variables: Record<string, string> = {},
  options: { contexts?: boolean } = {},
): StyleSource & { reads: number; read: StyleSource["read"] } {
  // With `contexts`, it says what decides each element's style, as the probe
  // does: here, the tags, classes and presentation attributes from the root
  // down (all `rule` may look at, for the rules tests use).
  const contexts = new Map<string, number>();
  const contextOf = (el: Element) => {
    let key = "";
    for (let at: Element | null = el; at; at = at.parentElement) {
      key = `${at.localName}.${at.getAttribute("class") ?? ""}|${at.getAttribute("text-anchor") ?? ""}|${at.getAttribute("dominant-baseline") ?? ""}>${key}`;
    }
    let id = contexts.get(key);
    if (id === undefined) {
      id = contexts.size;
      contexts.set(key, id);
    }
    return id;
  };
  const source = {
    reads: 0,
    read(root: SVGSVGElement, skip?: (el: Element, context: number) => boolean) {
      source.reads++;
      const out = new Map<Element, ComputedPaint>();
      const all: Element[] = [];
      const walk = (el: Element) => {
        all.push(el);
        if (options.contexts && skip?.(el, contextOf(el))) return;
        for (const child of el.children) walk(child);
      };
      walk(root);
      for (const el of all) {
        const fromAttributes: Partial<ComputedPaint> = {};
        const anchor = el.closest("[text-anchor]")?.getAttribute("text-anchor");
        if (anchor) fromAttributes.textAnchor = anchor;
        const baseline = el.getAttribute("dominant-baseline");
        if (baseline) fromAttributes.baseline = baseline;
        out.set(el, { ...DEFAULT_PAINT, ...fromAttributes, ...rule(el) });
      }
      return out;
    },
    variable: (name: string) => variables[name] ?? "",
  };
  return source;
}

/** Parse SVG markup into a (detached) <svg> element. */
export function svgOf(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${markup}</svg>`,
    "image/svg+xml",
  );
  return document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
}
