/**
 * The benchmark, outside the browser: each program in bench/programs
 * traced (JavaScript in-process, Python with the real tracer in CPython),
 * then a few of its steps drawn, timing each stage (src/perf.ts). See
 * bench/README.md.
 *
 *   npx tsx scripts/bench.ts                    print the numbers
 *   npx tsx scripts/bench.ts --save baseline    and keep them in bench/results/baseline.json
 *   npx tsx scripts/bench.ts --compare baseline print them beside a saved run
 *   npx tsx scripts/bench.ts --only grid        programs whose name has "grid"
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serialize } from "node:v8";
import { traceJavaScript } from "../src/js/trace";
import { perf, traceStats } from "../src/perf";
import { descendants } from "../src/render/drawing";
import { loopDrawing } from "../src/render/loopView";
import { memoryDrawing } from "../src/render/memory";
import { loopScene } from "../src/scene/loopScene";
import { memoryScene } from "../src/scene/memoryScene";
import { expandHeaps } from "../src/trace/delta";
import { diffSteps } from "../src/trace/diff";
import { applyHints } from "../src/trace/hints";
import { buildLoopHistory, buildNestedHistory } from "../src/trace/loopHistory";
import { POLICY } from "../src/trace/policy";
import type { Trace } from "../src/trace/types";

const ROOT = new URL("..", import.meta.url).pathname;
const PROGRAMS = join(ROOT, "bench/programs");
const RESULTS = join(ROOT, "bench/results");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** How many steps of each program to draw (spread through the run, plus the one with the most objects). */
const DRAWN_STEPS = 6;

interface Result {
  program: string;
  trace: ReturnType<typeof traceStats> & { ms: number; parseMs: number; size: number };
  hintsMs: number;
  /** Median per stage over the steps drawn, and the biggest drawing's size in marks. */
  stages: Record<string, number>;
  marks: { arrows: number; nested: number };
}

