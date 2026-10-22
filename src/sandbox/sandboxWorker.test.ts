// @vitest-environment jsdom
/**
 * The app's side of the sandbox: a hidden iframe of the runner page, set
 * up over two ports, behind a Worker's interface. The runner page here is
 * played by the test, through the ports the app sends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FromWorker } from "../worker/protocol";
import { SANDBOX_VERSION } from "./messages";
import { SandboxWorker } from "./sandboxWorker";

const RUNNER = "https://runner.example/";

beforeEach(() => {
  // Only the timeout's timers: the ports deliver on the real event loop.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.useRealTimers();
});

/** Make one, let its iframe "load", and take the ports it sends the runner page. */
function start(language = "javascript") {
  const worker = new SandboxWorker(language, { url: RUNNER, connectTimeoutMs: 5000 });
  const posted: { message: unknown; origin: string; ports: MessagePort[] }[] = [];
  Object.defineProperty(worker.frame, "contentWindow", {
    value: {
      postMessage: (message: unknown, origin: string, ports: MessagePort[]) => posted.push({ message, origin, ports }),
    },
  });
  const messages: FromWorker[] = [];
  const errors: string[] = [];
  worker.onmessage = (e) => messages.push(e.data);
  worker.onerror = (e) => errors.push(e.message);
  const load = () => {
    worker.frame.dispatchEvent(new Event("load"));
    return posted[0];
  };
  return { worker, posted, messages, errors, load };
}

/** Let the ports deliver (Node's MessagePort works on the event loop, not the fake timers). */
const deliver = async () => {
  const later = (globalThis as unknown as { setImmediate(f: (v?: unknown) => void): void }).setImmediate;
  for (let i = 0; i < 5; i++) await new Promise((r) => later(r));
};

describe("SandboxWorker", () => {
  it("is a hidden, sandboxed iframe of the runner page", () => {
    const { worker } = start();
    const frame = worker.frame;
    expect(frame.isConnected).toBe(true);
    expect(frame.src).toBe(`${RUNNER}runner.html`);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.hidden).toBe(true);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.getAttribute("allow")).toBe("");
    worker.terminate();
  });

  it("asks the runner, at its origin only, for the language, and then talks to the worker", async () => {
    const { worker, messages, load } = start("python");
    worker.postMessage({ early: true }); // before the page has loaded: it waits in the port
    const sent = load();
    expect(sent.origin).toBe("https://runner.example");
    expect(sent.message).toEqual({ type: "pr0l1ne:connect", version: SANDBOX_VERSION, language: "python" });
    const [control, data] = sent.ports;
    const toWorker: unknown[] = [];
    data.onmessage = (e) => toWorker.push(e.data);
    control.postMessage({ type: "hello", version: SANDBOX_VERSION });
    data.postMessage({ type: "ready", label: "Python", protocolVersion: 1 });
    worker.postMessage({ late: true });
    await deliver();
    expect(toWorker).toEqual([{ early: true }, { late: true }]);
    expect(messages).toEqual([{ type: "ready", label: "Python", protocolVersion: 1 }]);
    // Answered: no timeout later.
    vi.advanceTimersByTime(10_000);
    worker.terminate();
  });

  it("reports a runner that never answers, and the runner's errors", async () => {
    const quiet = start();
    quiet.load();
    vi.advanceTimersByTime(5000);
    expect(quiet.errors).toEqual(["the code runner didn't answer"]);
    quiet.worker.terminate();

    const failing = start();
    const [control] = failing.load().ports;
    control.postMessage({ type: "error", message: "no runtime" });
    control.postMessage({ nonsense: true });
    await deliver();
    expect(failing.errors).toEqual(["no runtime"]);
    failing.worker.terminate();
  });

  it("treats a runner from another deploy like a worker of another version", async () => {
    const { worker, messages, load } = start();
    const [control] = load().ports;
    control.postMessage({ type: "hello", version: SANDBOX_VERSION + 1 });
    await deliver();
    expect(messages).toEqual([{ type: "ready", label: "", protocolVersion: -1 }]);
    worker.terminate();
  });

  it("stops by removing the iframe: nothing more arrives, nothing more is sent", async () => {
    const { worker, messages, errors, load } = start();
    const [control, data] = load().ports;
    worker.terminate();
    worker.terminate();
    expect(worker.frame.isConnected).toBe(false);
    data.postMessage({ type: "ready", label: "late", protocolVersion: 1 });
    control.postMessage({ type: "error", message: "late" });
    worker.postMessage({ ignored: true });
    await deliver();
    vi.advanceTimersByTime(10_000);
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
    // A load after stopping sends nothing.
    worker.frame.dispatchEvent(new Event("load"));
  });
});
