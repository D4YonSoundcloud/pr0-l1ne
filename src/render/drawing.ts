/**
 * The drawing model: what the memory view and loop history lay out, before
 * any renderer draws it.
 *
 * The layout code (memory.ts, loopView.ts, graphView.ts, draw.ts) builds a
 * tree of marks: the SVG elements it means, as plain objects. A renderer then
 * takes the tree its own way. The SVG renderer turns it into real SVG
 * (toSvg), exactly as if the layout had built the elements itself; the
 * canvas renderer paints straight from it (canvas/paint.ts), never making a
 * DOM element. Building plain objects is much cheaper than building DOM
 * elements, and a tree that's just data can later be compared with the one
 * drawn before, to redraw only what changed.
 *
 * Marks have the small part of the DOM's API the layout code uses (append,
 * setAttribute, classList, style.setProperty, querySelector for simple
 * selectors), with the same behavior, so toSvg's output is byte for byte what
 * building the elements directly gave.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** A run of text in a mark (a DOM text node). */
export class TextMark {
  readonly nodeType = 3;
  parentElement: Mark | null = null;
  constructor(public textContent: string) {}
}

type Child = Mark | string | null | undefined | false;

/** Classes on a mark, like an element's classList. */
class MarkClasses {
  constructor(private readonly mark: Mark) {}

  private get tokens(): string[] {
    const value = this.mark.getAttribute("class");
    return value ? [...new Set(value.split(/[\t\n\f\r ]+/).filter(Boolean))] : [];
  }

  private set(tokens: string[]): void {
    this.mark.setAttribute("class", tokens.join(" "));
  }

  contains(name: string): boolean {
    return this.tokens.includes(name);
  }

  add(...names: string[]): void {
    const tokens = this.tokens;
    for (const name of names) if (!tokens.includes(name)) tokens.push(name);
    this.set(tokens);
  }

  remove(...names: string[]): void {
    // As in the DOM, removing from an element with no class attribute adds nothing.
    if (!this.mark.hasAttribute("class")) return;
    this.set(this.tokens.filter((t) => !names.includes(t)));
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

/** One element of a drawing: an SVG element, as data. */
export class Mark {
  readonly nodeType = 1;
  parentElement: Mark | null = null;
  readonly childNodes: (Mark | TextMark)[] = [];
  private readonly attrs = new Map<string, string>();
  /** Properties set with style.setProperty, in order (toSvg sets them the same way). */
  private styleProps: [string, string][] | null = null;
  private classes: MarkClasses | null = null;

  constructor(readonly localName: string) {}

  // -- attributes ---------------------------------------------------------------

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  /** Like the DOM: an attribute already set keeps its place; a new one goes last. */
  setAttribute(name: string, value: string | number): void {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === "style") this.styleProps = null;
  }

  /** Every attribute, in order. */
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }

  /** How many attributes it has. */
  get attributeCount(): number {
    return this.attrs.size;
  }

