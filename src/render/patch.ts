/**
 * Redrawing SVG by changing only what changed.
 *
 * Each step lays out a new drawing (drawing.ts). Rather than make all of it
 * into new SVG elements and throw the old ones away, an SvgPatcher compares
 * it with the drawing on screen and changes the SVG where they differ: an
 * attribute's value, a text, children added, removed or moved. Most of a
 * step's drawing is the same as the last one's, so most elements are left
 * alone: the browser has far less to build, style, lay out and paint.
 *
 * The SVG it leaves is always exactly what toSvg(drawing) would make, down
 * to the order of attributes, so CSS, Save SVG and the tests see no
 * difference (patch.test.ts checks this for every step of the examples).
 *
 * Children are matched by key where they have one (data-node-key, data-flip,
 * data-cell: boxes, linked nodes, cells), otherwise by position among
 * siblings of the same tag. Elements whose CSS animation plays when they
 * appear (a changed cell's flash, the printed-output card) are made afresh,
 * so it plays each step as it did when every element was new.
 */
import { Mark, type TextMark } from "./drawing";

const SVG_NS = "http://www.w3.org/2000/svg";

type Drawn = Mark | TextMark;

const hasClass = (m: Mark, name: string) => ` ${m.getAttribute("class") ?? ""} `.includes(` ${name} `);

/** Is this mark's CSS animation one that plays when the element appears (styles.css)? */
function playsOnArrival(m: Mark): boolean {
  if (m.localName !== "g") return false;
  return (hasClass(m, "cell") && hasClass(m, "is-changed")) || (hasClass(m, "node") && hasClass(m, "is-output"));
}

/** How a child is matched with the one drawn before it. */
function baseKey(node: Drawn): string {
  if (!(node instanceof Mark)) return "#text";
  const key = node.getAttribute("data-node-key") ?? node.getAttribute("data-flip") ?? node.getAttribute("data-cell");
  return key === null ? node.localName : `${node.localName}=${key}`;
}

