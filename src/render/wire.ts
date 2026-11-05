/**
 * A drawing (drawing.ts marks) sent from the layout worker to the page, as
 * a patch on the last one.
 *
 * Most of a step's drawing is marks kept from the step before: boxes and
 * cells that look the same (memoryView/boxCache.ts), loop rows
 * (loopView/rowCache.ts). On the page, the renderers lean on that: the SVG
 * patcher skips a kept mark's element, the canvas keeps what it painted for
 * it, each mark keeps its copies at each level of detail. All of it is by
 * the mark *object*. A drawing posted whole would arrive as all new
 * objects, every step as costly as the first.
 *
 * So both sides number the marks. The worker's encoder sends a mark the
 * page hasn't got in full, numbered in the order sent (the page numbers
 * them the same way as it reads them), and a mark it has as its number.
 * The page's mirror gives back the very mark it made for that number, so a
 * kept mark is the same object on the page too.
 *
 * A number is only sent for a mark of the drawing just before: the page
 * holds that drawing (its renderer does), so it still has every mark in
 * it; older ones it may have let go (the mirror holds marks weakly).
 * "In the drawing before" is worked out without walking it: each mark sent
 * or referred to is stamped with the drawing's number, and a mark inside a
 * kept one was in that drawing if a mark it was first sent inside was
 * stamped (kept marks never change, so what's inside them stays), the
 * parent it was last sent or referred to in.
 *
 * A mark the page hasn't got may still look exactly like one it has: a
 * loop's new row holds the same 3,600 cells as the row above it, which
 * stays on screen, so they can't be the same marks. Such a mark is sent as
 * a copy of the one the page has (its number): the page makes the copy,
 * and both sides number the copy's marks in the order the original's are
 * in. Found by signature (drawing.ts signatureId) among the marks of this
 * drawing and the one before, and checked mark for mark before it's used.
 */
import { Mark, startSignatures, TextMark } from "./drawing";
import { builtAt, type Lod, markBuiltAt } from "./lod";
import { FOCUS_CLASSES } from "./memoryView/focus";

/** A mark sent in full: its tag, attributes as made, inline style properties (0: none) and children. */
export type WireMark = [tag: string, attrs: (string | number)[], style: [string, string][] | 0, children: WireNode[]];
/** A mark the page makes as a copy of one it has (its number). */
export type WireCopy = [copyOf: number];
/** A child: text, a mark the page has (its number), one sent in full, or a copy of one it has. */
export type WireNode = string | number | WireMark | WireCopy;

/** A drawing as sent: its root, and the level of detail it was built at (lod.ts buildAt). */
export interface WireDrawing {
  root: WireNode;
  builtLod: Lod;
}

/** The layout worker's side, for one window. */
export class MarkEncoder {
  private readonly ids = new WeakMap<Mark, number>();
  /** The drawing a mark was last in, at its own level (sent, or referred to). */
  private readonly stamps = new WeakMap<Mark, number>();
  /** The mark it was first sent inside. */
  private readonly sentIn = new WeakMap<Mark, Mark>();
  private drawing = 0;
  private next = 1;
  /** Marks sent or referred to in this drawing and the one before, by signature: what a new mark can be a copy of. */
  private bySig = new Map<number, Mark>();
  private bySigBefore = new Map<number, Mark>();
  /** The signature numbers' generation they're from (drawing.ts startSignatures). */
  private generation = -1;
  /** Marks sent in full, by number, and as copies (with the marks in them) in the last drawing (for tests and the benchmarks). */
  lastSent = { full: 0, kept: 0, copied: 0 };

  encode(root: Mark): WireDrawing {
    this.drawing++;
    this.lastSent = { full: 0, kept: 0, copied: 0 };
    const generation = startSignatures();
    if (generation !== this.generation) {
      this.bySig.clear();
      this.generation = generation;
    }
    this.bySigBefore = this.bySig;
    this.bySig = new Map();
    return { root: this.node(root, null), builtLod: builtAt(root) };
  }

  /** Does the page have this mark (in the drawing before, or read already in this one)? */
  private held(mark: Mark): boolean {
    for (let at: Mark | undefined = mark; at; at = this.sentIn.get(at)) {
      const stamp = this.stamps.get(at);
      if (stamp === this.drawing || stamp === this.drawing - 1) return true;
    }
    return false;
  }

  /** A mark the page has that's drawn exactly like this one, if any. */
  private original(mark: Mark): Mark | null {
    const sig = mark.signatureId();
    const found = this.bySig.get(sig) ?? this.bySigBefore.get(sig);
    if (!found || found === mark || !this.ids.has(found) || !this.held(found)) return null;
    // Never over a mark that goes by number (kept from the drawing before): it stays the page's own.
    return sameTree(found, mark, (m) => this.ids.has(m) && this.onPage(m)) ? found : null;
  }

  /** Number a mark and those in it, as the page numbers its copy of them. */
  private adopt(mark: Mark, parent: Mark | null): void {
    this.ids.set(mark, this.next++);
    this.stamps.set(mark, this.drawing);
    if (parent) this.sentIn.set(mark, parent);
    else this.sentIn.delete(mark);
    this.lastSent.copied++;
    for (const child of mark.childNodes) if (child instanceof Mark) this.adopt(child, mark);
  }

  /** Was this mark in the drawing before, as the page has it? */
  private onPage(mark: Mark): boolean {
    const before = this.drawing - 1;
    for (let at: Mark | undefined = mark; at; at = this.sentIn.get(at)) {
      const stamp = this.stamps.get(at);
      if (stamp === before) return true;
      // Sent (or referred to) in this drawing already: a mark inside it isn't one the page has twice.
      if (stamp === this.drawing) return false;
    }
    return false;
  }

