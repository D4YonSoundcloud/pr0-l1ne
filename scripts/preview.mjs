/**
 * npm run preview: serve the built app (dist/, http://localhost:4173) and
 * the built runner (dist-runner/, http://127.0.0.1:4174) together, after
 * `npm run build && npm run build:runner`. Built anywhere but Cloudflare,
 * the app talks to this local runner (see runnerUrlFor in
 * src/sandbox/origins.ts).
 */
import { preview } from "vite";

const runner = await preview({ configFile: "vite.runner.config.ts" });
const app = await preview({ configFile: "vite.config.ts", preview: { port: 4173 } });

console.log("\n  Code runner:");
runner.printUrls();
console.log("\n  PR0L1NE (open this one):");
app.printUrls();
