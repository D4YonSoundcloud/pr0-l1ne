/** String methods' costs (see table.ts). Tests: strings.test.ts. */
import type { MethodTable } from "./table";

export const STRING_METHODS: MethodTable = {
  includes: { cost: "linear" },
  indexOf: { cost: "linear" },
  lastIndexOf: { cost: "linear" },
  // "as const": a key named toString is otherwise typed as Object.prototype.toString
  toString: { cost: "linear" as const },
  repeat: { cost: "linear" },
  slice: { cost: "linear", copies: true, sameLength: true },
  concat: { cost: "linear", copies: true, sameLength: true },
  split: { cost: "linear", copies: true, sameLength: true },
};
