/**
 * Small expressions in hints (`viz: watch right - left + 1`,
 * `viz: check total == sum(nums[left:right + 1])`), worked out against a
 * step's variables. Not a language: arithmetic, comparisons, and/or/not,
 * `in`, indexing and slicing, `.length`, and a few functions (len, sum,
 * min, max, abs, round, int). Python and JavaScript spellings both work
 * (`and` or `&&`, `True` or `true`, `==` or `===`).
 *
 * It only reads: nothing here can change the program or run its code.
 * Anything it can't work out (a name that isn't set, a list index out of
 * range) is an error, which callers show as "?" or leave out.
 */
import type { HeapObject, Value } from "./types";

// ---------------------------------------------------------------- parsing

export type Expr =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "const"; v: boolean | null }
  | { t: "name"; v: string }
  | { t: "unary"; op: "-" | "not"; e: Expr }
  | { t: "bin"; op: string; a: Expr; b: Expr }
  | { t: "call"; f: string; args: Expr[] }
  | { t: "index"; e: Expr; i: Expr }
  | { t: "slice"; e: Expr; from: Expr | null; to: Expr | null }
  | { t: "member"; e: Expr; name: string }
  | { t: "list"; items: Expr[] };

const TOKEN =
  /\s*(?:(\d+\.\d*|\.\d+|\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_$][\w$]*)|(===|!==|==|!=|<=|>=|\*\*|\/\/|&&|\|\||[-+*/%<>()[\]:,.!]))/y;

type Token = { kind: "num" | "str" | "name" | "op"; text: string };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (!m) throw new Error(`can't read "${text.slice(at).trim()}"`);
    at = TOKEN.lastIndex;
    if (m[1] !== undefined) out.push({ kind: "num", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "str", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "name", text: m[3] });
    else out.push({ kind: "op", text: m[4] });
  }
  return out;
}

const FUNCTIONS = new Set(["len", "sum", "min", "max", "abs", "round", "int"]);

