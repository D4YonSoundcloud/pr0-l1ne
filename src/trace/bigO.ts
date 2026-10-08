/**
 * Big-O expressions over several sizes: O(n²), O(n log n), O(V + E),
 * O(n·m), O(2ⁿ), O(n!).
 *
 * An expression is a sum of terms, and each term a product of, per size:
 * a power, a power of its log, an exponential and a factorial. Sums drop
 * terms that another term dominates (n² + n is n²), but keep terms that
 * grow in different sizes (V + E). Constant factors don't exist here.
 */

export interface Term {
  pow: Record<string, number>;
  log: Record<string, number>;
  /** sym → base: 2ⁿ is { n: 2 }. */
  exp: Record<string, number>;
  /** sym → how many factorials: n! is { n: 1 }. */
  fact: Record<string, number>;
}

/** A sum of terms. [] means "nothing": the identity for addition. */
export type BigO = Term[];

const term = (t: Partial<Term> = {}): Term => ({ pow: {}, log: {}, exp: {}, fact: {}, ...t });

export const ONE: BigO = [term()];
export const ZERO: BigO = [];
export const size = (sym: string): BigO => [term({ pow: { [sym]: 1 } })];
export const logOf = (sym: string): BigO => [term({ log: { [sym]: 1 } })];
export const expOf = (sym: string, base: number): BigO => [term({ exp: { [sym]: base } })];
export const factOf = (sym: string): BigO => [term({ fact: { [sym]: 1 } })];
export const power = (sym: string, p: number): BigO => (p === 0 ? ONE : [term({ pow: { [sym]: p } })]);

function symbols(t: Term): Set<string> {
  return new Set([...Object.keys(t.pow), ...Object.keys(t.log), ...Object.keys(t.exp), ...Object.keys(t.fact)]);
}

/** How fast a term grows in one size, as a comparable tuple. */
function growth(t: Term, sym: string): [number, number, number, number] {
  return [t.fact[sym] ?? 0, t.exp[sym] ?? 1, t.pow[sym] ?? 0, t.log[sym] ?? 0];
}

function compareTuple(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] - b[i];
  return 0;
}

/**
 * Sizes that can be 0, like a node's number of neighbors. V·d doesn't cover
 * V, since d may be 0 (V + V·d is V + E, not E). Set by the caller.
 */
let canBeZero: (sym: string) => boolean = () => false;
export function setCanBeZero(test: (sym: string) => boolean): void {
  canBeZero = test;
}

/** True when a grows at least as fast as b in every size. */
export function dominates(a: Term, b: Term): boolean {
  for (const sym of new Set([...symbols(a), ...symbols(b)])) {
    if (compareTuple(growth(a, sym), growth(b, sym)) < 0) return false;
    if ((a.pow[sym] ?? 0) > 0 && !(b.pow[sym] ?? 0) && canBeZero(sym)) return false;
  }
  return true;
}

function same(a: Term, b: Term): boolean {
  return dominates(a, b) && dominates(b, a);
}

