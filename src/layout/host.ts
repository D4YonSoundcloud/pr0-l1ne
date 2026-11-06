/**
 * The layout worker's side of its messages (layout/protocol.ts): the
 * trace, prepared, and every window's scene and layout (layout/session.ts),
 * each drawing sent as a patch on the last one sent that window
 * (render/wire.ts). The worker (layout.worker.ts) answers its messages
 * with this; the tests run it in the page.
 */

import { perf, timed } from "../perf";
import type { Mark } from "../render/drawing";
import { MarkEncoder, type WireDrawing } from "../render/wire";
import type { Trace } from "../trace/types";
import { TraceIntake } from "./intake";
import type { FromLayout, PerfTimes, ToLayout } from "./protocol";
import { LayoutSession } from "./session";

/** Progress reports while preparing: about ten a second. */
const REPORT_EVERY_MS = 100;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A layout worker's state, answering through `post`. */
export function layoutHost(post: (message: FromLayout) => void): (message: ToLayout) => void {
  const session = new LayoutSession();
  /** Each window's encoder: what the page has of its last drawing. */
  const encoders = new Map<number, MarkEncoder>();
  /** The trace a run is sending, piece by piece. */
  const intake = new TraceIntake();

  /** The times recorded for this request, when asked for: sent back, and forgotten here. */
  function times(): { perf?: PerfTimes } {
    if (!perf.on) return {};
    const out: PerfTimes = [...perf.samples];
    perf.reset();
    return { perf: out };
  }

  function encoderFor(channel: number): MarkEncoder {
    let encoder = encoders.get(channel);
    if (!encoder) {
      encoder = new MarkEncoder();
      encoders.set(channel, encoder);
    }
    return encoder;
  }

  /** A drawing for the page: laid out in full to save it goes on its own (the window's drawing on screen stays as it is). */
  function wire(channel: number, drawing: Mark, full: boolean | undefined): WireDrawing {
    const encoder = full ? new MarkEncoder() : encoderFor(channel);
    const out = timed("wire.encode", () => encoder.encode(drawing));
    if (perf.on) {
      perf.record("wire.full", encoder.lastSent.full);
      perf.record("wire.kept", encoder.lastSent.kept);
      perf.record("wire.copied", encoder.lastSent.copied);
    }
    return out;
  }

  /** A question about the trace, answered. */
  function answer(message: Extract<ToLayout, { type: "changes" | "history" | "find" }>): FromLayout {
    switch (message.type) {
      case "changes":
        return { type: "changes", id: message.id, answer: session.changes(message.step) };
      case "history":
        return { type: "history", id: message.id, answer: session.history(message.target, message.at) };
      case "find":
        return {
          type: "find",
          id: message.id,
          answer: session.find(message.text, message.from, message.back, message.first),
        };
    }
  }

  function load(message: Extract<ToLayout, { type: "load" }>): void {
    let raw: Trace | null;
    try {
      raw = intake.take(message.how, message.trace ?? null);
    } catch (error) {
      post({ type: "loaded", load: message.load, info: null, error: errorText(error) });
      return;
    }
    // Stopped before anything arrived.
    if (!raw) {
      post({ type: "loaded", load: message.load, info: null });
      return;
    }
    try {
      const work = session.load(raw);
      let next = performance.now() + REPORT_EVERY_MS;
      let step = work.next();
      for (; !step.done; step = work.next()) {
        const now = performance.now();
        if (now < next) continue;
        next = now + REPORT_EVERY_MS;
        post({ type: "progress", load: message.load, progress: step.value });
      }
      post({ type: "loaded", load: message.load, info: step.value });
    } catch (error) {
      post({ type: "loaded", load: message.load, info: null, error: `the layout failed: ${errorText(error)}` });
    }
  }

  function handle(message: ToLayout): void {
    switch (message.type) {
      case "begin":
        intake.begin();
        return;
      case "feed":
        intake.feed(message.part);
        return;
      case "estimate":
        post({ type: "estimate", id: message.id, answer: session.estimate(message.measurement) });
        return;
      case "changes":
      case "history":
      case "find":
        try {
          post(answer(message));
        } catch (error) {
          console.error(`The layout worker (${message.type}):`, error);
          post(
            message.type === "changes"
              ? { type: "changes", id: message.id, answer: { changes: [], more: 0 } }
              : message.type === "history"
                ? { type: "history", id: message.id, answer: { name: "", points: [], truncated: false } }
                : { type: "find", id: message.id, answer: { step: null } },
          );
        }
        return;
      case "load":
        load(message);
        return;
      case "memory":
        perf.on = !!message.perf;
        try {
          const laidOut = timed("layout.memory", () => session.memory(message.channel, message.show, message.view));
          post({
            type: "memory",
            id: message.id,
            laidOut: laidOut && { ...laidOut, drawing: wire(message.channel, laidOut.drawing, message.view.full) },
            ...times(),
          });
        } catch (error) {
          post({ type: "memory", id: message.id, laidOut: null, error: errorText(error) });
        }
        return;
      case "loop":
        perf.on = !!message.perf;
        try {
          const laidOut = timed("layout.loop", () => session.loop(message.channel, message.show, message.view));
          post({
            type: "loop",
            id: message.id,
            laidOut: laidOut && {
              ...laidOut,
              drawing: laidOut.drawing && wire(message.channel, laidOut.drawing, message.view.full),
            },
            ...times(),
          });
        } catch (error) {
          post({ type: "loop", id: message.id, laidOut: null, error: errorText(error) });
        }
        return;
      case "reset":
        encoders.delete(message.channel);
        return;
      case "release":
        encoders.delete(message.channel);
        session.release(message.channel);
        return;
    }
  }

  return handle;
}
