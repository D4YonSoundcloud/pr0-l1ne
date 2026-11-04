/// <reference lib="webworker" />
/**
 * How much of a language's runtime has downloaded, for the loading card
 * (app/loadingCard.ts). Pyodide and PGlite fetch their big files
 * themselves, from inside the worker; `meterDownloads` wraps the worker's
 * `fetch` so each of those files' bytes are counted as they stream in, and
 * reports how far it's got a few times a second.
 *
 * The sizes come from the runner's build (vite.runner.config.ts reads
 * them from node_modules, the same bytes it serves): the server may
 * compress a file, and then a response doesn't say how big it is, but the
 * bytes read from it are the file's own, so they're counted against the
 * file's own size.
 */

/** Each runtime file's size in bytes, by name (as the runner's build saw them). */
export const DOWNLOAD_SIZES: Readonly<Record<string, number>> = parseSizes(import.meta.env.VITE_DOWNLOAD_SIZES);

function parseSizes(json: string | undefined): Record<string, number> {
  try {
    const sizes = JSON.parse(json ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(sizes).filter(([, v]) => typeof v === "number" && v > 0)) as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

/** Python's files that come through fetch (its JavaScript comes through import(), uncounted). */
export const PYTHON_DOWNLOADS = ["pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
/** PostgreSQL's: the database and its files, a fresh database's setup, and the parser. */
export const SQL_DOWNLOADS = ["pglite.wasm", "pglite.data", "initdb.wasm", "libpg-query.wasm"];

/**
 * A file's name from its address, as the build named it before adding its
 * content hash: ".../assets/pglite-CKQGo6A1.wasm" is "pglite.wasm".
 */
export function fileNameOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/-[\w-]{8}(\.[^.]+)$/, "$1");
}

/** How much has downloaded, in bytes, of all of it. */
export interface DownloadProgress {
  loaded: number;
  total: number;
}

type Fetch = typeof fetch;

/**
 * Count the bytes of `files` as the worker fetches them, calling `report`
 * at most every `everyMs` (and when a file is done). Returns a function
 * that puts the worker's own fetch back.
 */
export function meterDownloads(
  files: string[],
  report: (progress: DownloadProgress) => void,
  options: {
    scope?: { fetch: Fetch };
    sizes?: Readonly<Record<string, number>>;
    everyMs?: number;
    now?: () => number;
  } = {},
): () => void {
  const scope = options.scope ?? (self as unknown as { fetch: Fetch });
  const sizes = options.sizes ?? DOWNLOAD_SIZES;
  const everyMs = options.everyMs ?? 100;
  const now = options.now ?? (() => performance.now());
  const loaded = new Map<string, number>();
  const sizeOf = new Map(files.map((f) => [f, sizes[f] ?? 0]));
  let last = Number.NEGATIVE_INFINITY;
  const total = () => [...sizeOf.values()].reduce((a, b) => a + b, 0);
  const send = (force: boolean) => {
    const t = now();
    if (!force && t - last < everyMs) return;
    last = t;
    const sum = [...loaded].reduce((a, [name, n]) => a + Math.min(n, sizeOf.get(name) || n), 0);
    report({ loaded: sum, total: Math.max(total(), sum) });
  };

  const original = scope.fetch;
  const metered: Fetch = async (input, init) => {
    const response = await original.call(scope, input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = fileNameOf(url);
    if (!sizeOf.has(name) || !response.body || !response.ok) return response;
    // A size the build didn't know: the response's own, when it isn't compressed.
    const length = Number(response.headers.get("Content-Length"));
    if (!sizeOf.get(name) && !response.headers.get("Content-Encoding") && length > 0) sizeOf.set(name, length);
    loaded.set(name, 0);
    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded.set(name, (loaded.get(name) ?? 0) + chunk.byteLength);
          send(false);
          controller.enqueue(chunk);
        },
        flush() {
          // Done: however big it said it was, it's all here.
          sizeOf.set(name, Math.max(sizeOf.get(name) ?? 0, loaded.get(name) ?? 0));
          send(true);
        },
      }),
    );
    // The same response, its body counted (headers kept: WebAssembly's streaming compile needs the type).
    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  scope.fetch = metered;
  return () => {
    if (scope.fetch === metered) scope.fetch = original;
  };
}
