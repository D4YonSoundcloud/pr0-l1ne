/// <reference types="vitest/config" />
/**
 * The app's build (pr0l1ne.com). Programs don't run here: they run on the
 * runner's site, built by vite.runner.config.ts (see src/sandbox/origins.ts).
 * This build only needs to know which runner to talk to.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { DEV_RUNNER, PREVIEW_RUNNER, runnerUrlFor } from "./src/sandbox/origins";
import { appHeaders, nodePathAlias, traceValidators } from "./vite.shared";

export default defineConfig(({ command }) => ({
  // The trace schema as plain functions, for checking what the runner sends (trace/checkTrace.ts).
  plugins: [traceValidators()],
  define: {
    // The dev server talks to the runner `npm run dev` starts; a build, to
    // the one for where it's built (runnerUrlFor: live, a branch preview, or
    // the one on this machine).
    "import.meta.env.VITE_RUNNER_URL": JSON.stringify(command === "serve" ? DEV_RUNNER : runnerUrlFor(process.env)),
  },
  resolve: {
    alias: [
      {
        // Lets src/monaco.ts import individual Monaco modules (and their CSS)
        // directly, so we can build a lean editor. See the comment there.
        find: /^monaco-esm\//,
        replacement: fileURLToPath(new URL("./node_modules/monaco-editor/esm/vs/", import.meta.url)),
      },
      // For tests: the app's own build no longer has the TypeScript worker in it.
      nodePathAlias,
    ],
  },
  optimizeDeps: {
    // Serve Monaco's ES modules as-is in dev. Pre-bundling them breaks the
    // `?worker` import in src/monaco.ts.
    exclude: ["monaco-esm", "monaco-editor"],
    // Found at startup, not on the first run: development builds check every
    // trace with it (worker/runner.ts), and a dependency found mid-run makes
    // Vite re-bundle and reload the page.
    include: ["ajv"],
  },
  worker: {
    // Monaco's editor worker.
    format: "es",
  },
  test: {
    coverage: {
      // npm run test:coverage. A map of untested code, not a score to chase.
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/examples/*.ts",
        "src/**/*.worker.ts",
        "src/js/cli.ts",
        "src/js/serve.ts",
        "src/runner/runner.ts",
      ],
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "coverage/js",
    },
  },
  // `npm run preview`: the headers the live app gets, so it runs under its real policy here too.
  preview: { headers: appHeaders(new URL(PREVIEW_RUNNER).origin) },
  build: {
    // Monaco alone is about 4 MB, so silence the generic 500 kB warning.
    chunkSizeWarningLimit: 5000,
  },
}));
