/**
 * A language worker that runs on the runner's site, behind the same small
 * interface as a Worker (postMessage, onmessage, onerror, terminate), so
 * worker/runner.ts drives it exactly as it did a worker of the app's own.
 *
 * Each one is a hidden iframe of the runner page (sandbox/origins.ts says
 * where, and why another site), set up as sandbox/messages.ts describes.
 * Stopping it removes the iframe, which ends everything inside it, however
 * stuck: the worker, and the page.
 */
import type { FromWorker } from "../worker/protocol";
import { type Connect, isControlMessage, SANDBOX_VERSION } from "./messages";

/** What worker/runner.ts uses of a worker. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: { message: string; preventDefault?(): void }) => void) | null;
  terminate(): void;
}

/** The runner this build talks to (vite.config.ts works it out: see runnerUrlFor). */
export const RUNNER_URL: string = import.meta.env.VITE_RUNNER_URL ?? "http://127.0.0.1:5174/";

export interface SandboxOptions {
  /** The runner's address (its folder: runner.html is in it). */
  url?: string;
  /** Where the iframe goes (document, by default). */
  doc?: Document;
  /** How long the runner page may take to answer before it counts as not loading. */
  connectTimeoutMs?: number;
}

/** The page loads in a few hundred milliseconds; this is for a slow network. */
const CONNECT_TIMEOUT_MS = 20_000;

export class SandboxWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  readonly frame: HTMLIFrameElement;
  private readonly data = new MessageChannel();
  private readonly control = new MessageChannel();
  private readonly origin: string;
  private timer: ReturnType<typeof setTimeout> | null;
  private ended = false;

  constructor(
    private readonly language: string,
    options: SandboxOptions = {},
  ) {
    const doc = options.doc ?? document;
    const url = new URL("runner.html", options.url ?? RUNNER_URL);
    this.origin = url.origin;

    // What the worker says comes straight here; it can be posted to before
    // the worker has its end (messages wait in the port).
    this.data.port1.onmessage = (event: MessageEvent<FromWorker>) => {
      if (!this.ended) this.onmessage?.(event);
    };
    this.control.port1.onmessage = (event: MessageEvent) => this.fromRunner(event.data);

    const frame = doc.createElement("iframe");
    frame.className = "sandbox-frame";
    // Scripts only: no navigating this page, no popups, forms, dialogs or
    // downloads. allow-same-origin gives it its own origin (the runner's),
    // which its workers need; it's another site, so that's no way into ours.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("allow", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.title = "Code runner";
    frame.hidden = true;
    // Only the first load: if the page went somewhere else, nothing is sent there.
    frame.addEventListener("load", () => this.connect(), { once: true });
    frame.src = url.href;
    doc.body.append(frame);
    this.frame = frame;

    this.timer = setTimeout(
      () => this.failed("the code runner didn't answer"),
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
  }

  private connect(): void {
    if (this.ended) return;
    const message: Connect = { type: "pr0l1ne:connect", version: SANDBOX_VERSION, language: this.language };
    // To the runner's origin only: if anything else is in the frame, it never gets the ports.
    this.frame.contentWindow?.postMessage(message, this.origin, [this.control.port2, this.data.port2]);
  }

  private fromRunner(message: unknown): void {
    if (this.ended || !isControlMessage(message)) return;
    if (message.type === "error") {
      this.failed(message.message);
      return;
    }
    this.clearTimer();
    if (message.version !== SANDBOX_VERSION) {
      // A runner from another deploy: the runner says this means "reload the page".
      this.onmessage?.(new MessageEvent("message", { data: { type: "ready", label: "", protocolVersion: -1 } }));
    }
  }

  private failed(message: string): void {
    if (this.ended) return;
    this.clearTimer();
    this.onerror?.({ message });
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  postMessage(message: unknown): void {
    if (!this.ended) this.data.port1.postMessage(message);
  }

  terminate(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimer();
    this.data.port1.close();
    this.control.port1.close();
    this.frame.remove();
  }
}
