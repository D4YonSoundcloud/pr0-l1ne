/**
 * A trace's heaps, kept as what changed.
 *
 * A trace sent as deltas (trace/delta.ts) says, for each step, the objects
 * that changed and how its ids differ from the step before's. Rebuilt into
 * a full record per step, a heap costs every object it holds again at
 * every step where anything changed: a 2,047-node tree being built is 10
 * million entries, most of a browser tab. So the heaps are kept the way
 * they came. Each object id has its versions: the step's heap version
 * each one is from, and the object then (or that it's gone), so finding an
 * object at a step is a search through its few versions. The ids in
 * order, for a walk over a heap, are a list in full every
 * CHECKPOINT_EVERY versions, and changes between: a walk rebuilds a
 * version's list from the full one before it (and keeps the last few
 * rebuilt).
 *
 * A step's `heap` is a view of its version: it reads as a plain record
 * (`heap[id]`, `id in heap`, `Object.keys(heap)`...) through a Proxy, so
 * nothing that reads a heap needs to know. What reads every object of many
 * steps uses heapIds and heapSize instead, which skip the Proxy. Steps
 * whose heap is the same share one view, as they shared one record. A view
 * can't be changed, nor sent in a message (a Proxy can't be cloned): what
 * goes to the page is drawings.
 */
import type { HeapObject } from "./types";

/** A full list of ids at least this often, in versions. */
export const CHECKPOINT_EVERY = 64;

/** How a version's ids came: in full, or as a change to the version before's. */
type IdsRecord =
  | { full: readonly string[] }
  | { same: true }
  | { head: number; tail: number; middle: readonly string[]; length: number };

/** An object id's versions: the heap version each is from (ascending), and the object, or null where it's gone. */
interface History {
  at: number[];
  obj: (HeapObject | null)[];
}

const VIEW = Symbol("heap view");

export type Heap = Record<string, HeapObject>;

class ViewHandler implements ProxyHandler<Heap> {
  constructor(
    readonly store: HeapStore,
    readonly version: number,
  ) {}

  get(_target: Heap, key: string | symbol): unknown {
    if (typeof key === "string") return this.store.get(key, this.version);
    return key === VIEW ? this : undefined;
  }

  has(_target: Heap, key: string | symbol): boolean {
    return typeof key === "string" && this.store.get(key, this.version) !== undefined;
  }

  ownKeys(): string[] {
    return this.store.keys(this.version);
  }

  getOwnPropertyDescriptor(_target: Heap, key: string | symbol): PropertyDescriptor | undefined {
    if (typeof key !== "string") return undefined;
    const value = this.store.get(key, this.version);
    return value === undefined ? undefined : { value, writable: false, enumerable: true, configurable: true };
  }

  set(): boolean {
    throw new TypeError("a step's heap can't be changed");
  }

  defineProperty(): boolean {
    throw new TypeError("a step's heap can't be changed");
  }

  deleteProperty(): boolean {
    throw new TypeError("a step's heap can't be changed");
  }
}

export class HeapStore {
  private readonly history = new Map<string, History>();
  private readonly records: IdsRecord[] = [];
  private readonly sizes: number[] = [];
  private readonly views: Heap[] = [];
  /** The newest version's ids, in full (the next change applies to them). */
  private latest: readonly string[] = [];
  private sinceFull = 0;
  /** Ids sent with no object (none ever sent under them): left out of walks. */
  private missing = false;
  /** Lists rebuilt for walks, newest last (a few: walks go step by step). */
  private readonly rebuilt = new Map<number, readonly string[]>();

  /** Versions so far. */
  get versions(): number {
    return this.records.length;
  }

  /**
   * A new version: its ids (in full, the same as the version before's, or a
   * change to them) and the objects that changed. Returns its view.
   */
  add(ids: { full: readonly string[] } | { same: true } | { part: [number, number, string[]] }, changed: Heap): Heap {
    const version = this.records.length;
    const before = this.latest;
    let next: readonly string[];
    let record: IdsRecord;
    let unknown: string[] = [];
    if ("same" in ids) {
      next = before;
      record = { same: true };
      this.sinceFull++;
    } else if ("part" in ids) {
      const [head, tail, middle] = ids.part;
      if (head < 0 || tail < 0 || head + tail > before.length)
        throw new Error("a step's heap ids don't fit the step before's");
      next = [...before.slice(0, head), ...middle, ...before.slice(before.length - tail)];
      record = { head, tail, middle, length: next.length };
      this.sinceFull++;
      // What left and what came back: only the ids between can have.
      unknown = this.presence(version, before.slice(head, before.length - tail), middle);
    } else {
      next = ids.full;
      record = { full: next };
      this.sinceFull = 0;
      unknown = this.presence(version, before, next);
    }
    if (this.sinceFull >= CHECKPOINT_EVERY && !("full" in record)) {
      record = { full: next };
      this.sinceFull = 0;
    }
    for (const id in changed) this.put(id, version, changed[id]);
    for (const id of unknown) if (!this.history.has(id)) this.missing = true;
    this.latest = next;
    this.records.push(record);
    this.sizes.push(next.length);
    const view = new Proxy({} as Heap, new ViewHandler(this, version));
    this.views.push(view);
    return view;
  }

  /** The view of a version. */
  view(version: number): Heap {
    return this.views[version];
  }

