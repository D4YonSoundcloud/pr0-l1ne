/**
 * The runner page's whole job: wait for the app to ask for a language,
 * check that it really is the app asking, start that language's worker and
 * hand it the app's data port. After that the page only reports the
 * worker's own errors (see sandbox/messages.ts for the handshake).
 *
 * One page runs one worker, for one connection: the app makes a fresh
 * iframe for each worker it starts, and removes it to stop one.
 */
import { type ControlMessage, isConnect, SANDBOX_VERSION, SANDBOXED_WORKER } from "../sandbox/messages";
import { originAllowed } from "../sandbox/origins";

/** What the relay needs from the page (a fake in tests). */
export interface RelayWindow {
  readonly parent: unknown;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface WorkerHandle {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface RelayOptions {
  win: RelayWindow;
  /** The pages that may connect (as for frame-ancestors: see sandbox/origins.ts). */
  allowed: readonly string[];
  /** A worker for each language, named SANDBOXED_WORKER so it waits for its port. */
  workers: Record<string, (name: string) => WorkerHandle>;
}

export function startRelay({ win, allowed, workers }: RelayOptions): void {
  let connected = false;
  win.addEventListener("message", (event) => {
    // Only the page that embeds this one, only from the app's sites, only once.
    if (connected || event.source !== win.parent || !originAllowed(event.origin, allowed)) return;
    const [control, data] = event.ports ?? [];
    if (!isConnect(event.data) || !control || !data) return;
    connected = true;
    const say = (message: ControlMessage) => control.postMessage(message);
    // Another version of the handshake: say which this is, and the app asks for a reload.
    if (event.data.version !== SANDBOX_VERSION) {
      say({ type: "hello", version: SANDBOX_VERSION });
      return;
    }
    const language = event.data.language;
    const make = Object.hasOwn(workers, language) ? workers[language] : null;
    if (!make) {
      say({ type: "error", message: `there's no runtime for "${language}" here` });
      return;
    }
    let worker: WorkerHandle;
    try {
      worker = make(SANDBOXED_WORKER);
    } catch (error) {
      say({ type: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    worker.onerror = (e) => {
      e.preventDefault();
      say({ type: "error", message: e.message || "the worker stopped unexpectedly" });
    };
    worker.postMessage({ type: "pr0l1ne:port" }, [data]);
    say({ type: "hello", version: SANDBOX_VERSION });
  });
}
