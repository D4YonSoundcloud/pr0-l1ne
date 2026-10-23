/**
 * What both builds share (vite.config.ts builds the app, vite.runner.config.ts
 * the code runner).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Alias, Plugin } from "vite";

/**
 * Babel's core (used by the TypeScript worker) calls path.resolve() while
 * setting up options, even with config files turned off. In the browser,
 * Vite replaces Node's "path" with an empty stub, so supply a real
 * implementation.
 */
export const nodePathAlias: Alias = { find: /^(node:)?path$/, replacement: "path-browserify" };

/**
 * `virtual:trace-validators`: the trace schema (schema/trace.schema.json)
 * compiled into plain functions when building, so checking a trace needs no
 * eval (Ajv's usual compile does, and the app's Content-Security-Policy
 * allows none). Two of them, so trace/checkTrace.ts can check a heap object
 * shared by many steps only once:
 *
 *   shell        the whole trace, but not the objects in each step's heap
 *   heapObject   one heap object, in full
 */
export function traceValidators(): Plugin {
  const id = "virtual:trace-validators";
  const resolved = `\0${id}`;
  return {
    name: "pr0l1ne:trace-validators",
    resolveId: (source) => (source === id ? resolved : null),
    async load(source) {
      if (source !== resolved) return null;
      const { default: Ajv } = await import("ajv");
      const { default: standaloneCode } = await import("ajv/dist/standalone/index.js");
      const path = fileURLToPath(new URL("./schema/trace.schema.json", import.meta.url));
      this.addWatchFile(path);
      const schema = JSON.parse(readFileSync(path, "utf8"));
      // The shell: the trace's own Trace and Step, the rest from the full schema.
      const local = new Set(["Trace", "Step"]);
      const toFull = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(toFull);
        if (typeof node !== "object" || node === null) return node;
        return Object.fromEntries(
          Object.entries(node).map(([k, v]) => {
            if (k === "$ref" && typeof v === "string") {
              const name = v.replace("#/definitions/", "");
              return [k, local.has(name) ? v : `trace#/definitions/${name}`];
            }
            return [k, toFull(v)];
          }),
        );
      };
      const definitions = toFull({ Trace: schema.definitions.Trace, Step: schema.definitions.Step }) as {
        Step: { properties: { heap: { additionalProperties: unknown } } };
      };
      definitions.Step.properties.heap.additionalProperties = true;
      const shell = { $id: "trace-shell", $ref: "#/definitions/Trace", definitions };
      const ajv = new Ajv({ code: { source: true, esm: true }, strict: false });
      ajv.addSchema({ ...schema, $id: "trace" });
      ajv.addSchema(shell);
      return standaloneCode(ajv, { shell: "trace-shell", heapObject: "trace#/definitions/HeapObject" });
    },
  };
}

/**
 * The app's headers for every page, as Cloudflare sends them, for `vite
 * preview`, so the app (and the docs) are tried locally under the policy
 * they have live: from the build's dist/_headers (with the docs' scripts
 * allowed, see scripts/docs-headers.mjs), or public/_headers before a build.
 * `frameSrc` adds the local runner the preview embeds.
 */
export function appHeaders(frameSrc: string): Record<string, string> {
  const built = fileURLToPath(new URL("./dist/_headers", import.meta.url));
  const source = fileURLToPath(new URL("./public/_headers", import.meta.url));
  const text = readFileSync(existsSync(built) ? built : source, "utf8");
  const headers: Record<string, string> = {};
  let inAll = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) inAll = line.trim() === "/*";
    else if (inAll) {
      const m = /^\s+([\w-]+):\s*(.*)$/.exec(line);
      if (m) headers[m[1]] = m[2];
    }
  }
  const policy = headers["Content-Security-Policy"];
  if (policy) headers["Content-Security-Policy"] = policy.replace("frame-src ", `frame-src ${frameSrc} `);
  return headers;
}
