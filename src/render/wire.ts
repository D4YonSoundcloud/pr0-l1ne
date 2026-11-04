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
 */
import { Mark, TextMark } from "./drawing";
import { builtAt, type Lod, markBuiltAt } from "./lod";

/** A mark sent in full: its tag, attributes as made, inline style properties (0: none) and children. */
export type WireMark = [tag: string, attrs: (string | number)[], style: [string, string][] | 0, children: WireNode[]];
/** A child: text, a mark the page has (its number), or one sent in full. */
export type WireNode = string | number | WireMark;

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
  /** Marks sent in full and by number in the last drawing (for tests and the benchmarks). */
  lastSent = { full: 0, kept: 0 };

  encode(root: Mark): WireDrawing {
    this.drawing++;
    this.lastSent = { full: 0, kept: 0 };
    return { root: this.node(root, null), builtLod: builtAt(root) };
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
      return id;
    }
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
    const [tag, attrs, style, children] = node;
    const mark = Mark.restore(tag, attrs, style || null);
    const id = this.next++;
    this.marks.set(id, new WeakRef(mark));
    this.gone?.register(mark, id);
    for (const child of children) mark.appendRestored(this.node(child));
    return mark;
  }
}
