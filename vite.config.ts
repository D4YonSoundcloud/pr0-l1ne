import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [
      {
        // Lets src/monaco.ts import individual Monaco modules (and their CSS)
        // directly, so we can build a lean editor. See the comment there.
        find: /^monaco-esm\//,
        replacement: fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs/", import.meta.url)),
      },
      {
        // Babel's core (used by the TypeScript worker) calls path.resolve()
        // while setting up options, even with config files turned off. In the
        // browser, Vite replaces Node's "path" with an empty stub, so supply
        // a real implementation.
        find: /^(node:)?path$/,
        replacement: "path-browserify",
      },
    ],
  },
  optimizeDeps: {
    // Serve Monaco's ES modules as-is in dev. Pre-bundling them breaks the
    // `?worker` import in src/monaco.ts.
    exclude: ["monaco-esm", "monaco-editor"],
  },
  worker: {
    // The Pyodide worker is an ES module worker (it uses dynamic import()).
    format: "es",
  },
  build: {
    // Monaco alone is about 4 MB, so silence the generic 500 kB warning.
    chunkSizeWarningLimit: 5000,
  },
});