const median = (list: number[]) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Python, as the page gets it: the tracer's JSON (heaps as deltas), parsed,
 * then heaps rebuilt. `ms` is the tracer alone (timed inside Python, so
 * starting Python isn't counted); `parseMs` reading its JSON and rebuilding.
 */
function tracePython(source: string): Traced {
  const script = `
import sys, time
sys.path.insert(0, ${JSON.stringify(join(ROOT, "src/worker"))})
from tracer import run_trace
source = sys.stdin.read()
start = time.perf_counter()
out = run_trace(source, ${POLICY.maxSteps}, ${POLICY.runSeconds}, ${JSON.stringify(JSON.stringify(POLICY.sampling))})
sys.stderr.write("TRACE_MS %f\\n" % ((time.perf_counter() - start) * 1000))
sys.stdout.write(out)`;
  const result = spawnSync("python3", ["-c", script], { input: source, encoding: "utf8", maxBuffer: 1 << 30 });
  const ms = Number(/TRACE_MS ([\d.]+)/.exec(result.stderr)?.[1] ?? Number.NaN);
  const out = result.stdout;
  const start = performance.now();
  const trace = expandHeaps(JSON.parse(out) as Trace);
  return { trace, ms, parseMs: performance.now() - start, size: out.length };
}

interface Traced {
  trace: Trace;
  ms: number;
  /** Python: reading the tracer's JSON and rebuilding heaps. */
  parseMs: number;
  /** What crosses from the tracer to the page: Python's JSON, or the structured clone of a JavaScript trace. */
  size: number;
}

async function traceOf(file: string, source: string): Promise<Traced> {
  if (file.endsWith(".py")) return tracePython(source);
  const start = performance.now();
  const trace = await traceJavaScript(source, POLICY.maxSteps, POLICY.runSeconds, POLICY.sampling);
  return { trace, ms: performance.now() - start, parseMs: 0, size: serialize(trace).length };
}

async function bench(file: string): Promise<Result> {
  const source = readFileSync(join(PROGRAMS, file), "utf8");
  const { trace: raw, ms, parseMs, size } = await traceOf(file, source);
  const hintsStart = performance.now();
  const trace = applyHints(raw);
  const hintsMs = performance.now() - hintsStart;

  // The steps drawn: spread through the run, and the one with the most objects.
  const n = trace.steps.length;
  const picks = new Set<number>();
  for (let k = 1; k <= DRAWN_STEPS - 1; k++)
    picks.add(Math.min(n - 1, Math.max(1, Math.round((k * (n - 1)) / DRAWN_STEPS))));
  let most = 0;
  trace.steps.forEach((s, i) => {
    if (Object.keys(s.heap).length > Object.keys(trace.steps[most].heap).length) most = i;
  });
  picks.add(Math.max(1, most));

  perf.on = true;
  perf.reset();
  const marks = { arrows: 0, nested: 0 };
  for (const i of picks) {
    const diff = diffSteps(trace.steps[i - 1], trace.steps[i]);
    for (const mode of ["arrows", "nested"] as const) {
      const start = performance.now();
      const scene = memoryScene(trace, i, diff, { mode });
      perf.record(`memory.scene.${mode}`, performance.now() - start);
      const before = perf.samples.get("memory.layout")?.length ?? 0;
      const drawing = memoryDrawing(scene);
      const layoutMs = perf.samples.get("memory.layout")![before];
      perf.record(`memory.layout.${mode}`, layoutMs);
      marks[mode] = Math.max(marks[mode], descendants(drawing).length);
    }
    const historyStart = performance.now();
    const history = buildNestedHistory(trace, i) ?? buildLoopHistory(trace, i, null);
    perf.record("loop.history", performance.now() - historyStart);
    if (history) {
      const sceneStart = performance.now();
      const scene = loopScene(trace, history, { hideQuiet: true });
      perf.record("loop.scene", performance.now() - sceneStart);
      loopDrawing(scene);
    }
  }
  perf.on = false;
  const stages: Record<string, number> = {};
  for (const [stage, list] of perf.samples) if (stage !== "memory.layout") stages[stage] = median(list);
  return { program: file, trace: { ...traceStats(trace), ms, parseMs, size }, hintsMs, stages, marks };
}

const f = (n: number | undefined, digits = 0) => (n === undefined ? "–" : n.toFixed(digits));
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

function table(results: Result[], against?: Result[]): string {
  const old = new Map(against?.map((r) => [r.program, r]));
  const vs = (now: number, before: number | undefined, digits = 0) =>
    before === undefined ? f(now, digits) : `${f(now, digits)} (was ${f(before, digits)})`;
  const lines = [
    "| Program | Trace | Read it | Steps (ran) | Objects: most / mean | Trace size | Scene arrows / nested | Layout arrows / nested | Routing | Loop history + layout | Marks arrows / nested |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    const o = old.get(r.program);
    const t = r.trace;
    const s = r.stages;
    const os = o?.stages ?? {};
    lines.push(
      `| ${r.program} | ${vs(t.ms, o?.trace.ms)} ms${t.truncated ? ` (stopped: ${t.stoppedBy})` : ""} | ${t.parseMs ? `${vs(t.parseMs, o?.trace.parseMs)} ms` : "–"} | ${t.steps} (${t.ran}) | ${t.maxHeap} / ${t.meanHeap}${o ? ` (was ${o.trace.maxHeap} / ${o.trace.meanHeap})` : ""} | ${mb(t.size)}${o ? ` (was ${mb(o.trace.size)})` : ""} | ${f(s["memory.scene.arrows"], 1)} / ${f(s["memory.scene.nested"], 1)} ms | ${vs(s["memory.layout.arrows"], os["memory.layout.arrows"])} / ${vs(s["memory.layout.nested"], os["memory.layout.nested"])} ms | ${vs(s["memory.route"], os["memory.route"])} ms | ${f((s["loop.history"] ?? 0) + (s["loop.scene"] ?? 0), 1)} + ${f(s["loop.layout"], 1)} ms | ${r.marks.arrows} / ${r.marks.nested} |`,
    );
  }
  return lines.join("\n");
}

const only = arg("only");
const files = readdirSync(PROGRAMS)
  .filter((name) => /\.(js|py)$/.test(name) && (!only || name.includes(only)))
  .sort();
const results: Result[] = [];
for (const file of files) {
  process.stderr.write(`${file}…\n`);
  results.push(await bench(file));
}
const compare = arg("compare");
const against = compare ? (JSON.parse(readFileSync(join(RESULTS, `${compare}.json`), "utf8")) as Result[]) : undefined;
console.log(table(results, against));
const save = arg("save");
if (save) writeFileSync(join(RESULTS, `${save}.json`), `${JSON.stringify(results, null, 2)}\n`);