/** Read an expression, or throw saying what's wrong. */
export function parseExpr(text: string): Expr {
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (...ops: string[]) => peek()?.kind === "op" && ops.includes(peek().text);
  const isWord = (...words: string[]) => peek()?.kind === "name" && words.includes(peek().text);
  const expect = (op: string) => {
    if (!isOp(op)) throw new Error(`expected "${op}"`);
    i++;
  };

  const or = (): Expr => {
    let a = and();
    while (isOp("||") || isWord("or")) {
      i++;
      a = { t: "bin", op: "or", a, b: and() };
    }
    return a;
  };
  const and = (): Expr => {
    let a = not();
    while (isOp("&&") || isWord("and")) {
      i++;
      a = { t: "bin", op: "and", a, b: not() };
    }
    return a;
  };
  const not = (): Expr => {
    if (isOp("!") || isWord("not")) {
      i++;
      return { t: "unary", op: "not", e: not() };
    }
    return compare();
  };
  const compare = (): Expr => {
    const a = additive();
    if (isOp("==", "===", "!=", "!==", "<", "<=", ">", ">=")) {
      const op = { "===": "==", "!==": "!=" }[peek().text] ?? peek().text;
      i++;
      return { t: "bin", op, a, b: additive() };
    }
    if (isWord("in")) {
      i++;
      return { t: "bin", op: "in", a, b: additive() };
    }
    if (isWord("not") && tokens[i + 1]?.kind === "name" && tokens[i + 1].text === "in") {
      i += 2;
      return { t: "unary", op: "not", e: { t: "bin", op: "in", a, b: additive() } };
    }
    return a;
  };
  const additive = (): Expr => {
    let a = multiplicative();
    while (isOp("+", "-")) {
      const op = peek().text;
      i++;
      a = { t: "bin", op, a, b: multiplicative() };
    }
    return a;
  };
  const multiplicative = (): Expr => {
    let a = unary();
    while (isOp("*", "/", "//", "%")) {
      const op = peek().text;
      i++;
      a = { t: "bin", op, a, b: unary() };
    }
    return a;
  };
  const unary = (): Expr => {
    if (isOp("-")) {
      i++;
      return { t: "unary", op: "-", e: unary() };
    }
    if (isOp("+")) {
      i++;
      return unary();
    }
    return power();
  };
  const power = (): Expr => {
    const a = postfix();
    if (isOp("**")) {
      i++;
      return { t: "bin", op: "**", a, b: unary() };
    }
    return a;
  };
  const postfix = (): Expr => {
    let e = atom();
    for (;;) {
      if (isOp("[")) {
        i++;
        const from = isOp(":") ? null : or();
        if (isOp(":")) {
          i++;
          const to = isOp("]") ? null : or();
          expect("]");
          e = { t: "slice", e, from, to };
        } else {
          expect("]");
          e = { t: "index", e, i: from! };
        }
      } else if (isOp(".")) {
        i++;
        const name = peek();
        if (name?.kind !== "name") throw new Error("expected a name after a dot");
        i++;
        e = { t: "member", e, name: name.text };
      } else return e;
    }
  };
  const atom = (): Expr => {
    const tok = peek();
    if (!tok) throw new Error("unfinished expression");
    i++;
    if (tok.kind === "num") return { t: "num", v: Number(tok.text) };
    if (tok.kind === "str") return { t: "str", v: unquote(tok.text) };
    if (tok.kind === "name") {
      if (tok.text === "True" || tok.text === "true") return { t: "const", v: true };
      if (tok.text === "False" || tok.text === "false") return { t: "const", v: false };
      if (tok.text === "None" || tok.text === "null" || tok.text === "undefined") return { t: "const", v: null };
      if (isOp("(")) {
        if (!FUNCTIONS.has(tok.text))
          throw new Error(`"${tok.text}" isn't a function hints know (${[...FUNCTIONS].join(", ")})`);
        i++;
        const args: Expr[] = [];
        while (!isOp(")")) {
          args.push(or());
          if (!isOp(")")) expect(",");
        }
        i++;
        return { t: "call", f: tok.text, args };
      }
      return { t: "name", v: tok.text };
    }
    if (tok.text === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (tok.text === "[") {
      const items: Expr[] = [];
      while (!isOp("]")) {
        items.push(or());
        if (!isOp("]")) expect(",");
      }
      i++;
      return { t: "list", items };
    }
    throw new Error(`unexpected "${tok.text}"`);
  };

  if (!tokens.length) throw new Error("nothing to work out");
  const e = or();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i].text}"`);
  return e;
}

function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
}

/** The names an expression reads, for "did you mean" and completions. */
export function namesIn(e: Expr): string[] {
  switch (e.t) {
    case "name":
      return [e.v];
    case "unary":
      return namesIn(e.e);
    case "bin":
      return [...namesIn(e.a), ...namesIn(e.b)];
    case "call":
      return e.args.flatMap(namesIn);
    case "index":
      return [...namesIn(e.e), ...namesIn(e.i)];
    case "slice":
      return [...namesIn(e.e), ...(e.from ? namesIn(e.from) : []), ...(e.to ? namesIn(e.to) : [])];
    case "member":
      return namesIn(e.e);
    case "list":
      return e.items.flatMap(namesIn);
    default:
      return [];
  }
}

const cache = new Map<string, Expr | Error>();
/** parseExpr, remembered: hints are worked out at every step. */
export function compiled(text: string): Expr {
  let e = cache.get(text);
  if (!e) {
    try {
      e = parseExpr(text);
    } catch (error) {
      e = error instanceof Error ? error : new Error(String(error));
    }
    cache.set(text, e);
  }
  if (e instanceof Error) throw e;
  return e;
}

// ---------------------------------------------------------------- working it out

/** A value an expression works with. */
export type Val = number | string | boolean | null | Val[] | { dict: [Val, Val][] };

