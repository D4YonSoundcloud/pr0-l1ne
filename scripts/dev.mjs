/**
 * npm run dev: the app's dev server (http://localhost:5173) and the code
 * runner's (http://127.0.0.1:5174), together. They're two sites, as the
 * live app and runner are (pr0l1ne.com, pr0l1ne-run.pages.dev), so the
 * sandbox behaves here as it does there. See src/sandbox/origins.ts.
 */
import { createServer } from "vite";

const runner = await createServer({ configFile: "vite.runner.config.ts" });
await runner.listen();
const app = await createServer({ configFile: "vite.config.ts" });
await app.listen();

console.log("\n  Code runner:");
runner.printUrls();
console.log("\n  PR0L1NE (open this one):");
app.printUrls();

const stop = async () => {
  await Promise.all([app.close(), runner.close()]);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
