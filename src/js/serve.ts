/// <reference lib="webworker" />
/**
 * The worker side of the protocol, shared by the JavaScript and TypeScript
 * workers. Each worker is a one-line entry point, so each language's bundle
 * only contains what it needs (the TypeScript one adds Babel's core).
 */
import type { Trace } from "../trace/types";
import type { FromWorker, ToWorker } from "../worker/protocol";

export function serve(label: string, trace: (source: string, maxSteps: number) => Promise<Trace>): void {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  const post = (message: FromWorker) => ctx.postMessage(message);

  ctx.onmessage = async (event: MessageEvent<ToWorker>) => {
    const { runId, source, maxSteps } = event.data;
    const started = performance.now();
    try {
      post({ type: "result", runId, trace: await trace(source, maxSteps), elapsedMs: performance.now() - started });
    } catch (error) {
      post({ type: "crash", runId, message: error instanceof Error ? error.message : String(error) });
    }
  };

  // No interpreter to download: the browser already runs JavaScript.
  post({ type: "ready", label });
}
