/**
 * What a built-in method costs, for the complexity estimate. Each kind of
 * value has its table (arrays.ts, strings.ts, maps.ts); builtins.ts has the
 * static functions. A method's cost depends on its receiver's size.
 */

export interface MethodCost {
  /** "loop": calls its callback once per item, so the callback's body is a loop's body. */
  cost: "const" | "linear" | "nlogn" | "loop";
  /** Makes a new collection (as big as the receiver, for the memory estimate). */
  copies?: true;
  /** Adds an item to its receiver. */
  grows?: true;
  /** Its result is as long as the receiver: xs.map(...).length is xs.length. */
  sameLength?: true;
}

export type MethodTable = Record<string, MethodCost>;

/**
 * Methods are looked up by name only, since a receiver's type isn't known
 * from the source: a name in more than one table must cost the same in each.
 */
export function mergeTables(...tables: MethodTable[]): Map<string, MethodCost> {
  const out = new Map<string, MethodCost>();
  for (const table of tables) {
    for (const [name, cost] of Object.entries(table)) {
      const before = out.get(name);
      if (before && JSON.stringify(before) !== JSON.stringify(cost))
        throw new Error(`${name} costs ${JSON.stringify(before)} in one table and ${JSON.stringify(cost)} in another`);
      out.set(name, cost);
    }
  }
  return out;
}
