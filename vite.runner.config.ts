/**
 * The code runner's build: runner.html and the four language workers, with
 * Pyodide and Postgres, into dist-runner/, for its own site (pr0l1ne-run.pages.dev). See
 * src/sandbox/origins.ts for why programs run on another site, and
 * src/runner/ for the page.
 *
 *   npm run build:runner     build it (Cloudflare's runner project runs this)
 *   npm run dev              the app and this, together (scripts/dev.mjs)
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { appOriginsFor, LOCAL_APP_ORIGINS, runnerHeaders } from "./src/sandbox/origins";
import { nodePathAlias } from "./vite.shared";

const PYODIDE_DIR = fileURLToPath(new URL("./node_modules/pyodide/", import.meta.url));
const PYODIDE_VERSION: string = JSON.parse(readFileSync(`${PYODIDE_DIR}package.json`, "utf8")).version;
/** What the worker loads: the interpreter, the standard library, and the package list. */
const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".json": "application/json",
};

/**
 * Pyodide from the npm package, at /pyodide/<version>/: served from
 * node_modules in development, copied into the build otherwise. The worker
 * may only fetch from its own site, so it can't come from a CDN.
 */
function pyodide(): Plugin {
  const base = `/pyodide/${PYODIDE_VERSION}/`;
  return {
    name: "pr0l1ne:pyodide",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        const file = path.startsWith(base) ? path.slice(base.length) : "";
        if (!PYODIDE_FILES.includes(file)) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(PYODIDE_DIR + file));
      });
    },
    generateBundle() {
      for (const file of PYODIDE_FILES) {
        this.emitFile({ type: "asset", fileName: `${base.slice(1)}${file}`, source: readFileSync(PYODIDE_DIR + file) });
      }
    },
  };
}

/** The runner's headers, as Cloudflare reads them (`_headers`), from the same list the dev servers send. */
function headersFile(headers: Record<string, string>): Plugin {
  const lines = (entries: Record<string, string>) => Object.entries(entries).map(([k, v]) => `  ${k}: ${v}`);
  const text = [
    "# Made by vite.runner.config.ts from src/sandbox/origins.ts: edit those, not this.",
    "/*",
    ...lines(headers),
    "",
    "# Built files and Pyodide have their version in their names: kept for good.",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "/pyodide/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "# The page itself is checked on every load, so the app always gets the newest.",
    "/runner.html",
    "  Cache-Control: no-cache",
    "",
  ].join("\n");
  return {
    name: "pr0l1ne:headers",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: text });
    },
  };
}

export default defineConfig(({ command }) => {
  // Which pages may embed the runner: built on Cloudflare, the app's own
  // sites; anywhere else, the app on this machine (see appOriginsFor).
  const appOrigins = command === "serve" && !process.env.CF_PAGES ? LOCAL_APP_ORIGINS : appOriginsFor(process.env);
  const headers = runnerHeaders(appOrigins);
  return {
    resolve: { alias: [nodePathAlias] },
    // Not the app's public/ (its headers, its OpenGraph image): the runner has its own.
    publicDir: false,
    // Its own cache of pre-bundled dependencies: sharing the app's, the two
    // dev servers would overwrite each other's.
    cacheDir: "node_modules/.vite-runner",
    define: {
      "import.meta.env.VITE_APP_ORIGINS": JSON.stringify(JSON.stringify(appOrigins)),
      "import.meta.env.VITE_PYODIDE_VERSION": JSON.stringify(PYODIDE_VERSION),
    },
    // The workers are ES modules (Pyodide's is loaded with import()).
    worker: { format: "es" },
    // In development, find the workers' dependencies (Babel) at startup: one
    // found when a worker first loads makes Vite re-bundle, and that worker fail.
    optimizeDeps: {
      entries: ["runner.html", "src/js/*.worker.ts", "src/worker/*.worker.ts", "src/sql/*.worker.ts"],
      // PGlite loads its WebAssembly from beside its own files: pre-bundled
      // into Vite's cache, it would look in the wrong place.
      exclude: ["@electric-sql/pglite"],
      include: [
        "@babel/parser",
        "@babel/traverse",
        "@babel/generator",
        "@babel/types",
        "@babel/core",
        "@babel/plugin-transform-typescript",
        "path-browserify",
      ],
    },
    // Another site from the app's localhost:5173 (a site ignores the port, so not localhost too).
    server: { host: "127.0.0.1", port: 5174, strictPort: true, headers },
    preview: { host: "127.0.0.1", port: 4174, strictPort: true, headers },
    build: {
      outDir: "dist-runner",
      emptyOutDir: true,
      // The TypeScript compiler alone is a few megabytes.
      chunkSizeWarningLimit: 5000,
      rollupOptions: { input: { runner: fileURLToPath(new URL("./runner.html", import.meta.url)) } },
    },
    plugins: [pyodide(), headersFile(headers)],
  };
});
