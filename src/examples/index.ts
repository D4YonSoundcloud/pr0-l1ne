/**
 * Starter programs, grouped by topic in the Open… menu. Each one is chosen to
 * show off a different part of the canvas. The "Hints, step by step" group
 * goes from the simplest `viz:` hint to all of them together.
 *
 * Every example is traced and drawn at every step by render/layout.test.ts,
 * so they must run without errors.
 */
export interface Example {
  /** Shown as an optgroup: "Sorting", "Graphs", ... */
  group: string;
  name: string;
  code: string;
}

export { PYTHON_EXAMPLES } from "./python";
export { JAVASCRIPT_EXAMPLES } from "./javascript";
export { TYPESCRIPT_EXAMPLES } from "./typescript";
