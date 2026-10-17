/** Array methods' costs (see table.ts). Tests: arrays.test.ts. */
import type { MethodTable } from "./table";

export const ARRAY_METHODS: MethodTable = {
  // A callback per item: a loop.
  forEach: { cost: "loop" },
  map: { cost: "loop", copies: true, sameLength: true },
  filter: { cost: "loop", copies: true, sameLength: true },
  flatMap: { cost: "loop", copies: true },
  reduce: { cost: "loop" },
  reduceRight: { cost: "loop" },
  some: { cost: "loop" },
  every: { cost: "loop" },
  find: { cost: "loop" },
  findIndex: { cost: "loop" },
  findLast: { cost: "loop" },
  findLastIndex: { cost: "loop" },
  // A walk over the items.
  includes: { cost: "linear" },
  indexOf: { cost: "linear" },
  lastIndexOf: { cost: "linear" },
  join: { cost: "linear" },
  splice: { cost: "linear" },
  shift: { cost: "linear" },
  fill: { cost: "linear", sameLength: true },
  // "as const": a key named toString is otherwise typed as Object.prototype.toString
  toString: { cost: "linear" as const },
  with: { cost: "linear" },
  reverse: { cost: "linear", sameLength: true },
  slice: { cost: "linear", copies: true, sameLength: true },
  concat: { cost: "linear", copies: true, sameLength: true },
  toReversed: { cost: "linear", copies: true, sameLength: true },
  flat: { cost: "linear", copies: true },
  unshift: { cost: "linear", grows: true },
  // Sorting.
  sort: { cost: "nlogn", sameLength: true },
  toSorted: { cost: "nlogn", copies: true, sameLength: true },
  // Constant time.
  push: { cost: "const", grows: true },
  entries: { cost: "const", sameLength: true },
  keys: { cost: "const", sameLength: true },
  values: { cost: "const", sameLength: true },
};
