/** How a worker talks to the app: straight back, or (in the runner) through the port it's handed. */
import { describe, expect, it, vi } from "vitest";
import { SANDBOXED_WORKER } from "../sandbox/messages";
import { workerChannel } from "./channel";
import type { FromWorker, ToWorker } from "./protocol";

const ready: FromWorker = { type: "ready", label: "JavaScript", protocolVersion: 1 };
const run = { type: "run", runId: 1 } as unknown as ToWorker;

function fakeScope(name: string) {
  return {
    name,
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
  };
}

describe("workerChannel", () => {
  it("started directly, talks to whoever started it", () => {
    const ctx = fakeScope("");
    const channel = workerChannel(ctx as unknown as DedicatedWorkerGlobalScope);
    const got: ToWorker[] = [];
    channel.listen((m) => got.push(m));
    channel.post(ready);
    expect(ctx.postMessage).toHaveBeenCalledWith(ready);
    ctx.onmessage?.({ data: run } as MessageEvent);
    expect(got).toEqual([run]);
  });

  it("in the runner, waits for its port, then uses only that", () => {
    const ctx = fakeScope(SANDBOXED_WORKER);
    const channel = workerChannel(ctx as unknown as DedicatedWorkerGlobalScope);
    const got: ToWorker[] = [];
    channel.listen((m) => got.push(m));
    channel.post(ready); // before the port: waits
    // Nothing but the port is listened to this way.
    ctx.onmessage?.({ data: run, ports: [] } as unknown as MessageEvent);
    expect(got).toEqual([]);
    const port = { postMessage: vi.fn(), onmessage: null as ((e: MessageEvent) => void) | null };
    ctx.onmessage?.({ data: { type: "pr0l1ne:port" }, ports: [port] } as unknown as MessageEvent);
    expect(port.postMessage).toHaveBeenCalledWith(ready);
    channel.post(ready);
    expect(port.postMessage).toHaveBeenCalledTimes(2);
    expect(ctx.postMessage).not.toHaveBeenCalled();
    port.onmessage?.({ data: run } as MessageEvent);
    expect(got).toEqual([run]);
    // A second port is ignored.
    const other = { postMessage: vi.fn(), onmessage: null };
    ctx.onmessage?.({ data: { type: "pr0l1ne:port" }, ports: [other] } as unknown as MessageEvent);
    channel.post(ready);
    expect(other.postMessage).not.toHaveBeenCalled();
  });
});
