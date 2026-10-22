/**
 * The runner page (runner.html), served from its own site
 * (pr0l1ne-run.pages.dev), embedded by the app in a hidden iframe. See
 * relay.ts for what it does and sandbox/origins.ts for why it's elsewhere.
 *
 * The workers are built here, not in the app: everything that runs a
 * program (Pyodide, the JavaScript instrumenter, the TypeScript compiler)
 * only ever loads on this site.
 */
import { startRelay } from "./relay";

/** The pages that may connect, decided when this was built (vite.runner.config.ts). */
const allowed: string[] = JSON.parse(import.meta.env.VITE_APP_ORIGINS ?? "[]");

startRelay({
  win: window,
  allowed,
  // Written out literally: Vite only bundles a worker from `new Worker(new URL("...", import.meta.url))`.
  workers: {
    python: (name) => new Worker(new URL("../worker/pyodide.worker.ts", import.meta.url), { type: "module", name }),
    javascript: (name) => new Worker(new URL("../js/javascript.worker.ts", import.meta.url), { type: "module", name }),
    typescript: (name) => new Worker(new URL("../js/typescript.worker.ts", import.meta.url), { type: "module", name }),
  },
});
