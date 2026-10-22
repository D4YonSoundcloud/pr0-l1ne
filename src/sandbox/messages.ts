/**
 * How the app and the runner page set up a run, before any code is sent.
 *
 *   app                                   runner page (iframe)          worker
 *   ── window.postMessage(connect, ──────▶ checks who sent it,
 *        to the runner's origin only,      starts the language's ─────▶ gets the data port:
 *        with two ports)                   worker, hands it the         everything about
 *                                          data port                    runs goes straight
 *   ◀── control port: hello / error ──────                              between it and the app
 *   ◀═══════════════ data port: the protocol (worker/protocol.ts) ════════════▶
 *
 * The data port goes to the worker itself, so traces aren't copied twice
 * on their way (worker -> page -> app). The control port stays with the
 * runner page, which reports what only it can see: that it's set up
 * (hello), or that the worker failed (error).
 */

/** The version of this handshake. Raise it whenever these messages change shape. */
export const SANDBOX_VERSION = 1;

/** The worker name that tells a worker it runs in the runner, and gets its port in its first message. */
export const SANDBOXED_WORKER = "pr0l1ne-sandboxed";

/** App -> runner page: run this language's worker. Carries [control port, data port]. */
export interface Connect {
  type: "pr0l1ne:connect";
  version: number;
  language: string;
}

/** Runner page -> worker: your port to the app. Carries [data port]. */
export interface PortMessage {
  type: "pr0l1ne:port";
}

/** Runner page -> app, on the control port. */
export type ControlMessage =
  /** Set up (or, with another version, a runner from another deploy). */
  | { type: "hello"; version: number }
  /** The worker couldn't start, or stopped with an error its own code didn't catch. */
  | { type: "error"; message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const isConnect = (value: unknown): value is Connect =>
  isObject(value) &&
  value.type === "pr0l1ne:connect" &&
  typeof value.version === "number" &&
  typeof value.language === "string";

export const isPortMessage = (value: unknown): value is PortMessage => isObject(value) && value.type === "pr0l1ne:port";

export const isControlMessage = (value: unknown): value is ControlMessage =>
  isObject(value) &&
  ((value.type === "hello" && typeof value.version === "number") ||
    (value.type === "error" && typeof value.message === "string"));
