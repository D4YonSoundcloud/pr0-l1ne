/**
 * Growth runs: how a program's cost grows with its input size.
 *
 * A `viz: size n` hint names the variables that set the input size (set to
 * a number at the top level: `n = 40000`). Measure then runs the program at
 * a ladder of sizes (n/64, n/16, n/4, n), counting its work each time. The
 * counts are fitted to the usual growth curves (1, log n, n, n log n, n²,
 * n² log n, n³) and compared with the estimate from the code's shape.
 *
 * Everything here is plain computation; the runs and the drawing are in
 * main.ts and growthView.ts.
 */
import type { BigO } from "./bigO";
import type { Estimate } from "./complexity";
import { parseHints } from "./hints";
import { type Measurement, totals } from "./measurement";
import type { RawHint } from "./types";

/** A size variable: what the code sets it to, and the full size to scale from. */
export interface SizeVar {
  name: string;
  /** The full size: the hint's value (`viz: size n = 40000`), else the code's. */
  base: number;
  /** What the code sets it to (and what the traced run used). */
  codeValue: number | null;
  /** The assignment's line, 1-based. */
  line: number | null;
}

/** The ladder: fractions of the full size. */
export const LADDER = [1 / 64, 1 / 16, 1 / 4, 1];

/** `viz:` comments in a program, without tracing it. */
export function hintComments(code: string): RawHint[] {
  const out: RawHint[] = [];
  code.split("\n").forEach((text, i) => {
    const m = /(?:#|\/\/)\s*viz:\s*(.*?)\s*$/.exec(text);
    if (m) out.push({ line: i + 1, text: m[1] });
  });
  return out;
}

const escapeDollars = (s: string) => s.replace(/[$]/g, "\\$");

/** The size variables a program's `viz: size` hints name, with problems to show. */
export function findSizes(code: string): { vars: SizeVar[]; problems: string[] } {
  const hints = parseHints(hintComments(code));
  const problems = hints.warnings.filter((w) => /"size"/.test(w.message)).map((w) => `Line ${w.line}: ${w.message}`);
  const lines = code.split("\n");
  const vars: SizeVar[] = [];
  for (const hint of hints.sizes) {
    // At the top level: no indentation. `n = 40000`, `const n = 40_000;`, `k: int = 10`, `let n: number = 5`.
    const assign = new RegExp(
      `^(?:(?:const|let|var)\\s+)?${escapeDollars(hint.name)}\\s*(?::\\s*[\\w<>\\[\\]|. ]+?\\s*)?=\\s*([0-9][0-9_]*)\\s*;?\\s*(?:(?:#|//).*)?$`,
    );
    const index = lines.findIndex((line) => assign.test(line));
    const codeValue = index >= 0 ? Number(assign.exec(lines[index])![1].replace(/_/g, "")) : null;
    if (codeValue === null) {
      problems.push(
        `${hint.name}: there's no "${hint.name} = <number>" at the top level of the program for growth runs to change.`,
      );
      continue;
    }
    const base = hint.value ?? codeValue;
    if (base < 1) {
      problems.push(`${hint.name} is ${base}: growth runs need a size of at least 1.`);
      continue;
    }
    vars.push({ name: hint.name, base, codeValue, line: index + 1 });
  }
  return { vars, problems };
}

export interface Rung {
  factor: number;
  /** Every size variable's value for this run. */
  sizes: Record<string, number>;
  /** The first scaled variable's value: the x of the chart. */
  x: number;
}

/**
 * The runs to make: the scaled variables at each fraction of their full
 * size (at least 1), the others at their full size. Fractions that give
 * the same size as a smaller one are dropped.
 */
export function ladder(vars: SizeVar[], scaled: string[]): Rung[] {
  const primary = vars.find((v) => scaled.includes(v.name));
  if (!primary) return [];
  const rungs: Rung[] = [];
  for (const factor of LADDER) {
    const sizes: Record<string, number> = {};
    for (const v of vars) sizes[v.name] = scaled.includes(v.name) ? Math.max(1, Math.round(v.base * factor)) : v.base;
    const x = sizes[primary.name];
    if (rungs.some((r) => r.x === x)) continue;
    rungs.push({ factor, sizes, x });
  }
  return rungs;
}

export interface GrowthPoint {
  x: number;
  sizes: Record<string, number>;
  /** Lines run plus items handled inside built-ins. */
  ops: number;
  /** The untouched run's time when there was one, else the counted run's. */
  ms: number;
  /** `ms` is the untouched run's. */
  plain: boolean;
}

export function pointFrom(rung: Rung, m: Measurement): GrowthPoint {
  const t = totals(m);
  return { x: rung.x, sizes: rung.sizes, ops: t.lines + t.work, ms: m.plainMs ?? m.ms, plain: m.plainMs !== null };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

/** A growth curve: x^degree × (log x)^log. */
export interface Model {
  degree: number;
  log: number;
}

export const MODELS: Model[] = [
  { degree: 0, log: 0 },
  { degree: 0, log: 1 },
  { degree: 1, log: 0 },
  { degree: 1, log: 1 },
  { degree: 2, log: 0 },
  { degree: 2, log: 1 },
  { degree: 3, log: 0 },
];

const SUPERSCRIPT: Record<number, string> = { 2: "²", 3: "³" };

/** "n²", "n log n", "1", "log n". */
export function modelLabel(m: Model, x = "n"): string {
  const power = m.degree === 0 ? "" : m.degree === 1 ? x : `${x}${SUPERSCRIPT[m.degree] ?? `^${m.degree}`}`;
  const log = m.log ? `log ${x}` : "";
  return [power, log].filter(Boolean).join(" ") || "1";
}

export const shape = (m: Model, x: number) => x ** m.degree * Math.max(1, Math.log2(Math.max(2, x))) ** m.log;

export interface Fit {
  model: Model;
  /** c in c × shape(x). */
  scale: number;
  /** The slope on a log-log plot: work grows like x^exponent over these sizes. */
  exponent: number;
  /** How well it fits: root mean square of the log errors (0 is perfect). */
  error: number;
}

/**
 * The growth curve that best fits the points (least squares on a log
 * scale, each curve scaled to fit). Needs points at 2 or more sizes.
 */
export function fitGrowth(points: { x: number; y: number }[]): Fit | null {
  const usable = points.filter((p) => p.x > 0 && p.y > 0);
  if (new Set(usable.map((p) => p.x)).size < 2) return null;
  const lx = usable.map((p) => Math.log(p.x));
  const ly = usable.map((p) => Math.log(p.y));
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(lx);
  const my = mean(ly);
  const exponent = lx.reduce((s, v, i) => s + (v - mx) * (ly[i] - my), 0) / lx.reduce((s, v) => s + (v - mx) ** 2, 0);

  let best: Fit | null = null;
  for (const model of MODELS) {
    const r = usable.map((p, i) => ly[i] - Math.log(shape(model, p.x)));
    const c = mean(r);
    const error = Math.sqrt(mean(r.map((v) => (v - c) ** 2)));
    // A simpler curve wins unless a more complex one fits clearly better.
    if (!best || error < best.error * 0.7 - 0.005) best = { model, scale: Math.exp(c), exponent, error };
  }
  return best;
}

export const predict = (fit: Fit, x: number) => fit.scale * shape(fit.model, x);

// ---------------------------------------------------------------------------
// The code's estimate, in terms of the scaled variables
// ---------------------------------------------------------------------------

export interface StaticGrowth {
  /** The estimate as shown: "O(n·k)". */
  label: string;
  /** How it grows when the scaled variables grow together. */
  model: Model;
  /** Exponential or factorial in a scaled size. */
  explosive: boolean;
  /** The estimate's letters that grow with the scaled variables. */
  letters: string[];
}

/**
 * The estimate's growth as the scaled variables grow together: its sizes
 * that were equal to a scaled variable in the traced run (len(nums) when
 * nums has n items, or k itself) grow; the rest stay fixed. Null when
 * none of its sizes could be tied to a scaled variable.
 */
export function staticGrowth(estimate: Estimate, vars: SizeVar[], scaled: string[]): StaticGrowth | null {
  const values = new Set(vars.filter((v) => scaled.includes(v.name) && v.codeValue !== null).map((v) => v.codeValue!));
  const grows = new Set(
    estimate.symbols.filter((s) => scaled.includes(s.name) || (values.has(s.value) && s.value > 1)).map((s) => s.key),
  );
  if (!grows.size) return null;
  let model: Model = { degree: 0, log: 0 };
  let explosive = false;
  for (const term of estimate.raw.time as BigO) {
    if (Object.keys(term.exp).some((k) => grows.has(k)) || Object.keys(term.fact).some((k) => grows.has(k)))
      explosive = true;
    let degree = 0;
    let log = 0;
    for (const [k, p] of Object.entries(term.pow)) if (grows.has(k)) degree += p;
    for (const [k, p] of Object.entries(term.log)) if (grows.has(k)) log += p;
    if (degree > model.degree || (degree === model.degree && log > model.log)) model = { degree, log };
  }
  const letters = estimate.symbols.filter((s) => grows.has(s.key)).map((s) => s.letter);
  return { label: estimate.time, model, explosive, letters };
}

export type Verdict =
  | { kind: "agree"; text: string }
  | { kind: "close"; text: string }
  | { kind: "lower" | "higher"; text: string };

/** Does the measured growth match the code's estimate? */
export function compareGrowth(fit: Fit, est: StaticGrowth, x: string): Verdict {
  const measured = modelLabel(fit.model, x);
  const expected = est.explosive ? `faster than any power of ${x}` : modelLabel(est.model, x);
  if (est.explosive) {
    return fit.model.degree >= 3
      ? { kind: "agree", text: `The code's shape says ${est.label}, and the work grows very fast.` }
      : {
          kind: "lower",
          text: `The code's shape says ${est.label} (exponential), but measured, the work grows like ${measured}. Something prunes the recursion: a cache, or a check that skips repeated work.`,
        };
  }
  if (fit.model.degree === est.model.degree && fit.model.log === est.model.log) {
    return {
      kind: "agree",
      text: `Measured, the work grows like ${measured}, as the code's shape (${est.label}) predicts.`,
    };
  }
  if (fit.model.degree === est.model.degree) {
    return {
      kind: "close",
      text: `Measured, the work grows like ${measured}; the code's shape says ${est.label} (like ${expected}). A log factor is hard to see at these sizes.`,
    };
  }
  if (fit.model.degree < est.model.degree) {
    return {
      kind: "lower",
      text: `The code's shape says ${est.label} (like ${expected} as ${x} grows), but measured, the work grows like ${measured}. Something keeps the work down: a loop that stops early, a check that skips work, or a size that's reduced first (like k % n).`,
    };
  }
  return {
    kind: "higher",
    text: `The code's shape says ${est.label} (like ${expected} as ${x} grows), but measured, the work grows like ${measured}. Something costs more than the loops show: a built-in that walks the data (insert at the front, x in list, slicing, shift), or a loop that runs more than its bound suggests.`,
  };
}
