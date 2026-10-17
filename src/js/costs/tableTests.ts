/**
 * Shared by the cost tables' tests (arrays.test.ts, strings.test.ts,
 * maps.test.ts): check that every method in a table is estimated the way its
 * entry says.
 */
import { expect, it } from "vitest";
import type { CostNode, SizeRef } from "../../trace/types";
import { instrument } from "../instrument";
import type { MethodTable } from "./table";

/** The cost nodes of function f in a program. */
export function costOf(source: string, name = "f"): CostNode[] {
  const fn = instrument(source).cost?.functions.find((f) => f.name === name);
  if (!fn) throw new Error(`no function ${name}`);
  return fn.body;
}

/**
 * For each method: `const c = <receiver>.<method>(cb)`, then a loop over
 * the same call. `setup` declares the receiver; `size` is what it measures.
 */
export function checkTable(table: MethodTable, receiver: string, setup: string, size: SizeRef): void {
  for (const [method, entry] of Object.entries(table)) {
    it(`${method}: ${JSON.stringify(entry)}`, () => {
      const call = `${receiver}.${method}((x) => x)`;
      const nodes = costOf(`function f(xs, s) {\n  ${setup}\n  const c = ${call};\n  for (const y of ${call}) {}\n}`);
      const line = nodes.filter((n) => n.line === 3);
      const loop = nodes.find((n) => n.kind === "loop" && n.loop !== undefined);

      // What the call costs where it's made.
      const op = line.find((n) => n.kind === "op");
      if (entry.cost === "loop")
        expect(line[0]).toMatchObject({ kind: "loop", bound: { kind: "size", sizes: [size] } });
      else if (entry.cost === "const") expect(op).toBeUndefined();
      else
        expect(op).toMatchObject({
          cost: entry.cost,
          size,
          what: `${receiver}.${method}()${entry.copies && entry.cost === "linear" ? " (copies)" : ""}`,
        });

      // Adding to the receiver, or making a copy of known size.
      const grows = line.find((n) => n.kind === "alloc" && n.into === receiver);
      expect(!!grows).toBe(!!entry.grows);
      const copy = line.find((n) => n.kind === "alloc" && n.name === "c");
      // (map's copy is sized by what its callback returns: see allocSizes.)
      expect(!!copy).toBe(!!(entry.copies && entry.sameLength && method !== "map"));
      if (copy) expect(copy).toMatchObject({ sizes: [size] });

      // A loop over its result makes as many passes as the receiver is long, if it keeps the length.
      const sizes = loop?.kind === "loop" && loop.bound.kind === "size" ? loop.bound.sizes : null;
      if (entry.sameLength) expect(sizes).toEqual([size]);
      else expect(sizes).not.toEqual([size]);
    });
  }
}