/** A program's value as an expression value: lists become arrays (a few levels deep). */
export function toVal(value: Value, heap: Record<string, HeapObject>, depth = 0): Val {
  if (value.kind === "prim") return primVal(value.type, value.repr);
  const obj = heap[value.id];
  if (!obj || depth > 3) throw new Error("can't read that value");
  if (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set") {
    if (obj.length > obj.items.length) throw new Error("only part of that list was recorded");
    return obj.items.map((v) => toVal(v, heap, depth + 1));
  }
  if (obj.kind === "dict")
    return { dict: obj.entries.map(([k, v]) => [toVal(k, heap, depth + 1), toVal(v, heap, depth + 1)]) };
  throw new Error("can't use that kind of value");
}

function primVal(type: string, repr: string): Val {
  switch (type) {
    case "int":
    case "float":
    case "number":
    case "bigint": {
      if (repr === "inf" || repr === "Infinity") return Number.POSITIVE_INFINITY;
      if (repr === "-inf" || repr === "-Infinity") return Number.NEGATIVE_INFINITY;
      const n = Number(repr.replace(/n$/, ""));
      if (Number.isNaN(n) && repr !== "nan" && repr !== "NaN") throw new Error("not a number");
      return n;
    }
    case "bool":
    case "boolean":
      return repr === "True" || repr === "true";
    case "none":
    case "null":
    case "undefined":
      return null;
    case "str":
    case "string":
    case "key":
      return /^(['"`]).*\1$/s.test(repr) ? unquote(repr) : repr;
    default:
      throw new Error("can't use that kind of value");
  }
}

const isNum = (v: Val): v is number => typeof v === "number";
const isList = (v: Val): v is Val[] => Array.isArray(v);
const isDict = (v: Val): v is { dict: [Val, Val][] } => typeof v === "object" && v !== null && "dict" in v;
const num = (v: Val): number => {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (!isNum(v)) throw new Error("not a number");
  return v;
};

function equal(a: Val, b: Val): boolean {
  if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isDict(a) || isDict(b)) return false;
  return a === b;
}

function truthy(v: Val): boolean {
  if (isList(v)) return v.length > 0;
  if (isDict(v)) return v.dict.length > 0;
  return !!v;
}

function sequence(v: Val): Val[] {
  if (isList(v)) return v;
  if (typeof v === "string") return [...v];
  if (isDict(v)) return v.dict.map(([k]) => k);
  throw new Error("not a list");
}

/** Work out an expression with these variables. Throws when it can't. */
export function evaluate(
  e: Expr,
  lookup: (name: string) => Val,
  language: "python" | "javascript" | "typescript" = "python",
): Val {
  const ev = (x: Expr): Val => evaluate(x, lookup, language);
  switch (e.t) {
    case "num":
    case "str":
    case "const":
      return e.v;
    case "name":
      return lookup(e.v);
    case "unary":
      return e.op === "-" ? -num(ev(e.e)) : !truthy(ev(e.e));
    case "bin": {
      if (e.op === "and") {
        const a = ev(e.a);
        return truthy(a) ? ev(e.b) : a;
      }
      if (e.op === "or") {
        const a = ev(e.a);
        return truthy(a) ? a : ev(e.b);
      }
      const [a, b] = [ev(e.a), ev(e.b)];
      switch (e.op) {
        case "+":
          if (typeof a === "string" && typeof b === "string") return a + b;
          if (isList(a) && isList(b)) return [...a, ...b];
          return num(a) + num(b);
        case "-":
          return num(a) - num(b);
        case "*":
          return num(a) * num(b);
        case "/":
          return num(a) / num(b);
        case "//":
          return Math.floor(num(a) / num(b));
        case "%": {
          const [x, y] = [num(a), num(b)];
          // Python's % takes the divisor's sign; JavaScript's the dividend's.
          return language === "python" ? ((x % y) + y) % y : x % y;
        }
        case "**":
          return num(a) ** num(b);
        case "==":
          return equal(a, b);
        case "!=":
          return !equal(a, b);
        case "<":
        case "<=":
        case ">":
        case ">=": {
          const [x, y] = typeof a === "string" && typeof b === "string" ? [a, b] : [num(a), num(b)];
          return e.op === "<" ? x < y : e.op === "<=" ? x <= y : e.op === ">" ? x > y : x >= y;
        }
        case "in":
          if (typeof b === "string") return typeof a === "string" && b.includes(a);
          return sequence(b).some((x) => equal(x, a));
      }
      throw new Error(`can't do "${e.op}"`);
    }
    case "call": {
      const args = e.args.map(ev);
      const one = () => {
        if (args.length !== 1) throw new Error(`${e.f} takes one value`);
        return args[0];
      };
      switch (e.f) {
        case "len":
          return sequence(one()).length;
        case "sum":
          return sequence(one()).reduce<number>((total, x) => total + num(x), 0);
        case "abs":
          return Math.abs(num(one()));
        case "int":
          return Math.trunc(num(one()));
        case "round":
          return args.length === 2
            ? Math.round(num(args[0]) * 10 ** num(args[1])) / 10 ** num(args[1])
            : Math.round(num(one()));
        case "min":
        case "max": {
          const list = args.length === 1 ? sequence(args[0]) : args;
          if (!list.length) throw new Error(`${e.f} of nothing`);
          const nums = list.map(num);
          return e.f === "min" ? Math.min(...nums) : Math.max(...nums);
        }
      }
      throw new Error(`no function ${e.f}`);
    }
    case "index": {
      const [v, k] = [ev(e.e), ev(e.i)];
      if (isDict(v)) {
        const hit = v.dict.find(([key]) => equal(key, k));
        if (!hit) throw new Error("no such key");
        return hit[1];
      }
      const list = sequence(v);
      let at = num(k);
      if (at < 0 && language === "python") at += list.length;
      if (!Number.isInteger(at) || at < 0 || at >= list.length) throw new Error("index out of range");
      return list[at];
    }
    case "slice": {
      const v = ev(e.e);
      const list = sequence(v);
      const clamp = (x: number) => Math.max(0, Math.min(list.length, x < 0 ? list.length + x : x));
      const from = e.from ? clamp(num(ev(e.from))) : 0;
      const to = e.to ? clamp(num(ev(e.to))) : list.length;
      const part = list.slice(from, Math.max(from, to));
      return typeof v === "string" ? part.join("") : part;
    }
    case "list":
      return e.items.map(ev);
    case "member": {
      const v = ev(e.e);
      if (e.name === "length" || e.name === "size") return sequence(v).length;
      throw new Error(`can't read .${e.name}`);
    }
  }
}

/** A value as the program's language would print it. */
export function showVal(v: Val, language: "python" | "javascript" | "typescript" = "python"): string {
  const py = language === "python";
  if (v === null) return py ? "None" : "null";
  if (typeof v === "boolean") return py ? (v ? "True" : "False") : String(v);
  if (typeof v === "number") {
    if (Number.isInteger(v) || !Number.isFinite(v))
      return Number.isFinite(v) ? String(v) : py ? (v > 0 ? "inf" : "-inf") : String(v);
    return String(Number(v.toPrecision(6)));
  }
  if (typeof v === "string") return py ? `'${v}'` : JSON.stringify(v);
  if (isList(v)) return `[${v.map((x) => showVal(x, language)).join(", ")}]`;
  return `{${v.dict.map(([k, x]) => `${showVal(k, language)}: ${showVal(x, language)}`).join(", ")}}`;
}

/** Work out a hint's expression with a frame's variables: its value, or null when it can't be worked out here. */
export function evaluateText(
  text: string,
  locals: Map<string, Value>,
  heap: Record<string, HeapObject>,
  language: "python" | "javascript" | "typescript" = "python",
): Val | undefined {
  try {
    return evaluate(
      compiled(text),
      (name) => {
        const value = locals.get(name);
        if (!value) throw new Error(`${name} isn't set`);
        return toVal(value, heap);
      },
      language,
    );
  } catch {
    return undefined;
  }
}

export { truthy };
