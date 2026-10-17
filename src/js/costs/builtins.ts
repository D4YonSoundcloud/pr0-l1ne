/**
 * Static built-in functions that take a collection: Object.keys(xs) is as
 * long as xs. (Their own linear cost isn't counted: a loop over the result
 * already walks it, and counting both would double the estimate.)
 */
import { ARRAY_METHODS } from "./arrays";
import { MAP_METHODS } from "./maps";
import { STRING_METHODS } from "./strings";
import { mergeTables } from "./table";

export const BUILTIN_CALLS: Record<string, { sameLength?: true }> = {
  "Object.keys": { sameLength: true },
  "Object.values": { sameLength: true },
  "Object.entries": { sameLength: true },
};

/** Math functions that keep a size a size: Math.floor(n / 2) is still about n. */
export const SIZE_PRESERVING_MATH = new Set([
  "Math.floor",
  "Math.ceil",
  "Math.trunc",
  "Math.round",
  "Math.abs",
  "Math.min",
  "Math.max",
]);
/** Math functions that round: Math.floor(n / 2) halves n. */
export const ROUNDING_MATH = new Set(["Math.floor", "Math.trunc", "Math.ceil", "Math.round"]);

/** Every method, by name (receivers' types aren't known). */
export const METHODS = mergeTables(ARRAY_METHODS, STRING_METHODS, MAP_METHODS);

export const isBuiltinCall = (name: string | null): name is string => !!name && Object.hasOwn(BUILTIN_CALLS, name);
