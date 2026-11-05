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

/** The children of a mark with none (Mark.childNodes): one list for them all, never changed. */
const NO_CHILDREN: readonly never[] = Object.freeze([]);

/** A run of text in a mark (a DOM text node). */
export class TextMark {
  parentElement: Mark | null = null;
  constructor(private text: string) {}

  /** A DOM text node's type (on the prototype: a drawing has hundreds of thousands of marks). */
  get nodeType(): 3 {
    return 3;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    if (value === this.text) return;
    this.text = value;
    this.parentElement?.changed();
  }
}

type Child = Mark | string | null | undefined | false;

/** Mark.flags: something worked out from the mark is kept; it's shared between two drawings. (Bits 0–4: levels.) */
const CACHED = 1 << 5;
const SHARED = 1 << 6;
/** Changed on the page in a way the layout worker doesn't know of (a box nudged while dragged): never copied (render/wire.ts). */
const NO_COPY = 1 << 7;

/** What few marks need, kept apart so the many that don't are smaller. */
interface MarkMore {
  /** Properties set with style.setProperty, in order (toSvg sets them the same way). */
  styleProps: [string, string][] | null;
  classes: MarkClasses | null;
  /** signature(), kept until this mark or one in it changes. */
  sig: string | null;
  /** atLevel()'s copies at each level (lod.ts); kept like sig. */
  levels: (Mark | undefined)[] | null;
}

/** Classes on a mark, like an element's classList. */
class MarkClasses {
  constructor(private readonly mark: Mark) {}

  private get tokens(): string[] {
    const value = this.mark.getAttribute("class");
    if (!value) return [];
    // The layout's own classes are single-spaced and never repeat: no need for the regex then.
    const simple = !/[\t\n\f\r]| {2}|^ | $/.test(value);
    const tokens = simple ? value.split(" ") : value.split(/[\t\n\f\r ]+/).filter(Boolean);
    // Repeats go, as in the DOM; there are almost never any, and a mark has few classes.
    for (let i = 1; i < tokens.length; i++)
      for (let j = 0; j < i; j++) if (tokens[i] === tokens[j]) return [...new Set(tokens)];
    return tokens;
  }

  private set(tokens: string[]): void {
    this.mark.setAttribute("class", tokens.join(" "));
  }

  /**
   * Adding classes to a class attribute gives the same string every time
   * (a cell's "cell has-v-num" and "heat heat-3"...): worked out once, and
   * the same string object after, so a grid's cells don't each make their own.
   */
  private static added = new Map<string, Map<string, string>>();
  private static addedCount = 0;

  contains(name: string): boolean {
    const value = this.mark.getAttribute("class");
    if (!value) return false;
    if (value === name) return true;
    return this.tokens.includes(name);
  }

