/**
 * What crosses to the page, held to the old way of working it out: every
 * example, every benchmark program and a few made to be awkward, traced
 * once and encoded twice, by the heap encoder (which reads what changed
 * from the runtime, trace/delta.ts) and by the reference that scans every
 * step's heap (testing/heapEncoderReference.ts). The two must send the
 * same steps byte for byte, and what the page rebuilds from them must be
 * the trace: the same values, and objects shared between steps where the
 * trace shares them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples";
import { HeapEncoderReference } from "../testing/heapEncoderReference";
import { HeapEncoder, HeapExpander, sameData } from "../trace/delta";
import { POLICY } from "../trace/policy";
import type { Trace } from "../trace/types";
import { traceJavaScript } from "./trace";
import { traceTypeScript } from "./typescript";

/** Programs made to be awkward for working out what changed. */
const AWKWARD: [string, string][] = [
  [
    "a sampled loop: passes recorded, some buffered and dropped",
    `const xs = [];
let total = 0;
for (let i = 0; i < 400; i++) {
  xs.push({ i, sq: i * i });
  if (i % 7 === 0) xs[i >> 1].sq = -1;
  total += xs[i].sq;
}
`,
  ],
  [
    "a long list (its window follows the index), a Map, a Set and a function",
    `const big = Array.from({ length: 500 }, (_, k) => k);
const seen = new Set();
const counts = new Map();
let make = (n) => () => n;
for (let i = 0; i < 120; i++) {
  big[i] = -big[i];
  seen.add(i % 9);
  counts.set(i % 5, (counts.get(i % 5) ?? 0) + 1);
  make = ((m) => () => m)(i);
}
`,
  ],
  [
    "objects that leave and come back, unchanged and changed",
    `const a = { v: 1 }, b = { v: 2 };
let hold = a;
for (let i = 0; i < 30; i++) {
  hold = i % 3 === 0 ? b : i % 3 === 1 ? null : a;
  if (i % 5 === 0) b.v++;
}
`,
  ],
  [
    "more objects than a step records",
    `const nodes = [];
for (let i = 0; i < 2300; i++) nodes.push({ i });
nodes[5].i = -5;
let done = true;
`,
  ],
  [
    "a value changed and changed back between recorded steps",
    `const box = { n: 0 };
for (let i = 0; i < 200; i++) {
  box.n = 1;
  box.n = 0;
}
`,
  ],
];

const BENCH = fileURLToPath(new URL("../../bench/programs", import.meta.url));
const BENCH_JS = readdirSync(BENCH)
  .filter((f) => f.endsWith(".js"))
  .map((f) => [f, readFileSync(join(BENCH, f), "utf8")] as [string, string]);

/** What the page rebuilt for the step before (to check it's shared when the trace shares it). */
let lastBack: unknown = null;

function check(trace: Trace) {
  const fast = new HeapEncoder();
  const reference = new HeapEncoderReference();
  const expander = new HeapExpander();
  let prev: Trace["steps"][number] | null = null;
  trace.steps.forEach((step, i) => {
    const sent = JSON.stringify(fast.encode(step));
    expect(sent, `step ${i + 1} is sent as before`).toBe(JSON.stringify(reference.encode(step)));
    const back = expander.add(JSON.parse(sent));
    expect(Object.keys(back.heap), `step ${i + 1}'s objects, in order`).toEqual(Object.keys(step.heap));
    expect(sameData(back.heap, step.heap), `step ${i + 1}'s heap`).toBe(true);
    expect(sameData(back.stack, step.stack), `step ${i + 1}'s stack`).toBe(true);
    // An unchanged heap is the step before's, on the page as in the trace.
    if (prev && step.heap === prev.heap) expect(back.heap).toBe(lastBack);
    lastBack = back.heap;
    prev = step;
  });
}

describe("steps sent to the page, worked out from what the runtime says changed", () => {
  for (const [name, code] of AWKWARD)
    it(name, async () => check(await traceJavaScript(code, POLICY.maxSteps, 600)), 60_000);
  for (const [name, code] of BENCH_JS)
    it(`benchmark: ${name}`, async () => check(await traceJavaScript(code, POLICY.maxSteps, 600)), 120_000);
  for (const example of JAVASCRIPT_EXAMPLES)
    it(
      `JavaScript: ${example.name}`,
      async () => check(await traceJavaScript(example.code, POLICY.maxSteps, 600)),
      60_000,
    );
  for (const example of TYPESCRIPT_EXAMPLES)
    it(
      `TypeScript: ${example.name}`,
      async () => check(await traceTypeScript(example.code, POLICY.maxSteps, 600)),
      60_000,
    );
});
