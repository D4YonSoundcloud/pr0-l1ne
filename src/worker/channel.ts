/// <reference lib="webworker" />
/**
 * How a language worker talks to the app. In the runner (named
 * SANDBOXED_WORKER), the runner page's first message brings a port that
 * leads straight to the app; until it arrives, what the worker says waits.
 * Started any other way (a plain `new Worker`), it talks to whoever
 * started it, as a worker normally does.
 *
 * Either way, nothing here trusts the program being traced: it runs in this
 * same worker and could tamper with anything in it, including the trace.
 * That's why the app checks what arrives, and why the worker runs on a
 * site with nothing on it to reach (see sandbox/origins.ts).
 */
import { isPortMessage, SANDBOXED_WORKER } from "../sandbox/messages";
import type { FromWorker, ToWorker } from "./protocol";

export interface WorkerChannel {
  post(message: FromWorker): void;
  /** Called with each message from the app. */
  listen(handler: (message: ToWorker) => void): void;
}

export function workerChannel(ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope) {
  const sandboxed = ctx.name === SANDBOXED_WORKER;
  let port: MessagePort | null = null;
  const waiting: FromWorker[] = [];
  let handler: ((message: ToWorker) => void) | null = null;

  ctx.onmessage = (event: MessageEvent) => {
    if (!sandboxed) {
      handler?.(event.data as ToWorker);
      return;
    }
    // Sandboxed, the only message that comes this way is the port, once.
    if (port || !isPortMessage(event.data) || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = (e: MessageEvent<ToWorker>) => handler?.(e.data);
    for (const message of waiting.splice(0)) port.postMessage(message);
  };

  const channel: WorkerChannel = {
    post(message) {
      if (!sandboxed) ctx.postMessage(message);
      else if (port) port.postMessage(message);
      else waiting.push(message);
    },
    listen(h) {
      handler = h;
    },
  };
  return channel;
}