  /** The object with this id in a version's heap, or undefined. */
  get(id: string, version: number): HeapObject | undefined {
    const h = this.history.get(id);
    if (!h) return undefined;
    const at = h.at;
    let i = at.length - 1;
    if (at[i] > version) {
      // Binary search: the last version at or before this one.
      let lo = 0;
      let hi = i;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (at[mid] <= version) lo = mid;
        else hi = mid - 1;
      }
      i = lo;
      if (at[i] > version) return undefined;
    }
    return h.obj[i] ?? undefined;
  }

  /** A version's ids, in order (an array kept for later walks: not to be changed). */
  ids(version: number): readonly string[] {
    if (version === this.records.length - 1) return this.latest;
    const kept = this.rebuilt.get(version);
    if (kept) return kept;
    // From the nearest version before it with its ids in full (or one rebuilt), forward.
    let from = version;
    let ids: readonly string[] | undefined;
    while (from >= 0) {
      const record = this.records[from];
      if ("full" in record) {
        ids = record.full;
        break;
      }
      const near = this.rebuilt.get(from);
      if (near) {
        ids = near;
        break;
      }
      from--;
    }
    if (!ids) ids = [];
    for (let v = from + 1; v <= version; v++) {
      const record = this.records[v];
      if ("full" in record) ids = record.full;
      else if ("head" in record)
        ids = [...ids.slice(0, record.head), ...record.middle, ...ids.slice(ids.length - record.tail)];
    }
    this.rebuilt.set(version, ids);
    if (this.rebuilt.size > 8) this.rebuilt.delete(this.rebuilt.keys().next().value as number);
    return ids;
  }

  /** A version's ids, for a walk over its view (a copy, as a Proxy's keys must be: without ids that hold nothing). */
  keys(version: number): string[] {
    const ids = this.ids(version);
    return this.missing ? ids.filter((id) => this.get(id, version) !== undefined) : [...ids];
  }

  /** How many objects a version's heap holds. */
  size(version: number): number {
    return this.missing ? this.keys(version).length : this.sizes[version];
  }

  /** Note an object's version (null: gone from the heap). */
  private put(id: string, version: number, obj: HeapObject | null): void {
    if (id === "__proto__") throw new Error('it has a "__proto__" key');
    let h = this.history.get(id);
    if (!h) {
      if (obj === null) return;
      h = { at: [], obj: [] };
      this.history.set(id, h);
    }
    const last = h.at.length - 1;
    if (last >= 0 && h.at[last] === version) h.obj[last] = obj;
    else {
      h.at.push(version);
      h.obj.push(obj);
    }
  }

  /**
   * Ids that left between two lists are gone from this version on; ids that came back are there
   * again, as they were. Returns the ids with no object yet (new ones, sent with this version).
   */
  private presence(version: number, before: readonly string[], after: readonly string[]): string[] {
    const unknown: string[] = [];
    const was = new Set(before);
    const is = new Set(after);
    for (const id of before) if (!is.has(id)) this.put(id, version, null);
    for (const id of after) {
      if (id === "__proto__") throw new Error('it has a "__proto__" key');
      if (was.has(id)) continue;
      const h = this.history.get(id);
      if (!h) {
        unknown.push(id);
        continue;
      }
      const last = h.obj[h.obj.length - 1];
      if (last === null) {
        // Back, unchanged unless it's sent with this version too: as it was when it left.
        let i = h.obj.length - 2;
        while (i >= 0 && h.obj[i] === null) i--;
        if (i >= 0) this.put(id, version, h.obj[i]);
      }
    }
    return unknown;
  }
}

/**
 * What keeping a changed object costs, in heap entries (SamplingPolicy.maxHeapEntries): one,
 * and one for each thing it holds (an item, a field, an entry's key and its value). As the
 * Python tracer counts it (worker/steplog.py kept_entries).
 */
export function keptEntries(obj: HeapObject): number {
  const o = obj as { items?: unknown[]; entries?: unknown[]; fields?: unknown[]; strip?: { values: unknown[] } };
  return (
    1 +
    (o.items?.length ?? 0) +
    2 * (o.entries?.length ?? 0) +
    (o.fields?.length ?? 0) +
    Math.ceil((o.strip?.values.length ?? 0) / 8)
  );
}

/** The handler behind a heap view, or undefined for a plain record. */
function viewOf(heap: Heap): ViewHandler | undefined {
  return (heap as unknown as Record<symbol, ViewHandler | undefined>)[VIEW];
}

/** Is this heap a view of a HeapStore (not a plain record)? */
export function isHeapView(heap: Heap): boolean {
  return viewOf(heap) !== undefined;
}

/** A heap's ids in order: for a view, without going through its Proxy for each one (not to be changed). */
export function heapIds(heap: Heap): readonly string[] {
  const view = viewOf(heap);
  return view ? view.store.keys(view.version) : Object.keys(heap);
}

/** How many objects a heap holds (a view knows without walking it). */
export function heapSize(heap: Heap): number {
  const view = viewOf(heap);
  if (view) return view.store.size(view.version);
  let n = 0;
  for (const _ in heap) n++;
  return n;
}

/** A heap's objects in order (Object.values, without going through a view's Proxy for each). */
export function heapValues(heap: Heap): HeapObject[] {
  const view = viewOf(heap);
  if (!view) return Object.values(heap);
  const { store, version } = view;
  const out: HeapObject[] = [];
  for (const id of store.ids(version)) {
    const obj = store.get(id, version);
    if (obj) out.push(obj);
  }
  return out;
}

/** A heap's objects in order, with their ids. */
export function* heapEntries(heap: Heap): Generator<[string, HeapObject]> {
  const view = viewOf(heap);
  if (!view) {
    for (const id in heap) yield [id, heap[id]];
    return;
  }
  const { store, version } = view;
  for (const id of store.ids(version)) {
    const obj = store.get(id, version);
    if (obj) yield [id, obj];
  }
}
