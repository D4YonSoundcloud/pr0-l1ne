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
import { TraceStream } from "../trace/stream";
import type { Trace } from "../trace/types";
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
  let stream: TraceStream | null = null;
  /** The streamed trace, once it's all arrived. */
  let finished: Trace | null = null;

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
    }
    return out;
  }

  function load(message: Extract<ToLayout, { type: "load" }>): void {
    let raw: Trace | null = null;
    try {
      raw =
        message.how === "whole"
          ? (message.trace ?? null)
          : message.how === "stopped"
            ? (stream?.partial() ?? null)
            : finished;
    } catch (error) {
      post({ type: "loaded", load: message.load, ok: false, error: errorText(error) });
      return;
    }
    stream = null;
    finished = null;
    if (!raw) {
      post({ type: "loaded", load: message.load, ok: false, error: "the trace didn't arrive" });
      return;
    }
    try {
      const work = session.load(raw);
      let next = performance.now() + REPORT_EVERY_MS;
      for (let step = work.next(); !step.done; step = work.next()) {
        const now = performance.now();
        if (now < next) continue;
        next = now + REPORT_EVERY_MS;
        post({ type: "progress", load: message.load, progress: step.value });
      }
      post({ type: "loaded", load: message.load, ok: true });
    } catch (error) {
      post({ type: "loaded", load: message.load, ok: false, error: errorText(error) });
    }
  }

  function handle(message: ToLayout): void {
    switch (message.type) {
      case "begin":
        stream = new TraceStream();
        finished = null;
        return;
      case "feed":
        if (!stream) return;
        try {
          if (message.part.kind === "piece") stream.add(message.part.json);
          else finished = stream.finish(message.part.json);
        } catch {
          // The page checked the same piece first, and ends the run if it's wrong.
          stream = null;
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