/** Keys for a list of children: the base key, and which one of those it is. */
function keysOf(nodes: Drawn[]): string[] {
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const base = baseKey(node);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

function sameAttributes(a: Mark, b: Mark): boolean {
  if (a.attributeCount !== b.attributeCount) return false;
  const bs = b.attributeEntries();
  for (const [name, value] of a.attributeEntries()) {
    const next = bs.next().value as [string, string];
    if (next[0] !== name || next[1] !== value) return false;
  }
  return true;
}

/** Statistics of the last patch (for tests and tuning). */
export interface PatchStats {
  /** Elements and texts made new. */
  created: number;
  /** Elements whose attributes were changed. */
  updated: number;
  /** Elements and texts left in place, or moved. */
  kept: number;
}

/** Keeps one SVG in step with a drawing that changes. */
export class SvgPatcher {
  private drawing: Mark | null = null;
  private svg: SVGSVGElement | null = null;
  /** The element or text node each mark of the drawing on screen is. */
  private nodes = new WeakMap<Drawn, Node>();
  stats: PatchStats = { created: 0, updated: 0, kept: 0 };

  constructor(private readonly doc: Document = document) {}

  /** The SVG on screen. */
  get element(): SVGSVGElement | null {
    return this.svg;
  }

  /** The drawing on screen. */
  get current(): Mark | null {
    return this.drawing;
  }

  /** Forget the SVG on screen: the next show() makes it all new. */
  reset(): void {
    this.drawing = null;
    this.svg = null;
    this.nodes = new WeakMap();
  }

  /** Make the SVG show `drawing`: the same element, changed, if there's one; a new one if not. */
  show(drawing: Mark): SVGSVGElement {
    this.stats = { created: 0, updated: 0, kept: 0 };
    const old = this.drawing;
    const el = old && this.svg ? this.patch(old, drawing, this.svg) : this.build(drawing);
    this.drawing = drawing;
    this.svg = el as SVGSVGElement;
    return this.svg;
  }

  /** A mark as a new element (as toSvg does), remembering which element each mark is. */
  private build(m: Mark): Element {
    const el = this.doc.createElementNS(SVG_NS, m.localName);
    this.setAttributes(el, m);
    for (const child of m.childNodes) el.appendChild(this.buildNode(child));
    this.nodes.set(m, el);
    this.stats.created++;
    return el;
  }

  private buildNode(node: Drawn): Node {
    if (node instanceof Mark) return this.build(node);
    const text = this.doc.createTextNode(node.textContent);
    this.nodes.set(node, text);
    this.stats.created++;
    return text;
  }

  private setAttributes(el: Element, m: Mark): void {
    for (const [name, value] of m.attributeEntries()) {
      if (name === "style" && m.styleProperties.length) {
        const style = (el as SVGElement).style;
        for (const [prop, v] of m.styleProperties) style.setProperty(prop, v);
      } else el.setAttribute(name, value);
    }
  }

  /** Change `el` (which shows `old`) to show `next`. Returns the element that now does: `el`, or a new one. */
  private patch(old: Mark, next: Mark, el: Element): Element {
    if (old.localName !== next.localName || playsOnArrival(next)) return this.build(next);
    this.nodes.set(next, el);
    if (!sameAttributes(old, next)) {
      this.updateAttributes(old, next, el);
      this.stats.updated++;
    } else this.stats.kept++;
    this.patchChildren(old, next, el);
    return el;
  }

  private updateAttributes(old: Mark, next: Mark, el: Element): void {
    // The same names in the same order: set the values that changed (each
    // keeps its place). Otherwise, or if the inline style changed, set them
    // all again in order, so the order is toSvg's.
    let inPlace = old.attributeCount === next.attributeCount;
    if (inPlace) {
      const was = old.attributeEntries();
      for (const [name, value] of next.attributeEntries()) {
        const [oldName, oldValue] = was.next().value as [string, string];
        if (oldName !== name || (name === "style" && oldValue !== value)) {
          inPlace = false;
          break;
        }
      }
    }
    if (inPlace) {
      for (const [name, value] of next.attributeEntries())
        if (old.getAttribute(name) !== value) el.setAttribute(name, value);
      return;
    }
    while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
    this.setAttributes(el, next);
  }

  private patchChildren(old: Mark, next: Mark, el: Element): void {
    const before = old.childNodes;
    const after = next.childNodes;
    if (!before.length && !after.length) return;
    const oldKeys = keysOf(before);
    const newKeys = keysOf(after);
    // Nearly always: the same children in the same order.
    let same = before.length === after.length;
    for (let i = 0; same && i < oldKeys.length; i++) same = oldKeys[i] === newKeys[i];
    if (same) {
      for (let i = 0; i < after.length; i++) {
        const node = this.nodes.get(before[i])!;
        const now = this.patchNode(before[i], after[i], node);
        if (now !== node) el.replaceChild(now, node);
      }
      return;
    }
    const byKey = new Map<string, Drawn>();
    before.forEach((node, i) => {
      byKey.set(oldKeys[i], node);
    });
    const targets: Node[] = after.map((node, i) => {
      const was = byKey.get(newKeys[i]);
      if (was === undefined) return this.buildNode(node);
      byKey.delete(newKeys[i]);
      const oldNode = this.nodes.get(was)!;
      const now = this.patchNode(was, node, oldNode);
      if (now !== oldNode) el.removeChild(oldNode); // made afresh
      return now;
    });
    // What's left wasn't matched: it goes.
    for (const gone of byKey.values()) {
      const node = this.nodes.get(gone);
      if (node?.parentNode === el) el.removeChild(node);
    }
    // Then everything in order, moving only what's out of place.
    let cursor = el.firstChild;
    for (const target of targets) {
      if (target === cursor) cursor = cursor.nextSibling;
      else el.insertBefore(target, cursor);
    }
  }

  private patchNode(old: Drawn, next: Drawn, node: Node): Node {
    if (next instanceof Mark) {
      if (!(old instanceof Mark)) return this.build(next);
      return this.patch(old, next, node as Element);
    }
    if (old instanceof Mark) return this.buildNode(next);
    this.nodes.set(next, node);
    if (node.textContent !== next.textContent) {
      node.textContent = next.textContent;
      this.stats.updated++;
    } else this.stats.kept++;
    return node;
  }
}
