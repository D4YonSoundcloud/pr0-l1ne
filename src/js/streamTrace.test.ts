/**
 * A JavaScript run sent a piece at a time (streamTrace.ts) and put back
 * together on the page (trace/stream.ts): the same trace as tracing it
 * whole, and when stopped, the steps that had arrived, as a trace stopped
 * by the person.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POLICY } from "../trace/policy";
import { TraceStream } from "../trace/stream";
import type { FromWorker } from "../worker/protocol";
import { Runtime } from "./runtime";
import { streamTrace } from "./streamTrace";
import { traceJavaScript } from "./trace";

const CODE = `const nums = [];
let total = 0;
for (let i = 0; i < 400; i++) {
  nums.push(i % 7);
  total += i;
  if (i % 100 === 0) console.log("at", i);
}
const pairs = new Map();
pairs.set("a", nums.slice(0, 3));
console.log(total);
`;

const run = (code: string) => ({
  runId: 7,
  source: code,
  maxSteps: POLICY.maxSteps,
  maxSeconds: 6,
  sampling: POLICY.sampling,
});

/** Every message a run sends, with pieces as often as can be. */
async function messages(code: string): Promise<FromWorker[]> {
  const out: FromWorker[] = [];
  await streamTrace(traceJavaScript, run(code), (m) => out.push(m), 0);
  return out;
}

describe("streaming a JavaScript trace", () => {
  let every: number;
  beforeEach(() => {
    every = Runtime.reportEveryMs;
    Runtime.reportEveryMs = 0; // a report at every chance
  });
  afterEach(() => {
    Runtime.reportEveryMs = every;
  });

  it("puts back together the same trace as tracing it whole", async () => {
    const sent = await messages(CODE);
    const progress = sent.filter((m) => m.type === "progress");
    expect(progress.length).toBeGreaterThan(5);
    const stream = new TraceStream();
    for (const m of progress) stream.add(m.json);
    expect(stream.received).toBeGreaterThan(0);
    const end = sent.at(-1)!;
    expect(end.type).toBe("streamed");
    const trace = stream.finish((end as Extract<FromWorker, { type: "streamed" }>).json);
    const whole = await traceJavaScript(CODE, POLICY.maxSteps, 6, POLICY.sampling);
    expect(JSON.stringify(trace)).toBe(JSON.stringify(whole));
    // Unchanged objects are shared from step to step, as in a trace made whole.
    const a = trace.steps.at(-2)!.heap;
    const b = trace.steps.at(-1)!.heap;
    const shared = Object.keys(b).filter((id) => a[id] === b[id]);
    expect(shared.length).toBeGreaterThan(0);
  });

  it("says how far it's got: steps recorded, seconds, the line running", async () => {
    const reports = (await messages(CODE))
      .filter((m) => m.type === "progress")
      .map((m) => JSON.parse(m.json).progress as { steps: number; seconds: number; line: number });
    const steps = reports.map((r) => r.steps);
    expect(steps).toEqual([...steps].sort((x, y) => x - y));
    for (const r of reports) {
      expect(r.seconds).toBeGreaterThanOrEqual(0);
      expect(r.line).toBeGreaterThanOrEqual(0);
      expect(r.line).toBeLessThanOrEqual(10);
    }
  });

  it("stopped part way, is the steps that had arrived, as a trace the person stopped", async () => {
    const sent = (await messages(CODE)).filter((m) => m.type === "progress");
    const stream = new TraceStream();
    for (const m of sent.slice(0, Math.floor(sent.length / 2))) stream.add(m.json);
    const partial = stream.partial()!;
    expect(partial.truncated).toBe(true);
    expect(partial.stoppedBy).toBe("person");
    expect(partial.steps.length).toBe(stream.received);
    expect(partial.loops.length).toBe(1);
    const whole = await traceJavaScript(CODE, POLICY.maxSteps, 6, POLICY.sampling);
    // The same steps as the whole trace's first ones.
    expect(JSON.stringify(partial.steps)).toBe(JSON.stringify(whole.steps.slice(0, partial.steps.length)));
    expect(whole.stdout.startsWith(partial.stdout)).toBe(true);
    // Nothing had arrived: no trace.
    expect(new TraceStream().partial()).toBeNull();
  });

  it("refuses a piece that isn't one", () => {
    const stream = new TraceStream();
    expect(() => stream.add("{}")).toThrow();
    expect(() => stream.add('{"progress":{"steps":1,"seconds":0,"line":1},"chunk":{"steps":5,"stdout":""}}')).toThrow();
    expect(() =>
      stream.add(
        '{"progress":{"steps":1,"seconds":0,"line":1},"chunk":{"steps":[{"heap":{"__proto__":{}},"stack":[],"heapIds":["__proto__"]}],"stdout":""}}',
      ),
    ).toThrow();
  });
});