/** Drop terms that another term already covers. */
export function simplify(x: BigO): BigO {
  const out: Term[] = [];
  for (const t of x) {
    if (out.some((o) => dominates(o, t))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (dominates(t, out[i])) out.splice(i, 1);
    out.push(t);
  }
  return out;
}

export function add(...xs: BigO[]): BigO {
  return simplify(xs.flat());
}

function mulTerm(a: Term, b: Term): Term {
  const t = term({ pow: { ...a.pow }, log: { ...a.log }, exp: { ...a.exp }, fact: { ...a.fact } });
  for (const [s, p] of Object.entries(b.pow)) t.pow[s] = (t.pow[s] ?? 0) + p;
  for (const [s, p] of Object.entries(b.log)) t.log[s] = (t.log[s] ?? 0) + p;
  for (const [s, base] of Object.entries(b.exp)) t.exp[s] = (t.exp[s] ?? 1) * base;
  for (const [s, k] of Object.entries(b.fact)) t.fact[s] = (t.fact[s] ?? 0) + k;
  for (const r of [t.pow, t.log]) for (const s of Object.keys(r)) if (Math.abs(r[s]) < 1e-9) delete r[s];
  return t;
}

export function mul(...xs: BigO[]): BigO {
  let out: BigO = ONE;
  for (const x of xs) {
    const next: Term[] = [];
    for (const a of out) for (const b of x) next.push(mulTerm(a, b));
    out = simplify(next);
  }
  return out;
}

export function isOne(x: BigO): boolean {
  return x.length === 1 && symbols(x[0]).size === 0;
}

export function equal(a: BigO, b: BigO): boolean {
  return a.length === b.length && a.every((t) => b.some((u) => same(t, u)));
}

/** Rename sizes (a callee's parameter to the caller's argument). Merges terms that become equal. */
export function rename(x: BigO, map: (sym: string) => string): BigO {
  return simplify(x.map((t) => {
    const out = term();
    for (const [s, p] of Object.entries(t.pow)) out.pow[map(s)] = (out.pow[map(s)] ?? 0) + p;
    for (const [s, p] of Object.entries(t.log)) out.log[map(s)] = (out.log[map(s)] ?? 0) + p;
    for (const [s, b] of Object.entries(t.exp)) out.exp[map(s)] = (out.exp[map(s)] ?? 1) * b;
    for (const [s, k] of Object.entries(t.fact)) out.fact[map(s)] = (out.fact[map(s)] ?? 0) + k;
    return out;
  }));
}

/** Replace one size with an expression: n → V·d becomes E when d is E/V. */
export function substitute(x: BigO, sym: string, by: BigO): BigO {
  const out: Term[] = [];
  for (const t of x) {
    if (!symbols(t).has(sym)) { out.push(t); continue; }
    if (t.exp[sym] || t.fact[sym] || t.log[sym]) { out.push(t); continue; } // only plain powers are rewritten
    const p = t.pow[sym];
    const rest = term({ pow: { ...t.pow }, log: { ...t.log }, exp: { ...t.exp }, fact: { ...t.fact } });
    delete rest.pow[sym];
    let replaced: BigO = [rest];
    for (let i = 0; i < p; i++) replaced = mul(replaced, by);
    out.push(...replaced);
  }
  return simplify(out);
}

/** Every size an expression mentions. */
export function sizesIn(x: BigO): string[] {
  const all = new Set<string>();
  for (const t of x) for (const s of symbols(t)) all.add(s);
  return [...all];
}

/** The highest power of one size (n² log n gives 2), for comparisons. */
export function degree(x: BigO, sym: string): number {
  return Math.max(0, ...x.map((t) => t.pow[sym] ?? 0));
}

/** Evaluate with sizes plugged in, for comparing against a run. */
export function evaluate(x: BigO, value: (sym: string) => number): number {
  let total = 0;
  for (const t of x) {
    let v = 1;
    for (const [s, p] of Object.entries(t.pow)) v *= Math.max(1, value(s)) ** p;
    for (const [s, p] of Object.entries(t.log)) v *= Math.max(1, Math.log2(Math.max(2, value(s)))) ** p;
    for (const [s, b] of Object.entries(t.exp)) v *= b ** Math.min(60, value(s));
    for (const [s, k] of Object.entries(t.fact)) for (let i = 0; i < k; i++) v *= factorial(Math.min(20, value(s)));
    total += v;
  }
  return total;
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", ".": "·",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ",
  o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
};

function superscript(text: string): string | null {
  let out = "";
  for (const ch of text) {
    if (!(ch in SUPERSCRIPT)) return null;
    out += SUPERSCRIPT[ch];
  }
  return out;
}

function powerText(name: string, p: number): string {
  if (p === 1) return name;
  const exponent = Number.isInteger(p) ? String(p) : p.toFixed(2).replace(/0+$/, "");
  const sup = Number.isInteger(p) ? superscript(exponent) : null;
  return sup ? `${name}${sup}` : `${name}^${exponent}`;
}

function wrap(name: string): string {
  return name.length > 1 && /\W/.test(name) ? `(${name})` : name;
}

function termText(t: Term, name: (sym: string) => string, order: string[]): string {
  const byOrder = (a: string, b: string) => order.indexOf(a) - order.indexOf(b);
  const parts: string[] = [];
  for (const s of Object.keys(t.fact).sort(byOrder)) parts.push(powerText(`${wrap(name(s))}!`, t.fact[s]));
  for (const s of Object.keys(t.exp).sort(byOrder)) {
    const base = Number.isInteger(t.exp[s]) ? String(t.exp[s]) : t.exp[s].toFixed(2);
    const sup = superscript(name(s));
    parts.push(sup ? `${base}${sup}` : `${base}^${wrap(name(s))}`);
  }
  for (const s of Object.keys(t.pow).sort(byOrder)) parts.push(powerText(wrap(name(s)), t.pow[s]));
  let text = parts.join("·");
  const logs = Object.keys(t.log).sort(byOrder).map((s) => (t.log[s] === 1 ? `log ${name(s)}` : `log${superscript(String(t.log[s])) ?? `^${t.log[s]}`} ${name(s)}`));
  if (logs.length) text = text ? `${text} ${logs.join(" · ")}` : logs.join(" · ");
  return text || "1";
}

/** How big a term is, for listing the biggest first. */
function weight(t: Term): number[] {
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  return [sum(t.fact), Object.keys(t.exp).length, sum(t.pow), sum(t.log)];
}

/**
 * "O(n log n)". `name` turns a size into how it's shown (n, m, V, E);
 * `order` lists sizes in the order they should appear in a product.
 */
export function format(x: BigO, name: (sym: string) => string = (s) => s, order: string[] = []): string {
  if (!x.length) return "O(1)";
  const ord = [...order, ...sizesIn(x).filter((s) => !order.includes(s))];
  const terms = [...x].sort((a, b) => compareTuple(weight(b), weight(a)) || ord.indexOf(sizesIn([a])[0] ?? "") - ord.indexOf(sizesIn([b])[0] ?? ""));
  return `O(${terms.map((t) => termText(t, name, ord)).join(" + ")})`;
}
