/**
 * Which cell of a grid a step is working on: the outlined cell where a row
 * pointer and a column pointer meet.
 *
 * The tracers record every `grid[a][b]` in the code (Trace.gridAccesses):
 * the line, and the row and column index expressions as written. A step's
 * cell is the one an access gives on the line that just ran, or failing
 * that the line about to run, with the expressions evaluated from the
 * step's variables. So `results.append(matrix[up][col])` outlines
 * matrix[up][col], whatever other index variables are around.
 */
import type { GridAccess, Trace, Value } from "./types";

export type GridFocus = { row: number; col: number } | "none";

/** The lines a step is about: the one that just ran (same frame), then the one about to run. */
export function focusLines(trace: Trace, stepIndex: number): number[] {
  const step = trace.steps[stepIndex];
  if (!step) return [];
  const prev = trace.steps[stepIndex - 1];
  const here = step.stack[step.stack.length - 1]?.id;
  const lines: number[] = [];
  if (prev && prev.line >= 1 && prev.stack[prev.stack.length - 1]?.id === here) lines.push(prev.line);
  if (step.line >= 1 && !lines.includes(step.line)) lines.push(step.line);
  return lines;
}

/**
 * The cell of `name` this step reads or writes. "none" when the code
 * indexes this grid, but not on these lines (no cell is outlined); null
 * when the code never indexes it by this name (the caller can guess).
 */
export function gridFocus(
  accesses: GridAccess[] | undefined,
  name: string,
  lines: number[],
  locals: Map<string, Value>,
  size: { rows: number; cols: (row: number) => number },
  negativeWraps: boolean,
): GridFocus | null {
  const mine = accesses?.filter((a) => a.name === name);
  if (!mine?.length) return null;
  for (const line of lines) {
    for (const access of mine) {
      if (access.line !== line) continue;
      let row = evalIndex(access.row, locals);
      if (row === null) continue;
      if (row < 0 && negativeWraps) row += size.rows;
      if (row < 0 || row >= size.rows) continue;
      let col = evalIndex(access.col, locals);
      if (col === null) continue;
      if (col < 0 && negativeWraps) col += size.cols(row);
      if (col < 0 || col >= size.cols(row)) continue;
      return { row, col };
    }
  }
  return "none";
}

/**
 * Evaluate a simple index expression: whole numbers, variables holding
 * whole numbers, + - * // % (and / when it divides exactly), unary minus
 * and parentheses. Null for anything else (a call, an attribute...).
 */
export function evalIndex(expr: string, locals: Map<string, Value>): number | null {
  const tokens = expr.match(/\d+|[A-Za-z_$][\w$]*|\/\/|[-+*%/()]|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const fail = (): never => { throw new Error("not simple"); };
  const value = (name: string): number => {
    const v = locals.get(name);
    if (v?.kind !== "prim" || !(v.type === "int" || v.type === "number" || v.type === "bool" || v.type === "boolean")) return fail();
    const n = v.repr === "True" || v.repr === "true" ? 1 : v.repr === "False" || v.repr === "false" ? 0 : Number(v.repr);
    return Number.isInteger(n) ? n : fail();
  };
  const atom = (): number => {
    const tok = tokens[at++];
    if (tok === undefined) return fail();
    if (tok === "(") {
      const v = sum();
      if (tokens[at++] !== ")") fail();
      return v;
    }
    if (tok === "-") return -atom();
    if (tok === "+") return atom();
    if (/^\d+$/.test(tok)) return Number(tok);
    if (/^[A-Za-z_$]/.test(tok)) return value(tok);
    return fail();
  };
  const product = (): number => {
    let v = atom();
    for (;;) {
      const op = peek();
      if (op === "*") { at++; v *= atom(); }
      else if (op === "//") { at++; const d = atom(); if (d === 0) fail(); v = Math.floor(v / d); }
      else if (op === "/") { at++; const d = atom(); if (d === 0 || v % d !== 0) fail(); v /= d; }
      else if (op === "%") { at++; const d = atom(); if (d === 0) fail(); v = ((v % d) + d) % d; }
      else return v;
    }
  };
  const sum = (): number => {
    let v = product();
    for (;;) {
      const op = peek();
      if (op === "+") { at++; v += product(); }
      else if (op === "-") { at++; v -= product(); }
      else return v;
    }
  };
  try {
    const v = sum();
    return at === tokens.length && Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}
