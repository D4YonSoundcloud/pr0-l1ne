/**
 * Drawing only the boxes that changed since the last step.
 *
 * Laying out a step draws every box again, and with thousands of boxes
 * that's most of the layout's time, though nearly all of them look exactly
 * as they did. So each object's box is kept from one step to the next with
 * everything its drawing read on the way: the heap object itself, what
 * changed in it, the hints asked about it (pointers, windows, heat...), its
 * memory size, and so on. A box is drawn again only when one of those reads
 * gives a different answer now. Placement still runs over every box each
 * step (it's cheap), so a kept box never drifts from where a full layout
 * would put it: a kept box is used again only at the same place.
 *
 * A box's drawing reaches the step only through its context (shapes.ts's
 * Ctx), so the reads are recorded by handing it a context that writes down
 * each question and its answer. A box drawn the same way is then the same
 * marks: they go into this step's drawing as they are (Mark.appendShared),
 * so the SVG patcher and the canvas's paint see the very same marks, and
 * skip them at once.
 *
 * Heap objects are compared by identity: the tracers send an object that
 * didn't change as the same object (trace/delta.ts, js/inspector.ts), and
 * nothing changes one once sent. Other answers are compared by value.
 */
import type { HeapObject } from "../../trace/types";
import type { Mark } from "../drawing";
import { onSpacingChange } from "../spacing";
import { CellCache } from "./cellCache";
import { viewOf } from "./objects";
import type { Ctx, OutRef, Shape } from "./shapes";

/** One read: how to ask it again, and the answer it got. */
interface Read {
  ask(ctx: Ctx): unknown;
  /** The answer: an object compared by identity, or anything else as its JSON. */
  same: unknown;
  byIdentity: boolean;
}

interface Entry {
  obj: HeapObject;
  reads: Read[];
  /** How many reads it had once drawn the first time: drawing it again elsewhere reads the same again. */
  readsDrawn: number;
  shape: Shape;
  /** Its drawing at a place, once drawn there: the marks inside its box, and the arrows leaving them. */
  drawn: { x: number; y: number; marks: Mark[]; refs: OutRef[]; cells: string[] } | null;
  /** It shows a change (a flash, a new box): drawn afresh, so the animation plays. */
  fresh: boolean;
}

/** Bumped when something every box's drawing depends on changes (spacing, fonts): every kept box is drawn again. */
let epoch = 0;
export function forgetBoxes(): void {
  epoch++;
}
onSpacingChange(forgetBoxes);

/** Kept boxes, for one window. Give the same one to each step's layout (MemoryLayout.boxes). */
export class BoxCache {
  private entries = new Map<string, Entry>();
  private next = new Map<string, Entry>();
  private epoch = epoch;
  /** The least detail any kept box (or cell) was built with. */
  private level = 0;
  /** How many boxes the last layout drew, and how many it kept (for tests and the benchmarks). */
  stats = { drawn: 0, kept: 0 };
  /** Cells kept inside boxes drawn again (cellCache.ts). */
  readonly cells = new CellCache();

  /**
   * A layout begins, built at this level of detail (lod.ts buildAt): what
   * isn't used in it is forgotten after it. Boxes built with more detail
   * are kept for a layout with less (atLevel leaves out the rest); not the
   * other way.
   */
  begin(level = 0): void {
    if (this.epoch !== epoch || level < this.level) {
      this.entries.clear();
      this.cells.clear();
      this.epoch = epoch;
      this.level = level;
    } else this.level = Math.max(this.level, level);
    this.next = new Map();
    this.stats = { drawn: 0, kept: 0 };
    this.cells.begin();
  }

  /** A layout ended. */
  end(): void {
    this.entries = this.next;
    this.next = new Map();
    this.cells.end();
  }

  /**
   * An object's box: kept if everything it read reads the same now, or
   * made with `make` (given a context that records what it reads).
   */
  shape(obj: HeapObject, ctx: Ctx, make: (ctx: Ctx) => Shape): Shape {
    const was = this.entries.get(obj.id);
    if (was && was.obj === obj && !was.fresh && stillTrue(was.reads, ctx)) {
      this.next.set(obj.id, was);
      return was.shape;
    }
    const reads: Read[] = [];
    const shape = make(recording(ctx, reads));
    const entry: Entry = {
      obj,
      reads,
      readsDrawn: -1,
      shape,
      drawn: null,
      fresh: ctx.diff.newObjects.has(obj.id) || (ctx.diff.changedSlots.get(obj.id)?.size ?? 0) > 0,
    };
    this.next.set(obj.id, entry);
    return shape;
  }

