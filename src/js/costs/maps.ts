/**
 * Map and Set methods' costs (see table.ts): hashed, so constant time. Plain
 * objects used as dictionaries (`key in obj`, `obj[key] = v`) are handled
 * where those are read, in shape.ts. `get` gives one item's size (sizes.ts).
 * Tests: maps.test.ts.
 */
import type { MethodTable } from "./table";

export const MAP_METHODS: MethodTable = {
  has: { cost: "const" },
  get: { cost: "const" },
  delete: { cost: "const" },
  set: { cost: "const", grows: true },
  add: { cost: "const", grows: true },
  entries: { cost: "const", sameLength: true },
  keys: { cost: "const", sameLength: true },
  values: { cost: "const", sameLength: true },
};

/** Constructors whose result is a container of this kind. */
export const CONTAINER_CONSTRUCTORS: Record<string, "list" | "dict" | "set"> = {
  Map: "dict",
  WeakMap: "dict",
  Set: "set",
  WeakSet: "set",
  Array: "list",
};
