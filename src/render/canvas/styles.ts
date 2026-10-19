/**
 * The diagram's look, read from the real CSS (styles.css and the Style
 * panel's variables), for the canvas renderer.
 *
 * The SVG drawings are styled entirely by class. Rather than restate those
 * rules in code, the canvas renderer asks the browser: for each distinct
 * chain of tags and classes in a drawing (svg.memory-svg > g.node > rect,
 * ...) it builds the same chain in a small hidden <svg> in the window and
 * reads getComputedStyle from its last element. The diagram CSS only uses
 * class, descendant and child selectors, so the copy matches exactly the
 * rules the real element would. Results are kept per chain, so a step
 * costs a lookup per element, and they're dropped when the look changes.
 */

import { type DrawingNode, Mark } from "../drawing";

const NS = "http://www.w3.org/2000/svg";

/** The computed values the canvas needs, from one element. */
export interface ComputedPaint {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  dash: number[];
  dashOffset: number;
  opacity: number;
  /** null: "auto", use the element's own rx attribute. */
  rx: number | null;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  letterSpacing: number;
  textAnchor: string;
  baseline: string;
  whiteSpace: string;
  hidden: boolean;
  paintOrder: string;
  cap: string;
  join: string;
}

/** Something that can say how each element of a drawing is styled. */
export interface StyleSource {
  /**
   * Every element of `root` (and root itself), with its style. `skip`, if
   * the source can say what decides an element's style (the chain of tags,
   * classes and attributes above it): asked for each element with that
   * context, and true leaves out everything inside the element (the canvas
   * renderer already knows how it paints, see PaintCache).
   */
  read(root: DrawingNode, skip?: (el: DrawingNode, context: number) => boolean): Map<DrawingNode, ComputedPaint>;
  /** A CSS custom property's value on the drawing ("" when unset), e.g. --flash. */
  variable(name: string): string;
}

/** A StyleSource that keeps what it reads, in a probe in the page (ProbeStyles). */
export interface StyleProbe extends StyleSource {
  /** Forget everything read: the look changed. */
  clear(): void;
  /** Take the probe out of the page. */
  dispose(): void;
}

/**
 * Attributes that style an element directly. They're copied onto the probe
 * so the cascade sees them (a CSS rule still beats them, as in SVG).
 */
const PRESENTATION = [
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "font-size",
  "font-weight",
  "font-family",
  "text-anchor",
  "dominant-baseline",
  "visibility",
  "display",
] as const;

const px = (text: string, fallback = 0) => {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : fallback;
};

/** "3px, 3px" or "3 3" as numbers; [] for none. */
export function parseDash(text: string): number[] {
  if (!text || text === "none") return [];
  const parts = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number.parseFloat);
  return parts.every((n) => Number.isFinite(n) && n >= 0) && parts.some((n) => n > 0) ? parts : [];
}

/** Read the paint-related properties of a computed style. */
export function fromComputed(style: CSSStyleDeclaration): ComputedPaint {
  const get = (name: string) => style.getPropertyValue(name).trim();
  const rx = get("rx");
  const spacing = get("letter-spacing");
  return {
    fill: get("fill"),
    fillOpacity: px(get("fill-opacity"), 1),
    stroke: get("stroke"),
    strokeOpacity: px(get("stroke-opacity"), 1),
    strokeWidth: px(get("stroke-width"), 1),
    dash: parseDash(get("stroke-dasharray")),
    dashOffset: px(get("stroke-dashoffset")),
    opacity: px(get("opacity"), 1),
    rx: rx && rx !== "auto" ? px(rx) : null,
    fontFamily: get("font-family"),
    fontSize: px(get("font-size"), 13),
    fontWeight: get("font-weight") || "400",
    fontStyle: get("font-style") || "normal",
    letterSpacing: spacing === "normal" ? 0 : px(spacing),
    textAnchor: get("text-anchor") || "start",
    baseline: get("dominant-baseline") || "auto",
    whiteSpace: get("white-space") || "normal",
    hidden: get("display") === "none" || get("visibility") === "hidden",
    paintOrder: get("paint-order") || "normal",
    cap: get("stroke-linecap") || "butt",
    join: get("stroke-linejoin") || "miter",
  };
}

