/**
 * Marks held to reading everything (js/marks.ts, js/runtime.ts): every
 * write form in the catalogue (writeCatalogue.ts), every example, every
 * benchmark program and a few awkward ones, traced with marks and without.
 * The two traces must be the same at every step, sent the same way (so
 * objects are shared alike), and the in-run check must find nothing. Then
 * a write marks can't see, which only the check can catch.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, TYPESCRIPT_EXAMPLES } from "../examples";
import { HeapEncoderReference } from "../testing/heapEncoderReference";
import { goldenText } from "../trace/golden";
import { POLICY } from "../trace/policy";
import type { Trace } from "../trace/types";
import type { TracerOptions } from "./runtime";
import { traceJavaScript } from "./trace";
import { traceTypeScript } from "./typescript";
import { HIDDEN_WRITE, WRITE_FORMS } from "./writeCatalogue";

const BENCH = fileURLToPath(new URL("../../bench/programs", import.meta.url));
const BENCH_JS = readdirSync(BENCH)
  .filter((f) => f.endsWith(".js"))
  .map((f) => [f, readFileSync(`${BENCH}/${f}`, "utf8")] as [string, string]);
const AWKWARD = [
  ...readFileSync(fileURLToPath(new URL("./encodeSteps.test.ts", import.meta.url)), "utf8").matchAll(
    /\[\s*"([^"]+)",\s*`([\s\S]*?)`,\s*\]/g,
  ),
].map((m) => [m[1], m[2]] as [string, string]);

type Tracer = (code: string, options: TracerOptions) => Promise<Trace>;
const js: Tracer = (code, options) => traceJavaScript(code, POLICY.maxSteps, 600, POLICY.sampling, undefined, options);
const ts: Tracer = (code, options) => traceTypeScript(code, POLICY.maxSteps, 600, POLICY.sampling, undefined, options);

/** Every step as sent: values, and which objects are shared with the step before. */
function sent(trace: Trace): string[] {
  const encoder = new HeapEncoderReference();
  return trace.steps.map((step) => JSON.stringify(encoder.encode(step)));
}

async function bothWays(trace: Tracer, code: string) {
  // The in-run check only at the end, so a missed write shows here as a difference, not a quiet fix.
  const marked = await trace(code, { marks: true, checkEvery: 1e9 });
  const read = await trace(code, { marks: false });
  expect(marked.selfCheck, "the in-run check found nothing").toBeUndefined();
  expect(goldenText(marked), "the same trace").toBe(goldenText(read));
  const a = sent(marked);
  const b = sent(read);
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i], `step ${i + 1}, as sent`).toBe(b[i]);
}

describe("marks read the same as reading everything", () => {
  for (const form of WRITE_FORMS) it(`write: ${form.name}`, () => bothWays(js, form.code), 60_000);
  for (const [name, code] of AWKWARD) it(`awkward: ${name}`, () => bothWays(js, code), 60_000);
  for (const [name, code] of BENCH_JS) it(`benchmark: ${name}`, () => bothWays(js, code), 180_000);
  for (const example of JAVASCRIPT_EXAMPLES)
    it(`JavaScript: ${example.name}`, () => bothWays(js, example.code), 60_000);
  for (const example of TYPESCRIPT_EXAMPLES)
    it(`TypeScript: ${example.name}`, () => bothWays(ts, example.code), 60_000);
});

describe("the in-run check", () => {
  it("catches a write marks can't see, says so, and reads everything from then on", async () => {
    const read = await js(HIDDEN_WRITE, { marks: false });
    // Checked every step: caught at the step after the write, and so every step is right.
    const every = await js(HIDDEN_WRITE, { marks: true, checkEvery: 1 });
    expect(every.selfCheck).toMatch(/^marks missed a write to an object by step \d+, line \d+: o\d+ \(Object\)$/);
    const { selfCheck: _, ...steps } = every;
    expect(goldenText(steps as Trace)).toBe(goldenText(read));
    // Checked only as the program ends (as by default, past 500 steps): caught then.
    const late = await js(HIDDEN_WRITE, { marks: true, checkEvery: 1e9 });
    expect(late.selfCheck).toMatch(/^marks missed a write/);
  });

  it("finds nothing on a program marks follow", async () => {
    expect((await js(WRITE_FORMS[0].code, { marks: true, checkEvery: 1 })).selfCheck).toBeUndefined();
  });
});
