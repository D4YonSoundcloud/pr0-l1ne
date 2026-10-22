/**
 * The runner page's relay, with a fake page and fake workers: it starts a
 * worker only for the app, only once, and hands the worker its port.
 */
import { describe, expect, it, vi } from "vitest";
import { SANDBOX_VERSION, SANDBOXED_WORKER } from "../sandbox/messages";
import { type RelayWindow, startRelay, type WorkerHandle } from "./relay";

const APP = "https://pr0l1ne.com";

function setup() {
  const parent = {};
  let listener: ((event: MessageEvent) => void) | null = null;
  const win: RelayWindow = {
    parent,
    addEventListener: (_type, l) => {
      listener = l;
    },
  };
  const made: { name: string; worker: WorkerHandle & { sent: unknown[]; transfers: Transferable[][] } }[] = [];
  const make = (name: string) => {
    const worker = {
      onerror: null,
      sent: [] as unknown[],
      transfers: [] as Transferable[][],
      postMessage(message: unknown, transfer: Transferable[]) {
        this.sent.push(message);
        this.transfers.push(transfer);
      },
    };
    made.push({ name, worker });
    return worker;
  };
  startRelay({ win, allowed: [APP], workers: { javascript: make } });
  const said: unknown[] = [];
  const connect = (data: unknown, { origin = APP, source = parent as unknown, ports = 2 } = {}) => {
    const control = { postMessage: (m: unknown) => said.push(m) } as unknown as MessagePort;
    const dataPort = {} as MessagePort;
    listener?.({ data, origin, source, ports: [control, dataPort].slice(0, ports) } as unknown as MessageEvent);
    return dataPort;
  };
  return { made, said, connect };
}

const hello = (language = "javascript", version = SANDBOX_VERSION) => ({ type: "pr0l1ne:connect", version, language });

describe("startRelay", () => {
  it("starts the language's worker for the app, and hands it the data port", () => {
    const { made, said, connect } = setup();
    const port = connect(hello());
    expect(made).toHaveLength(1);
    expect(made[0].name).toBe(SANDBOXED_WORKER);
    expect(made[0].worker.sent).toEqual([{ type: "pr0l1ne:port" }]);
    expect(made[0].worker.transfers[0]).toEqual([port]);
    expect(said).toEqual([{ type: "hello", version: SANDBOX_VERSION }]);
  });

  it("ignores anyone but the page above it on the app's site, messages that aren't a connect, and a second connect", () => {
    const { made, connect } = setup();
    connect(hello(), { origin: "https://evil.com" });
    connect(hello(), { source: {} });
    connect(hello(), { ports: 1 });
    connect({ type: "something else" });
    expect(made).toHaveLength(0);
    connect(hello());
    connect(hello());
    expect(made).toHaveLength(1);
  });

  it("says its version to an app from another deploy, and starts nothing", () => {
    const { made, said, connect } = setup();
    connect(hello("javascript", SANDBOX_VERSION + 1));
    expect(made).toHaveLength(0);
    expect(said).toEqual([{ type: "hello", version: SANDBOX_VERSION }]);
  });

  it("reports a language it doesn't have, and the worker's own errors", () => {
    const a = setup();
    a.connect(hello("cobol"));
    expect(a.said).toEqual([{ type: "error", message: `there's no runtime for "cobol" here` }]);
    // Not even through the prototype.
    const b = setup();
    b.connect(hello("toString"));
    expect(b.made).toHaveLength(0);

    const c = setup();
    c.connect(hello());
    const preventDefault = vi.fn();
    c.made[0].worker.onerror?.({ message: "boom", preventDefault } as unknown as ErrorEvent);
    c.made[0].worker.onerror?.({ message: "", preventDefault } as unknown as ErrorEvent);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(c.said.slice(1)).toEqual([
      { type: "error", message: "boom" },
      { type: "error", message: "the worker stopped unexpectedly" },
    ]);
  });

  it("reports a worker that couldn't be made", () => {
    const heard: { listener?: (event: MessageEvent) => void } = {};
    const parent = {};
    startRelay({
      win: {
        parent,
        addEventListener: (_t, l) => {
          heard.listener = l;
        },
      },
      allowed: [APP],
      workers: {
        python: () => {
          throw new Error("no workers here");
        },
      },
    });
    const said: unknown[] = [];
    const control = { postMessage: (m: unknown) => said.push(m) };
    heard.listener?.({
      data: hello("python"),
      origin: APP,
      source: parent,
      ports: [control, {}],
    } as unknown as MessageEvent);
    expect(said).toEqual([{ type: "error", message: "no workers here" }]);
  });
});
