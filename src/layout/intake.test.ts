/**
 * A run's trace as it reaches the layout (intake.ts): its pieces put back
 * together as the whole trace, what had arrived when the run was stopped,
 * and every piece checked as it arrives, saying why one can't be used.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { traceJavaScript } from "../js/trace";
import { HeapEncoder } from "../trace/delta";
import type { Trace } from "../trace/types";
import type { TracePart } from "../worker/runner";
import { TraceIntake } from "./intake";

/** The first `sentSteps` steps in one piece (with the header), then the end with the rest. */
function parts(whole: Trace, sentSteps: number): { piece: TracePart; end: TracePart } {
  const encoder = new HeapEncoder();
  const { steps, stdout, counts, ...header } = whole;
  const sent = steps.slice(0, sentSteps).map((s) => encoder.encode(s));
  const rest = steps.slice(sentSteps).map((s) => encoder.encode(s));
  return {
    piece: { kind: "piece", json: JSON.stringify({ header, steps: sent, stdout, counts }) },
    end: { kind: "end", json: JSON.stringify({ trace: { ...header, steps: rest, stdout, counts, heapDelta: true } }) },
  };
}

describe("a trace reaching the layout", () => {
  let long: Trace;
  beforeAll(async () => {
    long = await traceJavaScript(
      "const xs = [];\nfor (let i = 0; i < 6; i++) xs.push({ i });\nconsole.log(xs.length);\n",
    );
  });

  it("is put back together from its pieces as the whole trace", () => {
    const intake = new TraceIntake();
    intake.begin();
    const { piece, end } = parts(long, 3);
    intake.feed(piece);
    intake.feed(end);
    const trace = intake.take("streamed", null)!;
    expect(trace.steps).toEqual(long.steps);
    expect(trace.stdout).toBe(long.stdout);
    expect(trace.heapDelta).toBeUndefined();
  });

  it("stopped: what had arrived, as a trace the person stopped; nothing, when nothing had", () => {
    const intake = new TraceIntake();
    intake.begin();
    intake.feed(parts(long, 2).piece);
    const trace = intake.take("stopped", null)!;
    expect(trace.steps).toEqual(long.steps.slice(0, 2));
    expect(trace).toMatchObject({ truncated: true, stoppedBy: "person", error: null });
    intake.begin();
    expect(intake.take("stopped", null)).toBeNull();
  });

  it("each piece is checked as it arrives: a heap object that doesn't fit the format ends the trace there", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const intake = new TraceIntake();
    intake.begin();
    const { piece, end } = parts(long, long.steps.length - 1);
    const bad = JSON.parse(piece.json);
    const sent = bad.steps.find((s: { heap: Record<string, { kind: string }> }) => Object.keys(s.heap).length);
    sent.heap[Object.keys(sent.heap)[0]].kind = "surprise";
    intake.feed({ kind: "piece", json: JSON.stringify(bad) });
    intake.feed(end);
    expect(() => intake.take("streamed", null)).toThrow(/doesn't match the trace format/);
    spy.mockRestore();
  });

  it("so is the trace around the steps, at the end", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const intake = new TraceIntake();
    intake.begin();
    const { piece, end } = parts(long, 2);
    intake.feed(piece);
    const tampered = JSON.parse(end.json);
    tampered.trace.surprise = true;
    intake.feed({ kind: "end", json: JSON.stringify(tampered) });
    expect(() => intake.take("streamed", null)).toThrow(/doesn't match the trace format.*surprise/);
    spy.mockRestore();
  });

  it("a piece that isn't JSON can't be used; an end that never came didn't arrive", () => {
    const intake = new TraceIntake();
    intake.begin();
    intake.feed({ kind: "piece", json: "{not json" });
    expect(() => intake.take("streamed", null)).toThrow(/isn't one the app can use/);
    intake.begin();
    intake.feed(parts(long, 2).piece);
    expect(() => intake.take("streamed", null)).toThrow(/didn't arrive/);
  });

  it("a trace sent whole (SQL's) is taken as it is", () => {
    const intake = new TraceIntake();
    expect(intake.take("whole", long)).toBe(long);
    expect(() => intake.take("whole", null)).toThrow(/didn't arrive/);
  });
});
