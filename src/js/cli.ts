/**
 * Debugging CLI for the JavaScript and TypeScript tracers. The language is
 * picked from the file extension (.ts for TypeScript).
 *
 *   npm run instrument -- program.js    print the instrumented code
 *   npm run trace:js -- program.ts      print the trace JSON
 */
import { readFileSync } from "node:fs";
import { instrument } from "./instrument";
import { traceJavaScript } from "./trace";
import { instrumentTypeScript, traceTypeScript } from "./typescript";

const args = process.argv.slice(2);
const wantTrace = args.includes("--trace");
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) {
  console.error("Usage: npm run instrument -- program.js   (or npm run trace:js -- program.ts)");
  process.exit(1);
}
const source = readFileSync(file, "utf8");
const isTypeScript = /\.(ts|mts|cts)$/.test(file);
if (wantTrace) {
  console.log(JSON.stringify(await (isTypeScript ? traceTypeScript : traceJavaScript)(source), null, 2));
} else {
  console.log((isTypeScript ? instrumentTypeScript : instrument)(source).code);
}
