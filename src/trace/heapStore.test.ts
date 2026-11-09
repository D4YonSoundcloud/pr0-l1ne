import { describe, expect, it } from "vitest";
import { HeapEncoder, HeapExpander } from "./delta";
import { CHECKPOINT_EVERY, heapEntries, heapIds, heapSize, isHeapView } from "./heapStore";
import type { HeapObject, Step } from "./types";

/** A small seeded random number generator, so a failure can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const obj = (id: string, n: number): HeapObject => ({
  kind: "list",
  id,
  typeName: "list",
  items: [{ kind: "prim", type: "int", repr: String(n) }],
  length: 1,
});

/**
 * Full steps whose heaps change the ways programs' do: objects added in the middle
 * (a tree's preorder), dropped, back again unchanged, changed, the whole order shuffled,
 * and runs of steps where nothing changes.
 */
function steps(seed: number, count: number): Step[] {
  const next = random(seed);
  let ids: string[] = [];
  const latest = new Map<string, HeapObject>();
  let counter = 0;
  let heap: Record<string, HeapObject> = {};
  const out: Step[] = [];
  for (let i = 0; i < count; i++) {
    const roll = next();
    let changedIds = false;
    if (roll < 0.35) {
      const id = `o${++counter}`;
      ids.splice(Math.floor(next() * (ids.length + 1)), 0, id);
      latest.set(id, obj(id, 0));
      changedIds = true;
    } else if (roll < 0.45 && ids.length) {
      ids.splice(Math.floor(next() * ids.length), 1);
      changedIds = true;
    } else if (roll < 0.52 && latest.size > ids.length) {
      // One that left comes back, as it was.
      const gone = [...latest.keys()].filter((id) => !ids.includes(id));
      ids.splice(Math.floor(next() * (ids.length + 1)), 0, gone[Math.floor(next() * gone.length)]);
      changedIds = true;
    } else if (roll < 0.55) {
      ids = [...ids].sort(() => next() - 0.5);
      changedIds = true;
    } else if (roll < 0.8 && ids.length) {
      const id = ids[Math.floor(next() * ids.length)];
      latest.set(id, obj(id, i));
      changedIds = true; // (the record is new: an object in it changed)
    }
    if (changedIds) {
      heap = {};
      for (const id of ids) heap[id] = latest.get(id)!;
    }
    out.push({ event: "line", line: i, stack: [], heap, stdoutLength: 0, loops: [] } as unknown as Step);
  }
  return out;
}

describe("heaps kept as what changed", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`reads the same as the full heaps it came from, every step (seed ${seed})`, () => {
      const full = steps(seed, CHECKPOINT_EVERY * 5);
      const encoder = new HeapEncoder();
      const expander = new HeapExpander();
      const views = full.map((step) => expander.add(encoder.encode(step)).heap);
      // Read in order, then again in a scrambled order (the ids rebuilt from a full list each time).
      const order = [...full.keys(), ...[...full.keys()].sort((a, b) => ((a * 7919) % 97) - ((b * 7919) % 97))];
      for (const i of order) {
        const heap = views[i];
        const want = full[i].heap;
        expect(isHeapView(heap) || Object.keys(want).length === 0).toBe(true);
        expect(Object.keys(heap)).toEqual(Object.keys(want));
        expect([...heapIds(heap)]).toEqual(Object.keys(want));
        expect(heapSize(heap)).toBe(Object.keys(want).length);
        for (const [id, o] of heapEntries(heap)) expect(o).toBe(want[id]);
        for (const id of Object.keys(want)) {
          expect(heap[id]).toBe(want[id]);
          expect(id in heap).toBe(true);
        }
        expect(heap.o999999).toBeUndefined();
        expect("o999999" in heap).toBe(false);
      }
      // Steps that shared a record share a view.
      for (let i = 1; i < full.length; i++) if (full[i].heap === full[i - 1].heap) expect(views[i]).toBe(views[i - 1]);
    });
  }

  it("reads as a plain record: spread, JSON, for-in, Object.values and entries", () => {
    const full = steps(9, 40);
    const encoder = new HeapEncoder();
    const expander = new HeapExpander();
    for (const step of full) {
      const heap = expander.add(encoder.encode(step)).heap;
      expect({ ...heap }).toEqual(step.heap);
      expect(JSON.parse(JSON.stringify(heap))).toEqual(JSON.parse(JSON.stringify(step.heap)));
      const keys: string[] = [];
      for (const id in heap) keys.push(id);
      expect(keys).toEqual(Object.keys(step.heap));
      expect(Object.values(heap)).toEqual(Object.values(step.heap));
      expect(Object.entries(heap)).toEqual(Object.entries(step.heap));
      expect(heap).toEqual(step.heap);
    }
  });

  it("can't be changed", () => {
    const encoder = new HeapEncoder();
    const expander = new HeapExpander();
    const full = steps(3, 10).filter((s) => Object.keys(s.heap).length);
    const heap = expander.add(encoder.encode(full[0])).heap;
    expect(() => {
      heap.x = obj("x", 1);
    }).toThrow(TypeError);
    expect(() => delete heap[Object.keys(heap)[0]]).toThrow(TypeError);
  });

  it("a tree built a node a step, in the middle of the order", () => {
    // 2,000 steps, each adding a node in the middle: full records would be 2 million entries.
    const full: Step[] = [];
    const ids: string[] = [];
    let heap: Record<string, HeapObject> = {};
    for (let i = 0; i < 2000; i++) {
      ids.splice(i >> 1, 0, `o${i}`);
      heap = { ...heap };
      heap[`o${i}`] = obj(`o${i}`, i);
      const ordered: Record<string, HeapObject> = {};
      for (const id of ids) ordered[id] = heap[id];
      full.push({ event: "line", line: 1, stack: [], heap: ordered, stdoutLength: 0, loops: [] } as unknown as Step);
    }
    const encoder = new HeapEncoder();
    const expander = new HeapExpander();
    const views = full.map((step) => expander.add(encoder.encode(step)).heap);
    expect(Object.keys(views[1999])).toEqual(ids);
    expect(views[1000].o1000).toBe(full[1000].heap.o1000);
    expect(views[999].o1000).toBeUndefined();
  });
});