const IS_PRESENTATION = new Set<string>(PRESENTATION);

/** One step's part of an element's key: its tag, classes and presentation attributes. */
function ownKey(el: DrawingNode): string {
  let key = `${el.localName}.${el.getAttribute("class") ?? ""}`;
  // A mark's attributes, read in place.
  if (el instanceof Mark) {
    for (const [name, value] of el.attributeEntries()) if (IS_PRESENTATION.has(name)) key += `|${name}=${value}`;
    return key;
  }
  // Through the element's few attributes, not a lookup for every possible one.
  const attributes = el.attributes;
  for (let i = 0; i < attributes.length; i++) {
    const a = attributes[i];
    if (IS_PRESENTATION.has(a.name)) key += `|${a.name}=${a.value}`;
  }
  return key;
}

/** Elements that are never drawn (tooltips), so need no style. */
const SKIP = new Set(["title", "desc", "metadata", "style", "script"]);

/** Styles from the browser's CSS, through a hidden probe in the window. */
export class ProbeStyles implements StyleProbe {
  private readonly container: SVGSVGElement;
  private rootProbe: Element | null = null;

  constructor(host: Element) {
    this.container = document.createElementNS(NS, "svg");
    this.container.setAttribute("class", "canvas-probe");
    this.container.setAttribute("aria-hidden", "true");
    this.container.setAttribute("width", "0");
    this.container.setAttribute("height", "0");
    host.append(this.container);
  }

  /** The look changed (Style panel): read everything afresh. */
  clear(): void {
    this.chains = new Map();
    this.probes = [];
    this.computed = [];
    this.rootProbe = null;
    this.container.replaceChildren();
  }

  /** How many distinct chains are cached (for tests and tuning). */
  get size(): number {
    return this.probes.length;
  }

  /**
   * Each chain gets a number: "<parent's number>>tag.classes|attributes".
   * Keys stay short however deep the drawing goes.
   */
  private chains = new Map<string, number>();
  /** By chain number: its probe element, and what was read from it. */
  private probes: Element[] = [];
  private computed: ComputedPaint[] = [];

  read(root: DrawingNode, skip?: (el: DrawingNode, context: number) => boolean): Map<DrawingNode, ComputedPaint> {
    const ids = new Map<DrawingNode, number>();
    const fresh: number[] = [];
    // First build every chain not seen before, then read them all, so the
    // browser works out styles once rather than once per new chain.
    const visit = (el: DrawingNode, parent: number, parentProbe: Element) => {
      if (SKIP.has(el.localName)) return;
      const key = `${parent}>${ownKey(el)}`;
      let id = this.chains.get(key);
      let probe: Element;
      if (id === undefined) {
        probe = document.createElementNS(NS, el.localName);
        const cls = el.getAttribute("class");
        if (cls) probe.setAttribute("class", cls);
        for (const name of PRESENTATION) {
          const value = el.getAttribute(name);
          if (value !== null) probe.setAttribute(name, value);
        }
        parentProbe.append(probe);
        id = this.probes.length;
        this.chains.set(key, id);
        this.probes.push(probe);
        fresh.push(id);
      } else probe = this.probes[id];
      ids.set(el, id);
      if (skip?.(el, id)) return;
      for (const child of el.children) visit(child, id, probe);
    };
    visit(root, -1, this.container);
    this.rootProbe = this.probes[ids.get(root)!] ?? null;
    for (const id of fresh) this.computed[id] = fromComputed(getComputedStyle(this.probes[id]));
    const out = new Map<DrawingNode, ComputedPaint>();
    for (const [el, id] of ids) out.set(el, this.computed[id]);
    return out;
  }

  variable(name: string): string {
    const at = this.rootProbe ?? this.container;
    return getComputedStyle(at).getPropertyValue(name).trim();
  }

  dispose(): void {
    this.container.remove();
  }
}
