/**
 * A trace written out for comparing runs ("golden" traces, see
 * src/examples/golden.test.ts).
 *
 * The file is JSON: the trace's top-level fields, pretty-printed, then one
 * line per step. A step lists only the heap objects that are new or changed
 * since the step before (`heap`), the ids that went away (`gone`), and the
 * heap's order when that changed (`order`). So a 150-step trace is a few
 * hundred lines, and a change in behavior shows up in a diff as the few
 * steps it touched.
 */
import { expandHeaps, sameData } from "./delta";
import type { HeapObject, Trace } from "./types";

export function goldenText(trace: Trace): string {
  const full = expandHeaps(structuredClone(trace));
  const { steps, ...meta } = full;

  let prev: Record<string, HeapObject> = {};
  let prevOrder: string[] = [];
  const lines = steps.map((step) => {
    const { heap, heapIds: _ignored, ...rest } = step;
    const order = Object.keys(heap);
    const changed: Record<string, HeapObject> = {};
    for (const id of order) {
      if (!sameData(heap[id], prev[id])) changed[id] = heap[id];
    }
    const gone = prevOrder.filter((id) => !(id in heap));
    const kept = prevOrder.filter((id) => id in heap);
    const sameOrder = kept.every((id, i) => order[i] === id);
    const line: Record<string, unknown> = { ...rest };
    if (Object.keys(changed).length) line.heap = changed;
    if (gone.length) line.gone = gone;
    if (!sameOrder) line.order = order;
    prev = heap;
    prevOrder = order;
    return JSON.stringify(line);
  });

  const head = JSON.stringify(meta, null, 2).replace(/\n/g, "\n  ");
  return `{\n  "meta": ${head},\n  "steps": [\n    ${lines.join(",\n    ")}\n  ]\n}\n`;
}

/** A file name for an example: "Binary search tree insert" -> "binary-search-tree-insert". */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