  private node(mark: Mark, parent: Mark | null): WireNode {
    const id = this.ids.get(mark);
    if (id !== undefined && this.onPage(mark)) {
      this.stamps.set(mark, this.drawing);
      // It's in this parent now: a drawing that keeps the parent whole keeps it too.
      if (parent) this.sentIn.set(mark, parent);
      this.lastSent.kept++;
      this.bySig.set(mark.signatureId(), mark);
      return id;
    }
    const original = parent ? this.original(mark) : null;
    if (original) {
      const of = this.ids.get(original)!;
      this.adopt(mark, parent);
      this.bySig.set(mark.signatureId(), mark);
      return [of];
    }
    this.bySig.set(mark.signatureId(), mark);
    this.ids.set(mark, this.next++);
    this.stamps.set(mark, this.drawing);
    if (parent) this.sentIn.set(mark, parent);
    else this.sentIn.delete(mark);
    this.lastSent.full++;
    const children: WireNode[] = [];
    for (const child of mark.childNodes)
      children.push(child instanceof Mark ? this.node(child, mark) : (child as TextMark).textContent);
    const style = mark.styleProperties;
    return [mark.localName, mark.rawAttributes.slice(), style.length ? style.map(([n, v]) => [n, v]) : 0, children];
  }
}

/**
 * Two marks drawn exactly alike, mark for mark (what restoring a copy of
 * one gives), and with no mark in both: a mark kept from the drawing
 * before is sent as its number, never copied, so it stays the page's same
 * object (that's what the renderers skip).
 */
function sameTree(a: Mark, b: Mark, keptByNumber: (mark: Mark) => boolean): boolean {
  if (a === b || a.localName !== b.localName || keptByNumber(b)) return false;
  const aa = a.rawAttributes;
  const ba = b.rawAttributes;
  if (aa.length !== ba.length) return false;
  for (let i = 0; i < aa.length; i++) if (String(aa[i]) !== String(ba[i])) return false;
  const as = a.styleProperties;
  const bs = b.styleProperties;
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) if (as[i][0] !== bs[i][0] || as[i][1] !== bs[i][1]) return false;
  const ac = a.childNodes;
  const bc = b.childNodes;
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    const x = ac[i];
    const y = bc[i];
    if (x instanceof Mark) {
      if (!(y instanceof Mark) || !sameTree(x, y, keptByNumber)) return false;
    } else if (y instanceof Mark || (x as TextMark).textContent !== (y as TextMark).textContent) return false;
  }
  return true;
}

/** A mark number the page doesn't have: the two sides disagree, and the window should start afresh. */
export class WireError extends Error {}

/** The page's side, for one window: the marks it has made from what was sent, by number. */
export class MarkMirror {
  private readonly marks = new Map<number, WeakRef<Mark>>();
  private next = 1;
  private readonly gone =
    typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry<number>((id) => {
          if (!this.marks.get(id)?.deref()) this.marks.delete(id);
        })
      : null;

  decode(drawing: WireDrawing): Mark {
    const root = this.node(drawing.root);
    if (!(root instanceof Mark)) throw new WireError("a drawing's root is a mark");
    markBuiltAt(root, drawing.builtLod);
    return root;
  }

  /** How many marks it knows by number (for tests). */
  get size(): number {
    return this.marks.size;
  }

  private node(node: WireNode): Mark | TextMark {
    if (typeof node === "string") return new TextMark(node);
    if (typeof node === "number") {
      const mark = this.marks.get(node)?.deref();
      if (!mark) throw new WireError(`mark ${node} isn't one the page has`);
      // In the drawing before too: the patcher keeps its own element (patch.ts).
      mark.isShared = true;
      return mark;
    }
    if (node.length === 1) {
      const original = this.marks.get(node[0])?.deref();
      if (!original) throw new WireError(`mark ${node[0]} isn't one the page has`);
      return this.copy(original);
    }
    const [tag, attrs, style, children] = node;
    const mark = Mark.restore(tag, attrs, style || null);
    const id = this.next++;
    this.marks.set(id, new WeakRef(mark));
    this.gone?.register(mark, id);
    for (const child of children) mark.appendRestored(this.node(child));
    return mark;
  }

  /** A copy of a mark it has, numbered as the encoder numbered the marks it stands for. */
  private copy(original: Mark): Mark {
    // Changed on the page since (a box nudged): not what the worker copied.
    if (!original.copyable) throw new WireError("a mark to copy was changed on the page");
    const style = original.styleProperties;
    const attrs = original.rawAttributes.slice();
    // A hover's classes on the page's mark (memoryView/focus.ts): not in the drawing as laid out.
    for (let i = 0; i < attrs.length; i += 2)
      if (
        attrs[i] === "class" &&
        typeof attrs[i + 1] === "string" &&
        /is-focus|is-related|has-focus/.test(attrs[i + 1] as string)
      )
        attrs[i + 1] = (attrs[i + 1] as string)
          .split(" ")
          .filter((name) => !FOCUS_CLASSES.has(name))
          .join(" ");
    const mark = Mark.restore(original.localName, attrs, style.length ? style.map(([n, v]) => [n, v]) : null);
    const id = this.next++;
    this.marks.set(id, new WeakRef(mark));
    this.gone?.register(mark, id);
    for (const child of original.childNodes)
      mark.appendRestored(child instanceof Mark ? this.copy(child) : new TextMark((child as TextMark).textContent));
    return mark;
  }
}
