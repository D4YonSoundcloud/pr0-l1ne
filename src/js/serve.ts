/// <reference lib="webworker" />
/**
 * The worker side of the protocol, shared by the JavaScript and TypeScript
 * workers. Each worker is a one-line entry point, so each language's bundle
 * only contains what it needs (the TypeScript one adds Babel's core).
 */
import type { Measurement, MeasureProgress } from "../trace/measurement";
import type { SamplingPolicy } from "../trace/policy";
import type { Trace } from "../trace/types";
import type { FromWorker, ToWorker } from "../worker/protocol";

type Measure = (
  source: string,
  limitMs: number,
  report: (p: MeasureProgress) => void,
  overrides?: Record<string, number>,
) => Promise<Measurement>;

export function serve(
  label: string,
  trace: (source: string, maxSteps: number, maxSeconds: number, sampling: SamplingPolicy) => Promise<Trace>,
  measure: Measure,
): void {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  const post = (message: FromWorker) => ctx.postMessage(message);

  ctx.onmessage = async (event: MessageEvent<ToWorker>) => {
    if (event.data.type === "measure") {
      const { runId, source, limitMs, overrides } = event.data;
      try {
        const result = await measure(
          source,
          limitMs,
          (progress) => post({ type: "measureProgress", runId, progress }),
          overrides,
        );
        post({ type: "measured", runId, result });
      } catch (error) {
        post({ type: "crash", runId, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const { runId, source, maxSteps, maxSeconds, sampling } = event.data;
    const started = performance.now();
    try {
      post({
        type: "result",
        runId,
        trace: await trace(source, maxSteps, maxSeconds, sampling),
        elapsedMs: performance.now() - started,
      });
    } catch (error) {
      post({ type: "crash", runId, message: error instanceof Error ? error.message : String(error) });
    }
  };

  // No interpreter to download: the browser already runs JavaScript.
  post({ type: "ready", label });
}