  /** The attributes as [name, value] pairs, without copying (for toSvg and the style probe). */
  attributeEntries(): IterableIterator<[string, string]> {
    return this.attrs.entries();
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  get classList(): MarkClasses {
    this.classes ??= new MarkClasses(this);
    return this.classes;
  }

  /** Custom properties and other inline styles, as element.style.setProperty. */
  get style(): { setProperty(name: string, value: string): void } {
    return {
      setProperty: (name, value) => {
        this.styleProps ??= [];
        const at = this.styleProps.findIndex(([n]) => n === name);
        if (at >= 0) this.styleProps[at][1] = value;
        else this.styleProps.push([name, value]);
        // The style attribute appears where the DOM would put it: last, on the first property.
        this.attrs.set("style", this.styleProps.map(([n, v]) => `${n}: ${v};`).join(" "));
      },
    };
  }

  /** The inline style properties, in order (for toSvg). */
  get styleProperties(): readonly [string, string][] {
    return this.styleProps ?? [];
  }

  // -- the tree -----------------------------------------------------------------

  /** Child marks (not text), like element.children. */
  get children(): Mark[] {
    return this.childNodes.filter((c): c is Mark => c instanceof Mark);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  private adopt(child: Mark | string): Mark | TextMark {
    const node = typeof child === "string" ? new TextMark(child) : child;
    // A mark already in a tree moves, as appending a DOM element does.
    if (node instanceof Mark) node.remove();
    node.parentElement = this;
    return node;
  }

  /** Add children at the end; strings become text. Falsy children are skipped (as s() does). */
  append(...children: Child[]): void {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      this.childNodes.push(this.adopt(child));
    }
  }

  prepend(...children: Child[]): void {
    const nodes = children
      .filter((c): c is Mark | string => c !== null && c !== undefined && c !== false)
      .map((c) => this.adopt(c));
    this.childNodes.unshift(...nodes);
  }

  /** Insert before this mark in its parent. */
  before(...children: Child[]): void {
    const parent = this.parentElement;
    if (!parent) return;
    const nodes = children
      .filter((c): c is Mark | string => c !== null && c !== undefined && c !== false)
      .map((c) => parent.adopt(c));
    parent.childNodes.splice(parent.childNodes.indexOf(this), 0, ...nodes);
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const at = parent.childNodes.indexOf(this);
    if (at >= 0) parent.childNodes.splice(at, 1);
    this.parentElement = null;
  }

  // -- finding marks ------------------------------------------------------------

  /** Does this mark match a simple selector (see parseSelector)? */
  matches(selector: string): boolean {
    return parseSelector(selector).some((compound) => matchesCompound(this, compound));
  }

  /** This mark or the nearest one above it that matches. */
  closest(selector: string): Mark | null {
    for (let m: Mark | null = this; m; m = m.parentElement) if (m.matches(selector)) return m;
    return null;
  }

  querySelector(selector: string): Mark | null {
    return find(this, parseSelector(selector), true)[0] ?? null;
  }

  querySelectorAll(selector: string): Mark[] {
    return find(this, parseSelector(selector), false);
  }
}

/** The marks under `root` that match, in document order; `first`: stop at the first. */
function find(root: Mark, compounds: Compound[], first: boolean): Mark[] {
  const out: Mark[] = [];
  // A stack of children lists still to go through, walked by hand: a
  // recursive generator costs a step per level for every mark it yields.
  const lists: (Mark | TextMark)[][] = [root.childNodes];
  const at: number[] = [0];
  while (lists.length) {
    const top = lists.length - 1;
    const list = lists[top];
    const i = at[top]++;
    if (i >= list.length) {
      lists.pop();
      at.pop();
      continue;
    }
    const node = list[i];
    if (!(node instanceof Mark)) continue;
    for (const c of compounds) {
      if (matchesCompound(node, c)) {
        out.push(node);
        if (first) return out;
        break;
      }
    }
    if (node.childNodes.length) {
      lists.push(node.childNodes);
      at.push(0);
    }
  }
  return out;
}

/** Every mark under `root`, in document order (not root itself). */
export function descendants(root: Mark): Mark[] {
  return find(root, [{ tag: null, classes: [], id: null, attrs: [] }], false);
}

/** Make a mark: mark("rect", { x: 0, class: "cell" }, ...children). Attributes that are null, undefined or false are left out. */
export function mark(
  tag: string,
  attrs: Record<string, string | number | null | undefined | false> = {},
  ...children: Child[]
): Mark {
  const m = new Mark(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    m.setAttribute(name, value);
  }
  m.append(...children);
  return m;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * One compound selector: an optional tag, classes, an id, and attributes
 * (present, or equal to a value). Enough for what the renderers look up:
 * `.node[data-node-key="obj:o4"]`, `.is-focus, .is-related`, `[data-flip]`,
 * `marker[id]`. Combinators (descendant, child...) aren't supported.
 */
interface Compound {
  tag: string | null;
  classes: string[];
  id: string | null;
  attrs: { name: string; value: string | null }[];
}

const cache = new Map<string, Compound[]>();

/** Undo CSS escapes (as CSS.escape writes them): `obj\:o4`, `\31 2`. */
function cssUnescape(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6} ?|[\s\S])/g, (_, esc: string) =>
    /^[0-9a-fA-F]/.test(esc) && /^[0-9a-fA-F]{1,6} ?$/.test(esc)
      ? String.fromCodePoint(Number.parseInt(esc.trim(), 16))
      : esc,
  );
}

