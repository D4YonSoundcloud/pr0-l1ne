/**
 * A JavaScript or TypeScript run for the page to watch (js/serve.ts): every
 * quarter second how far it's got, with the steps recorded
 * since the last piece (as deltas, trace/delta.ts HeapEncoder), what the
 * program printed since and its counts; the first piece with the trace's
 * header; and at the end the rest. Progress and pieces go separately: the
 * page reads the progress, and passes the pieces on to the layout worker,
 * which rebuilds the trace as it arrives (trace/stream.ts) and keeps what
 * had come if the person stops the run. Python's tracer does the same
 * (worker/tracer.py report_progress).
 */
import { HeapEncoder } from "../trace/delta";
import type { SamplingPolicy } from "../trace/policy";
import type { TracePiece } from "../trace/stream";
import type { Trace } from "../trace/types";
import type { FromWorker } from "../worker/protocol";
import type { TraceSoFar } from "./trace";

export type TraceFn = (
  source: string,
  maxSteps: number,
  maxSeconds: number,
  sampling: SamplingPolicy,
  onProgress?: (state: TraceSoFar) => void,
) => Promise<Trace>;

/** A sent step's heap, once let go (see `piece`). */
const SENT: Trace["steps"][number]["heap"] = Object.freeze({}) as Trace["steps"][number]["heap"];

/**
 * Milliseconds between the pieces of the trace sent with the progress
 * reports: as often as they are, so each piece is small, and checking and
 * rebuilding it is a short task for the page while the program runs.
 */
export const PIECE_EVERY_MS = 250;

/** Run `trace` on a run message, sending progress, the pieces and the rest with `post`. */
export async function streamTrace(
  trace: TraceFn,
  message: { runId: number; source: string; maxSteps: number; maxSeconds: number; sampling: SamplingPolicy },
  post: (message: FromWorker) => void,
  pieceEveryMs = PIECE_EVERY_MS,
): Promise<void> {
  const { runId, source, maxSteps, maxSeconds, sampling } = message;
  const started = performance.now();
  const encoder = new HeapEncoder();
  let sent = 0;
  let sentStdout = 0;
  let headerSent = false;
  let nextPiece = pieceEveryMs;
  const piece = (state: TraceSoFar): TracePiece => {
    const fresh = state.steps.slice(sent);
    const chunk: TracePiece = {
      steps: fresh.map((step) => encoder.encode(step)),
      stdout: state.stdout.slice(sentStdout),
      counts: state.counts,
    };
    if (!headerSent) {
      headerSent = true;
      const { steps: _steps, stdout: _stdout, counts: _counts, ...header } = state.header;
      chunk.header = { ...header, heapDelta: true };
    }
    sent = state.steps.length;
    sentStdout = state.stdout.length;
    // Sent: the page has these steps' heaps now, and nothing here reads them again (the runtime keeps
    // the last heap it committed itself, and the encoder the one it last sent), so they go, and the
    // worker holds only what it hasn't sent. A step's heap is most of what a long run keeps.
    for (const step of fresh) step.heap = SENT;
    return chunk;
  };
  const done = await trace(source, maxSteps, maxSeconds, sampling, (state) => {
    const progress = { steps: state.steps.length, seconds: state.elapsedMs / 1000, line: state.line };
    if (state.elapsedMs >= nextPiece) {
      nextPiece = state.elapsedMs + pieceEveryMs;
      post({ type: "progress", runId, progress, piece: JSON.stringify(piece(state)) });
    } else post({ type: "progress", runId, progress });
  });
  // The rest: the steps no piece sent, as deltas following on from them.
  const steps = done.steps;
  const rest: Trace = { ...done, steps: steps.slice(sent).map((step) => encoder.encode(step)), heapDelta: true };
  const last = steps[steps.length - 1];
  const end = {
    trace: rest,
    ...(sent && sent === steps.length && last?.skippedAfter ? { skippedAfter: last.skippedAfter } : {}),
  };
  post({ type: "streamed", runId, json: JSON.stringify(end), elapsedMs: performance.now() - started });
}
