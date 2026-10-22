/**
 * What both builds share (vite.config.ts builds the app, vite.runner.config.ts
 * the code runner).
 */
import type { Alias } from "vite";

/**
 * Babel's core (used by the TypeScript worker) calls path.resolve() while
 * setting up options, even with config files turned off. In the browser,
 * Vite replaces Node's "path" with an empty stub, so supply a real
 * implementation.
 */
export const nodePathAlias: Alias = { find: /^(node:)?path$/, replacement: "path-browserify" };