const IDENT = String.raw`(?:\\[0-9a-fA-F]{1,6} ?|\\[\s\S]|[\w-])+`;
const PART = new RegExp(
  String.raw`^(?:(\*|${IDENT})|\.(${IDENT})|#(${IDENT})|\[\s*(${IDENT})\s*(?:=\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|(${IDENT})))?\s*\])`,
);

export function parseSelector(selector: string): Compound[] {
  const cached = cache.get(selector);
  if (cached) return cached;
  const compounds: Compound[] = [];
  for (const raw of splitList(selector)) {
    let rest = raw.trim();
    if (!rest) throw new SyntaxError(`Empty selector in "${selector}"`);
    const c: Compound = { tag: null, classes: [], id: null, attrs: [] };
    let first = true;
    while (rest) {
      const m = PART.exec(rest);
      if (!m || (m[1] && !first)) throw new SyntaxError(`Unsupported selector "${selector}"`);
      if (m[1]) c.tag = m[1] === "*" ? null : cssUnescape(m[1]);
      else if (m[2]) c.classes.push(cssUnescape(m[2]));
      else if (m[3]) c.id = cssUnescape(m[3]);
      else {
        const value = m[5] ?? m[6] ?? m[7];
        c.attrs.push({ name: cssUnescape(m[4]), value: value === undefined ? null : cssUnescape(value) });
      }
      rest = rest.slice(m[0].length);
      first = false;
    }
    compounds.push(c);
  }
  cache.set(selector, compounds);
  return compounds;
}

/** Split "a, b" at top-level commas (not inside quotes or brackets). */
function splitList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

function matchesCompound(m: Mark, c: Compound): boolean {
  if (c.tag !== null && m.localName !== c.tag) return false;
  if (c.id !== null && m.id !== c.id) return false;
  if (c.classes.length) {
    const raw = m.getAttribute("class");
    if (!raw) return false;
    // Classes are nearly always one space apart; tidy them only when not.
    const cls = /[^\S ]| {2}/.test(raw) ? ` ${raw.replace(/\s+/g, " ")} ` : ` ${raw} `;
    for (const name of c.classes) if (!cls.includes(` ${name} `)) return false;
  }
  for (const a of c.attrs) {
    const value = m.getAttribute(a.name);
    if (value === null || (a.value !== null && value !== a.value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// To SVG
// ---------------------------------------------------------------------------

/** A mark tree as real SVG elements: the same elements, attributes in the same order. */
export function toSvg(root: Mark, doc: Document = document): SVGElement {
  const el = doc.createElementNS(SVG_NS, root.localName) as SVGElement;
  for (const [name, value] of root.attributeEntries()) {
    if (name === "style" && root.styleProperties.length) {
      for (const [prop, v] of root.styleProperties) el.style.setProperty(prop, v);
    } else el.setAttribute(name, value);
  }
  const children = root.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    el.appendChild(child instanceof Mark ? toSvg(child, doc) : doc.createTextNode(child.textContent));
  }
  return el;
}

/**
 * What the canvas renderer reads from a drawing: true of marks and of DOM
 * elements alike, so the same code paints either.
 */
export interface DrawingNode {
  readonly localName: string;
  readonly id: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  readonly attributes: ArrayLike<{ name: string; value: string }>;
  readonly children: ArrayLike<DrawingNode> & Iterable<DrawingNode>;
  readonly childNodes: Iterable<{ nodeType: number; textContent: string | null }>;
  readonly textContent: string | null;
  readonly parentElement: DrawingNode | null;
  querySelector(selector: string): DrawingNode | null;
  querySelectorAll(selector: string): Iterable<DrawingNode>;
}