  /**
   * Draw an object's box at (x, y) into `g`, adding the arrows leaving it to
   * `refs`: its kept marks if it was drawn there before, else drawn now.
   */
  draw(id: string, x: number, y: number, g: Mark, refs: OutRef[]): void {
    const entry = this.next.get(id);
    if (!entry) throw new Error(`no box for ${id}`);
    const drawn = entry.drawn;
    if (drawn && drawn.x === x && drawn.y === y) {
      g.appendShared(...drawn.marks);
      for (const ref of drawn.refs) refs.push({ ...ref });
      // Its cells too, so they're still kept when one of them next changes.
      this.cells.touch(drawn.cells);
      this.stats.kept++;
      return;
    }
    // Somewhere new (or for the first time): drawn. Everything it reads reads
    // the same as when its shape was made, so its shape draws it as this step would.
    const before = refs.length;
    const start = g.childNodes.length;
    const cells = this.cells.record(() => entry.shape.draw(x, y, g, refs));
    this.stats.drawn++;
    // Drawn before, it read all this then: the reads it just added say nothing new.
    if (entry.readsDrawn >= 0) entry.reads.length = entry.readsDrawn;
    else entry.readsDrawn = entry.reads.length;
    if (entry.fresh) return;
    entry.drawn = {
      x,
      y,
      marks: g.childNodes.slice(start) as Mark[],
      // As drawn, before the layout adds where each starts from.
      refs: refs.slice(before).map((r) => ({ ...r })),
      cells,
    };
  }
}

/** Do the reads all read the same now? */
function stillTrue(reads: Read[], ctx: Ctx): boolean {
  for (const read of reads) {
    const now = read.ask(ctx);
    if (read.byIdentity ? now !== read.same : json(now) !== read.same) return false;
  }
  return true;
}

const json = (value: unknown): string => JSON.stringify(value) ?? "undefined";

/**
 * A context that answers as `ctx` does, writing down each question and its
 * answer in `reads`. Every way a box's drawing reaches the step goes
 * through here (shapes.ts's Ctx).
 */
function recording(ctx: Ctx, reads: Read[]): Ctx {
  const byValue = <T>(ask: (c: Ctx) => T): T => {
    const answer = ask(ctx);
    reads.push({ ask, same: json(answer), byIdentity: false });
    return answer;
  };
  const byIdentity = <T>(ask: (c: Ctx) => T): T => {
    const answer = ask(ctx);
    reads.push({ ask, same: answer, byIdentity: true });
    return answer;
  };
  const heap = new Proxy(ctx.step.heap, {
    get: (_, id) => (typeof id === "string" ? byIdentity((c) => c.step.heap[id]) : undefined),
    has: (_, id) => typeof id === "string" && byValue((c) => id in c.step.heap),
  });
  const step = new Proxy(ctx.step, {
    get: (target, name) => {
      if (name === "heap") return heap;
      // Anything else of the step: by identity (none is read today; this keeps it right if one is).
      return typeof name === "string"
        ? byIdentity((c) => (c.step as unknown as Record<string, unknown>)[name])
        : Reflect.get(target, name);
    },
  });
  const own = {
    changedSlots: {
      get: (id: string) => {
        const slots = byValue((c) => [...(c.diff.changedSlots.get(id) ?? [])].sort());
        return slots.length ? new Set(slots) : ctx.diff.changedSlots.get(id);
      },
    },
    newObjects: { has: (id: string) => byValue((c) => c.diff.newObjects.has(id)) },
  };
  // Anything else of the diff: by identity (none is read today; this keeps it right if one is).
  const diff = new Proxy(ctx.diff, {
    get: (target, name) =>
      name in own
        ? own[name as keyof typeof own]
        : typeof name === "string"
          ? byIdentity((c) => (c.diff as unknown as Record<string, unknown>)[name])
          : Reflect.get(target, name),
  }) as Ctx["diff"];
  const sizes = ctx.sizes
    ? (new Proxy(ctx.sizes, {
        get: (target, name) => {
          const value = Reflect.get(target, name);
          if (typeof value !== "function")
            return byValue((c) => (c.sizes as unknown as Record<string | symbol, unknown>)?.[name]);
          return (...args: unknown[]) =>
            byValue((c) => {
              const s = c.sizes as unknown as Record<string | symbol, (...a: unknown[]) => unknown> | null;
              return s ? s[name].apply(s, args) : undefined;
            });
        },
      }) as Ctx["sizes"])
    : null;
  if (!ctx.sizes) reads.push({ ask: (c) => c.sizes === null, same: json(true), byIdentity: false });
  else reads.push({ ask: (c) => c.sizes !== null, same: json(true), byIdentity: false });
  const rec: Ctx = {
    step: step as Ctx["step"],
    diff,
    nested: { has: (id: string) => byValue((c) => c.nested.has(id)) } as ReadonlySet<string>,
    functionKeyword: byValue((c) => c.functionKeyword),
    pointersFor: (id, level) => byValue((c) => c.pointersFor(id, level)),
    windowsFor: (id) => byValue((c) => c.windowsFor(id)),
    comparesFor: (id) => byValue((c) => c.comparesFor(id)),
    regionLabelsFor: (id) => byValue((c) => c.regionLabelsFor(id)),
    titleOf: (obj) => byValue((c) => c.titleOf(obj)),
    gridFocus: (id, size) => byValue((c) => c.gridFocus(id, size)),
    gridCells: ((id: string, size: Parameters<Ctx["gridCells"]>[1]) =>
      byValue((c) => c.gridCells(id, size))) as Ctx["gridCells"],
    heatFor: (id) => byValue((c) => c.heatFor(id)),
    drawAs: (id) => byValue((c) => c.drawAs(id)),
    sizes,
    // A nested object's box is drawn with this context too, so its reads are this box's.
    view: (value, cellH) => viewOf(value, rec, cellH),
    // A cache of finished cells, keyed by everything they're drawn from: not a read.
    cells: ctx.cells,
  };
  return rec;
}
