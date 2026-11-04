/** Counting a runtime's bytes as the worker fetches them (worker/downloads.ts). */
import { describe, expect, it } from "vitest";
import { type DownloadProgress, fileNameOf, meterDownloads } from "./downloads";

describe("file names", () => {
  it("are the names the build started from, without their content hash", () => {
    expect(fileNameOf("https://run.example/assets/pglite-CKQGo6A1.wasm")).toBe("pglite.wasm");
    expect(fileNameOf("https://run.example/assets/libpg-query-GCP7UsPj.wasm?v=1")).toBe("libpg-query.wasm");
    expect(fileNameOf("https://run.example/pyodide/0.27.8/pyodide.asm.wasm")).toBe("pyodide.asm.wasm");
    expect(fileNameOf("https://run.example/pyodide/0.27.8/pyodide-lock.json")).toBe("pyodide-lock.json");
  });
});

/** A fetch whose responses stream `size` bytes in pieces. */
function fakeFetch(files: Record<string, { size: number; headers?: Record<string, string> }>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const name = Object.keys(files).find((f) => url.endsWith(f));
    if (!name) return new Response("nothing here", { status: 404 });
    const { size, headers } = files[name];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < size; sent += 1000) controller.enqueue(new Uint8Array(Math.min(1000, size - sent)));
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/wasm", ...headers } });
  };
}

describe("meterDownloads", () => {
  it("counts each file's bytes against its size, and reports the first piece and when each file is done", async () => {
    const scope = {
      fetch: fakeFetch({ "a.wasm": { size: 3000 }, "b-12345678.data": { size: 1000 }, "other.js": { size: 10 } }),
    };
    const original = scope.fetch;
    const seen: DownloadProgress[] = [];
    const unmeter = meterDownloads(["a.wasm", "b.data"], (p) => seen.push(p), {
      scope,
      sizes: { "a.wasm": 3000, "b.data": 1000 },
      everyMs: Number.POSITIVE_INFINITY, // between, never
    });
    const a = await scope.fetch("https://run.example/a.wasm");
    expect(a.headers.get("Content-Type")).toBe("application/wasm"); // kept, for WebAssembly's streaming compile
    expect((await a.arrayBuffer()).byteLength).toBe(3000);
    await (await scope.fetch("https://run.example/assets/b-12345678.data")).arrayBuffer();
    await (await scope.fetch("https://run.example/other.js")).text(); // not one of them: not counted
    expect(seen).toEqual([
      { loaded: 1000, total: 4000 }, // the first piece, at once
      { loaded: 3000, total: 4000 },
      { loaded: 4000, total: 4000 },
    ]);
    unmeter();
    expect(scope.fetch).toBe(original);
  });

  it("without a size from the build, goes by the response's own (when it isn't compressed)", async () => {
    const scope = { fetch: fakeFetch({ "a.wasm": { size: 2000, headers: { "Content-Length": "2000" } } }) };
    const seen: DownloadProgress[] = [];
    meterDownloads(["a.wasm"], (p) => seen.push(p), { scope, sizes: {}, everyMs: 0, now: () => 0 });
    await (await scope.fetch("https://run.example/a.wasm")).arrayBuffer();
    expect(seen[0]).toEqual({ loaded: 1000, total: 2000 });
    expect(seen.at(-1)).toEqual({ loaded: 2000, total: 2000 });
  });

  it("reports at most every so often while a file streams in", async () => {
    let clock = 0;
    const scope = { fetch: fakeFetch({ "a.wasm": { size: 10_000 } }) };
    const seen: DownloadProgress[] = [];
    meterDownloads(["a.wasm"], (p) => seen.push(p), {
      scope,
      sizes: { "a.wasm": 10_000 },
      everyMs: 100,
      now: () => (clock += 40), // each piece 40 ms after the last
    });
    await (await scope.fetch("https://run.example/a.wasm")).arrayBuffer();
    // Ten pieces, 40 ms apart: a report every third, and one at the end.
    expect(seen.map((p) => p.loaded)).toEqual([1000, 4000, 7000, 10_000, 10_000]);
  });
});