  add(...names: string[]): void {
    // The usual case, one class onto a mark with none: no tokens to work out.
    if (names.length === 1 && !this.mark.hasAttribute("class")) {
      this.mark.setAttribute("class", names[0]);
      return;
    }
    const value = this.mark.getAttribute("class") ?? "";
    const key = names.length === 1 ? names[0] : names.join("\u0001");
    let results = MarkClasses.added.get(value);
    let result = results?.get(key);
    if (result === undefined) {
      const tokens = this.tokens;
      for (const name of names) if (!tokens.includes(name)) tokens.push(name);
      result = tokens.join(" ");
      if (++MarkClasses.addedCount > 20_000) {
        MarkClasses.added.clear();
        MarkClasses.addedCount = 1;
        results = undefined;
      }
      if (!results) {
        results = new Map();
        MarkClasses.added.set(value, results);
      }
      results.set(key, result);
    }
    this.mark.setAttribute("class", result);
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
  parentElement: Mark | null = null;
  /** Its children. Most marks have none, and share one empty list until they get one (kids()). */
  childNodes: readonly (Mark | TextMark)[] = NO_CHILDREN;
  /**
   * Attributes in order, as name, value, name, value...: lighter than a Map
   * for the few a mark has. A value given as a number stays one until it's
   * read as text (value()), so a grid's coordinates aren't each made into a
   * string the canvas then parses back (numberAttribute).
   */
  private attrs: (string | number)[] = [];
  /**
   * Bits: the levels at which it's its own atLevel result (0 to 4, so most
   * marks need no array of copies); CACHED, something is worked out from
   * this mark and kept here or in a mark it's in (changed() must forget it,
   * here and above; a mark whose parent keeps something always does too);
   * SHARED (isShared).
   */
  private flags = 0;
  /** signatureId(), and the generation of numbers it's from; kept until this mark or one in it changes. */
  private sid = 0;
  private sidGeneration = -1;
  /** What few marks need: inline styles, a classList, a string signature, copies at levels. */
  private more: MarkMore | null = null;

  constructor(readonly localName: string) {}

  /** A DOM element's type (on the prototype: a drawing has hundreds of thousands of marks). */
  get nodeType(): 1 {
    return 1;
  }

  /**
   * Changed on the page in a way the layout worker doesn't know of (a box
   * nudged while it's dragged, memory.ts nudgeBox), so the page can't
   * make a copy of it for the worker (render/wire.ts). A hover's classes
   * don't count: the renderers put the focus on every drawing they show
   * again (applyFocus), copies included.
   */
  get copyable(): boolean {
    return (this.flags & NO_COPY) === 0;
  }

  /** Changed on the page as the worker doesn't know (see copyable). */
  keepFromCopies(): void {
    this.flags |= NO_COPY;
  }

  /** Put in a drawing by appendShared (in two drawings at once): the SVG patcher keeps its own element. */
  get isShared(): boolean {
    return (this.flags & SHARED) !== 0;
  }
  set isShared(shared: boolean) {
    this.flags = shared ? this.flags | SHARED : this.flags & ~SHARED;
  }

  private get extra(): MarkMore {
    this.more ??= { styleProps: null, classes: null, sig: null, levels: null };
    return this.more;
  }

  /** An attribute's value as text, by its place in attrs (a number is made text once, and kept so). */
  private value(i: number): string {
    const v = this.attrs[i];
    if (typeof v === "string") return v;
    const text = String(v);
    this.attrs[i] = text;
    return text;
  }

  /**
   * Everything this mark and the marks in it say, as one string: two marks
   * with the same signature draw the same. Kept on the mark, and forgotten
   * when it or anything in it changes, so a drawing that's mostly the same
   * as before (a hover, a repaint) works out only what changed. The same
   * string object comes back each time, so a Map keyed by it hashes it once.
   */
  signature(): string {
    const kept = this.more?.sig;
    if (kept) return kept;
    let out = `<${this.localName}`;
    const attrs = this.attrs;
    for (let i = 0; i < attrs.length; i += 2) {
      const v = this.value(i + 1);
      out += ` ${attrs[i]}=${v.length}:${v}`;
    }
    out += ">";
    for (const child of this.childNodes) {
      out += child instanceof Mark ? child.signature() : `"${child.textContent.length}:${child.textContent}`;
    }
    out += "/";
    this.extra.sig = out;
    this.flags |= CACHED;
    return out;
  }

  /**
   * The signature as a number: two marks with the same number draw the
   * same, as with signature(). Each mark's number is looked up from its own
   * tag, attributes and text, and its children's numbers, so working it out
   * costs the same at any depth, where signature()'s string holds the whole
   * subtree. Numbers are only comparable within a generation
   * (signatureGeneration): the table of them is started again when it's
   * grown too big, between drawings (startSignatures).
   */
  signatureId(): number {
    if (this.sid !== 0 && this.sidGeneration === generation) return this.sid;
    let key = this.localName;
    const attrs = this.attrs;
    for (let i = 0; i < attrs.length; i += 2) {
      // Read as text without keeping it so: numbers stay numbers, as sent to the page (render/wire.ts).
      const raw = attrs[i + 1];
      const v = typeof raw === "string" ? raw : String(raw);
      key += ` ${attrs[i]}=${v.length}:${v}`;
    }
    key += ">";
    const children = this.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child instanceof Mark) key += `#${child.signatureId()}`;
      else {
        const text = child.textContent;
        key += `"${text.length}:${text}`;
      }
    }
    let id = signatureIds.get(key);
    if (id === undefined) {
      id = signatureIds.size + 1;
      signatureIds.set(key, id);
    }
    this.sid = id;
    this.sidGeneration = generation;
    this.flags |= CACHED;
    return id;
  }

  /** atLevel's result at a level, if it's kept (lod.ts). */
  levelCopy(level: number): Mark | undefined {
    if (this.flags & (1 << level)) return this;
    return this.more?.levels?.[level];
  }

  /** Keep atLevel's result at a level. */
  keepLevelCopy(level: number, copy: Mark): void {
    if (copy === this) this.flags |= 1 << level;
    else {
      const extra = this.extra;
      extra.levels ??= [];
      extra.levels[level] = copy;
    }
    this.flags |= CACHED;
  }

  /** What's worked out above from this mark depends on it (lod.ts: a mark a copy leaves out). */
  noteDependedOn(): void {
    this.flags |= CACHED;
  }

  /** This mark changed: it, and every mark it's in, forget what was worked out from them. (For TextMark too.) */
  changed(): void {
    // A mark keeping nothing has nothing kept above it either (what a mark keeps is made from its children's).
    for (let m: Mark | null = this; m && m.flags & CACHED; m = m.parentElement) {
      m.flags &= SHARED | NO_COPY;
      m.sid = 0;
      const more = m.more;
      if (more) {
        more.sig = null;
        more.levels = null;
      }
    }
  }

  /** A new mark with this one's tag and attributes (inline styles too), and no children. */
  shallowCopy(): Mark {
    const out = new Mark(this.localName);
    out.attrs = this.attrs.slice();
    const styleProps = this.more?.styleProps;
    if (styleProps) out.extra.styleProps = styleProps.map(([n, v]) => [n, v]);
    return out;
  }

  /**
   * Add a child without taking it from where it is (lod.ts's copies): a
   * mark of another drawing stays that drawing's (`adopt` false), or comes
   * to this one (true), as appendShared does.
   */
  appendKept(child: Mark | TextMark, adopt: boolean): void {
    if (adopt) {
      child.parentElement = this;
      if (child instanceof Mark) child.isShared = true;
    }
    this.kids().push(child);
  }

  /** Its own list of children, to change. */
  private kids(): (Mark | TextMark)[] {
    if (this.childNodes === NO_CHILDREN) this.childNodes = [];
    return this.childNodes as (Mark | TextMark)[];
  }

  // -- attributes ---------------------------------------------------------------

  /** Where an attribute's name is in attrs, or -1. */
  private at(name: string): number {
    const attrs = this.attrs;
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === name) return i;
    return -1;
  }

  getAttribute(name: string): string | null {
    const i = this.at(name);
    return i < 0 ? null : this.value(i + 1);
  }

  /** An attribute as a number, if it was given as one (the canvas reads coordinates this way); else as text, or null. */
  numberAttribute(name: string): number | string | null {
    const i = this.at(name);
    return i < 0 ? null : this.attrs[i + 1];
  }

  hasAttribute(name: string): boolean {
    return this.at(name) >= 0;
  }

  /** Like the DOM: an attribute already set keeps its place; a new one goes last. */
  setAttribute(name: string, value: string | number): void {
    const i = this.at(name);
    if (i >= 0) {
      const was = this.attrs[i + 1];
      if (was === value || (typeof was !== typeof value && String(was) === String(value))) return;
      this.attrs[i + 1] = value;
    } else this.attrs.push(name, value);
    this.changed();
  }

  /** setAttribute for a mark being made (mark()): nothing has asked for its signature yet. */
  setOwnAttribute(name: string, value: string | number): void {
    const i = this.at(name);
    if (i >= 0) this.attrs[i + 1] = value;
    else this.attrs.push(name, value);
  }

  removeAttribute(name: string): void {
    const i = this.at(name);
    if (i < 0) return;
    this.attrs.splice(i, 2);
    this.changed();
    if (name === "style" && this.more) this.more.styleProps = null;
  }

  /** Every attribute, in order. */
  get attributes(): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    for (let i = 0; i < this.attrs.length; i += 2)
      out.push({ name: this.attrs[i] as string, value: this.value(i + 1) });
    return out;
  }

  /** How many attributes it has. */
  get attributeCount(): number {
    return this.attrs.length / 2;
  }

  /** The nth attribute's name and value, in order (for walking them without making pairs: toSvg, the patcher). */
  attributeName(n: number): string {
    return this.attrs[2 * n] as string;
  }
  attributeValue(n: number): string {
    return this.value(2 * n + 1);
  }

  /**
   * The attributes as made, name, value, name, value..., numbers still
   * numbers (render/wire.ts sends them to the page so). Not to change.
   */
  get rawAttributes(): readonly (string | number)[] {
    return this.attrs;
  }

  /**
   * A mark as it was sent (render/wire.ts): its attributes as made, its
   * inline style properties, no children yet.
   */
  static restore(localName: string, attrs: (string | number)[], styleProps: [string, string][] | null): Mark {
    const out = new Mark(localName);
    out.attrs = attrs;
    if (styleProps?.length) out.extra.styleProps = styleProps;
    return out;
  }

  /** Add children as they were sent (render/wire.ts): made for this mark, nothing has asked about it yet. */
  appendRestored(child: Mark | TextMark): void {
    child.parentElement = this;
    this.kids().push(child);
  }

  /** The attributes as [name, value] pairs, in order. */
  *attributeEntries(): IterableIterator<[string, string]> {
    const attrs = this.attrs;
    for (let i = 0; i < attrs.length; i += 2) yield [attrs[i] as string, this.value(i + 1)];
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  get classList(): MarkClasses {
    const extra = this.extra;
    extra.classes ??= new MarkClasses(this);
    return extra.classes;
  }

  /** Custom properties and other inline styles, as element.style.setProperty. */
  get style(): { setProperty(name: string, value: string): void } {
    return {
      setProperty: (name, value) => {
        const extra = this.extra;
        extra.styleProps ??= [];
        const props = extra.styleProps;
        const at = props.findIndex(([n]) => n === name);
        if (at >= 0) props[at][1] = value;
        else props.push([name, value]);
        // The style attribute appears where the DOM would put it: last, on the first property.
        const text = props.map(([n, v]) => `${n}: ${v};`).join(" ");
        const i = this.at("style");
        if (i >= 0) this.attrs[i + 1] = text;
        else this.attrs.push("style", text);
        this.changed();
      },
    };
  }

  /** The inline style properties, in order (for toSvg). */
  get styleProperties(): readonly [string, string][] {
    return this.more?.styleProps ?? [];
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
      if (child === null || child === undefined || child === false || child === OMITTED) continue;
      this.kids().push(this.adopt(child));
    }
    this.changed();
  }

  /**
   * Add marks that are also in another drawing, without taking them out of
   * it: the drawing before this one, which the renderer compares this one
   * with (memoryView/boxCache.ts). Marks put in two drawings this way must
   * never change afterwards. Their parentElement is this mark from now on.
   */
  appendShared(...children: Mark[]): void {
    for (const child of children) {
      if (child === OMITTED) continue;
      child.isShared = true;
      child.parentElement = this;
      this.kids().push(child);
    }
    this.changed();
  }

  prepend(...children: Child[]): void {
    const nodes = children
      .filter((c): c is Mark | string => c !== null && c !== undefined && c !== false && c !== OMITTED)
      .map((c) => this.adopt(c));
    this.kids().unshift(...nodes);
    this.changed();
  }

  /** Insert before this mark in its parent. */
  before(...children: Child[]): void {
    const parent = this.parentElement;
    if (!parent) return;
    const nodes = children
      .filter((c): c is Mark | string => c !== null && c !== undefined && c !== false && c !== OMITTED)
      .map((c) => parent.adopt(c));
    parent.kids().splice(parent.childNodes.indexOf(this), 0, ...nodes);
    parent.changed();
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const at = parent.childNodes.indexOf(this);
    if (at >= 0) parent.kids().splice(at, 1);
    parent.changed();
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
  const lists: (readonly (Mark | TextMark)[])[] = [root.childNodes];
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

// ---------------------------------------------------------------------------
// Signature numbers
// ---------------------------------------------------------------------------

/** Every signature numbered so far (Mark.signatureId), by what it's made of. */
const signatureIds = new Map<string, number>();
let generation = 0;
/** How many numbers the table holds before it starts again. */
const MAX_SIGNATURE_IDS = 1 << 21;

/**
 * Before a drawing's signature numbers are asked for (canvas/paint.ts): if
 * the table's grown too big, it starts again, and numbers from before
 * mean nothing now. Returns the generation, which whatever keeps numbers
 * (a paint cache) compares with the one its numbers are from.
 */
export function startSignatures(limit = MAX_SIGNATURE_IDS): number {
  if (signatureIds.size > limit) {
    signatureIds.clear();
    generation++;
  }
  return generation;
}

// ---------------------------------------------------------------------------
// Leaving marks out while building
// ---------------------------------------------------------------------------

/**
 * A mark never made: what mark() gives while a drawing is built without
 * marks of its kind (buildingWithout). Appending it adds nothing, and
 * changing it changes nothing, so the layout code needn't know.
 */
class OmittedMark extends Mark {
  override setAttribute(): void {}
  override setOwnAttribute(): void {}
  override removeAttribute(): void {}
  override append(): void {}
  override appendShared(): void {}
  override appendKept(): void {}
  override prepend(): void {}
  override before(): void {}
  override remove(): void {}
  override changed(): void {}
  override get style(): { setProperty(name: string, value: string): void } {
    return { setProperty: () => {} };
  }
}
const OMITTED: Mark = new OmittedMark("omitted");

/** Which marks to leave out: by tag, and class attribute as made. */
export type OmitRule = (tag: string, classes: string | undefined) => boolean;
let omitting: OmitRule | null = null;

/** Build a drawing with `build`, leaving out (never making) the marks `rule` says. */
export function buildingWithout<T>(rule: OmitRule | null, build: () => T): T {
  const outer = omitting;
  omitting = rule;
  try {
    return build();
  } finally {
    omitting = outer;
  }
}

/** Make a mark: mark("rect", { x: 0, class: "cell" }, ...children). Attributes that are null, undefined or false are left out. */
export function mark(
  tag: string,
  attrs: Record<string, string | number | null | undefined | false> = {},
  ...children: Child[]
): Mark {
  if (omitting !== null) {
    const cls = attrs.class;
    if (omitting(tag, typeof cls === "string" ? cls : undefined)) return OMITTED;
  }
  const m = new Mark(tag);
  // A new mark: its attributes go straight in (nothing to compare, no signature to forget).
  for (const name in attrs) {
    const value = attrs[name];
    if (value === null || value === undefined || value === false) continue;
    // Numbers stay numbers until read as text (Mark.value).
    m.setOwnAttribute(name, value);
  }
  if (children.length) m.append(...children);
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
  for (let i = 0; i < root.attributeCount; i++) {
    const name = root.attributeName(i);
    if (name === "style" && root.styleProperties.length) {
      for (const [prop, v] of root.styleProperties) el.style.setProperty(prop, v);
    } else el.setAttribute(name, root.attributeValue(i));
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
