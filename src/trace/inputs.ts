/**
 * Inputs you can switch between: `viz: input` on the line above a variable
 * set at the top of the program to a value written out (a list, a number,
 * a string, true or false) lets the run use another value instead, made
 * from the one written: sorted, reversed, random, empty, one item, and so
 * on. The code in the editor doesn't change: the value is swapped in the
 * code that's run, on the same lines, so every line number still matches.
 *
 *   # viz: input                     the next line's variable
 *   nums = [5, 3, 8, 1]
 *
 *   // viz: input nums, target       or these variables, wherever they're
 *                                    set at the top of the program
 *
 * Everything here is plain computation on the code's text (no tracing),
 * the same for Python, JavaScript and TypeScript.
 */
import { hintComments } from "./growth";

export type InputLanguage = "python" | "javascript" | "typescript";

/** A value written out in the code. */
export type Literal =
  | { kind: "num"; value: number; decimals: number | null }
  | { kind: "str"; value: string; quote: string }
  | { kind: "bool"; value: boolean }
  | { kind: "none"; text: string }
  | { kind: "list"; open: "[" | "("; items: Literal[] };

/** What sort of value an input is: which variants it has. */
export type InputKind = "numbers" | "strings" | "list" | "number" | "string" | "bool";

/** A `viz: input` variable: where its value is in the code, and what it is. */
export interface InputVar {
  name: string;
  /** The hint's line, 1-based. */
  hintLine: number;
  /** The assignment's line, 1-based. */
  line: number;
  /** The value's place in the code (offsets): what's swapped. */
  start: number;
  end: number;
  value: Literal;
  kind: InputKind;
  /** The value as written. */
  written: string;
}

/** Another value for an input: its id (what's chosen), its name in the menu, and its code. */
export interface InputVariant {
  id: string;
  label: string;
  text: string;
}

/** The variant chosen for an input, and the seed its random values come from. */
export interface InputChoice {
  variant: string;
  seed: number;
}

export interface InputProblem {
  line: number;
  message: string;
}

/** The variant that's the value as written. */
export const WRITTEN = "written";

const NAME = /^[A-Za-z_$][\w$]*$/;
const HINT = /^\s*(?:#|\/\/)\s*viz:\s*input\b\s*(.*?)\s*$/i;
/** A top-level assignment, up to its value: `nums = `, `const nums: number[] = `, `k: int = `. */
const ASSIGN = /^(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+?\s*)?=(?![=>])[ \t]*/;

const USAGE = `"input" goes on the line above a variable set at the top of the program, like: viz: input  then  nums = [5, 3, 8]  (or viz: input nums, target)`;
const unsupported = (name: string) =>
  `${name}: "input" works on a value written out: a list ([5, 3, 8]), a number, a string, or true or false; not on one that's worked out.`;

// ---------------------------------------------------------------- finding them

/** The `viz: input` variables in a program, with problems to show. */
export function findInputs(code: string, language: InputLanguage): { inputs: InputVar[]; problems: InputProblem[] } {
  const lines = code.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const inputs: InputVar[] = [];
  const problems: InputProblem[] = [];
  const isComment = (text: string) => /^\s*(#|\/\/)/.test(text);

  const fromLine = (index: number, hintLine: number, wanted: string | null): void => {
    const text = lines[index];
    const m = ASSIGN.exec(text);
    if (!m) return void problems.push({ line: hintLine, message: USAGE });
    const name = m[1];
    if (wanted && name !== wanted) return;
    if (inputs.some((v) => v.name === name)) return; // named twice: once is enough
    const start = starts[index] + m[0].length;
    const parsed = parseLiteral(code, start, language);
    if (!parsed) return void problems.push({ line: hintLine, message: unsupported(name) });
    const kind = kindOf(parsed.value);
    if (!kind) return void problems.push({ line: hintLine, message: unsupported(name) });
    inputs.push({
      name,
      hintLine,
      line: index + 1,
      start,
      end: parsed.end,
      value: parsed.value,
      kind,
      written: code.slice(start, parsed.end),
    });
  };

  for (const hint of hintComments(code)) {
    const m = HINT.exec(lines[hint.line - 1] ?? "");
    if (!m) continue; // not an input hint, or not a line of its own
    const rest = m[1];
    if (!rest) {
      // The next line that isn't blank or a comment (other hints can sit between).
      let next = hint.line;
      while (next < lines.length && (!lines[next].trim() || isComment(lines[next]))) next++;
      if (next >= lines.length) problems.push({ line: hint.line, message: USAGE });
      else fromLine(next, hint.line, null);
      continue;
    }
    const names = rest
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.some((n) => !NAME.test(n))) continue; // hints.ts says how it should look
    for (const name of names) {
      const index = lines.findIndex((text) => ASSIGN.exec(text)?.[1] === name);
      if (index < 0)
        problems.push({
          line: hint.line,
          message: `${name}: there's no "${name} = …" at the top level of the program for "input" to change.`,
        });
      else fromLine(index, hint.line, name);
    }
  }
  return { inputs: inputs.sort((a, b) => a.start - b.start), problems };
}

function kindOf(value: Literal): InputKind | null {
  switch (value.kind) {
    case "num":
      return "number";
    case "str":
      return "string";
    case "bool":
      return "bool";
    case "none":
      return null;
    case "list":
      if (value.items.length && value.items.every((v) => v.kind === "num")) return "numbers";
      if (value.items.length && value.items.every((v) => v.kind === "str")) return "strings";
      return "list";
  }
}

// ---------------------------------------------------------------- reading a value

/**
 * The value written at `at`, if it's one: numbers, strings, true / false,
 * None / null, and lists (or Python tuples) of them, over several lines if
 * it's in brackets. Then only a `;` or a comment before the line ends.
 */
export function parseLiteral(
  code: string,
  at: number,
  language: InputLanguage,
): { value: Literal; end: number } | null {
  let p = at;
  const comment = language === "python" ? "#" : "//";
  /** Spaces, and inside brackets new lines and comments too. */
  const skip = (inside: boolean) => {
    for (;;) {
      while (p < code.length && (code[p] === " " || code[p] === "\t" || (inside && /[\r\n]/.test(code[p])))) p++;
      if (inside && code.startsWith(comment, p)) {
        while (p < code.length && code[p] !== "\n") p++;
        continue;
      }
      return;
    }
  };

  const value = (inside: boolean): Literal | null => {
    skip(inside);
    const c = code[p];
    if (c === "[" || c === "(") {
      p++;
      const items: Literal[] = [];
      const close = c === "[" ? "]" : ")";
      let comma = false;
      for (;;) {
        skip(true);
        if (code[p] === close) {
          p++;
          break;
        }
        if (items.length && !comma) return null;
        const item = value(true);
        if (!item) return null;
        items.push(item);
        skip(true);
        comma = code[p] === ",";
        if (comma) p++;
      }
      // (5) is just 5 in parentheses; (5,) is a tuple.
      if (c === "(" && items.length === 1 && !comma) return items[0];
      return { kind: "list", open: c, items };
    }
    if (c === '"' || c === "'" || (c === "`" && language !== "python")) {
      let out = "";
      p++;
      while (p < code.length && code[p] !== c) {
        if (code[p] === "\n") return null;
        if (c === "`" && code.startsWith("${", p)) return null; // worked out, not written
        if (code[p] === "\\") {
          const e = code[p + 1];
          out += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "0" ? "\0" : e;
          p += 2;
          continue;
        }
        out += code[p++];
      }
      if (code[p] !== c) return null;
      p++;
      return { kind: "str", value: out, quote: c === "`" ? '"' : c };
    }
    const num = /^-?(?:\d[\d_]*(\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?(?![\w$.])/.exec(code.slice(p, p + 64));
    if (num) {
      p += num[0].length;
      const text = num[0].replace(/_/g, "");
      const decimals = /[.eE]/.test(text) ? (text.split(".")[1]?.replace(/[eE].*/, "").length ?? 0) : null;
      return { kind: "num", value: Number(text), decimals };
    }
    const word = /^[A-Za-z_]\w*/.exec(code.slice(p, p + 16))?.[0];
    if (word) {
      const bools: Record<string, boolean> =
        language === "python" ? { True: true, False: false } : { true: true, false: false };
      const nones = language === "python" ? ["None"] : ["null", "undefined"];
      if (word in bools) {
        p += word.length;
        return { kind: "bool", value: bools[word] };
      }
      if (nones.includes(word)) {
        p += word.length;
        return { kind: "none", text: word };
      }
    }
    return null;
  };

  const parsed = value(false);
  if (!parsed) return null;
  const end = p;
  // Only a ; or a comment may follow, on its line.
  const after = code.slice(end, code.indexOf("\n", end) < 0 ? code.length : code.indexOf("\n", end)).trim();
  if (after && !/^;?\s*$/.test(after) && !after.replace(/^;\s*/, "").startsWith(comment)) return null;
  return { value: parsed, end };
}

// ---------------------------------------------------------------- writing one

/** A value as code in the language. */
export function format(value: Literal, language: InputLanguage): string {
  switch (value.kind) {
    case "num":
      return formatNumber(value.value, value.decimals);
    case "str": {
      const q = value.quote;
      const escaped = value.value
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\r/g, "\\r")
        .split(q)
        .join(`\\${q}`);
      return `${q}${escaped}${q}`;
    }
    case "bool":
      return language === "python" ? (value.value ? "True" : "False") : String(value.value);
    case "none":
      return value.text;
    case "list": {
      const items = value.items.map((v) => format(v, language));
      if (value.open === "(") return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
      return `[${items.join(", ")}]`;
    }
  }
}

function formatNumber(n: number, decimals: number | null): string {
  if (decimals === null) return String(Math.round(n));
  // As many decimals as written (at least one, so it's still a float), more when they'd lose its value (half of 0.5).
  const fixed = n.toFixed(Math.min(6, Math.max(1, decimals)));
  if (Number(fixed) === n) return fixed;
  const more = String(Number(n.toFixed(6)));
  return /[.e]/.test(more) ? more : `${more}.0`;
}

// ---------------------------------------------------------------- the variants

/** Random numbers from a seed: the same seed, the same values (so a Live re-run keeps them). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // Shuffled into the same order (a short list): turned once more, so it's another order when there is one.
  if (out.length > 1 && out.every((v, i) => v === items[i])) out.push(out.shift() as T);
  return out;
}

const compare = (a: Literal, b: Literal): number => {
  if (a.kind === "num" && b.kind === "num") return a.value - b.value;
  if (a.kind === "str" && b.kind === "str") return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  return 0;
};

/** The variants of an input, the value as written first; random ones from `seed`. */
export function variantsOf(input: InputVar, language: InputLanguage, seed = 1): InputVariant[] {
  const random = seeded(seed);
  const out: InputVariant[] = [{ id: WRITTEN, label: "As written", text: input.written }];
  const add = (id: string, label: string, value: Literal) => out.push({ id, label, text: format(value, language) });
  const v = input.value;
  if (v.kind === "list") {
    const list = (items: Literal[]): Literal => ({ ...v, items });
    const items = v.items;
    if (input.kind === "numbers" || input.kind === "strings") {
      const sorted = [...items].sort(compare);
      add("sorted", "Sorted", list(sorted));
      add(
        "reversed",
        input.kind === "numbers" ? "Reversed (largest first)" : "Reversed (Z to A)",
        list(sorted.reverse()),
      );
    } else add("reversed", "Reversed", list([...items].reverse()));
    if (input.kind === "numbers") add("random", "Random", list(randomNumbers(items as NumLiteral[], random)));
    else if (items.length > 1) add("random", "Shuffled", list(shuffled(items, random)));
    add("empty", "Empty", list([]));
    if (items.length) add("one", "One item", list([items[0]]));
    if (input.kind === "numbers" && items.length > 1) add("same", "All the same", list(items.map(() => items[0])));
  } else if (v.kind === "num") {
    const int = v.decimals === null;
    const n = v.value;
    const num = (value: number): Literal => ({ ...v, value });
    add("zero", "0", num(0));
    add("one", "1", num(1));
    add("half", "Half", num(int ? Math.trunc(n / 2) : n / 2));
    add("double", "Double", num(n * 2));
    const top = Math.max(int ? 9 : 1, Math.abs(n) * 2);
    const r = random() * top * Math.sign(n || 1);
    add("random", "Random", num(int ? Math.round(r) : roundTo(r, Math.max(1, v.decimals ?? 1))));
  } else if (v.kind === "str") {
    const chars = [...v.value];
    const str = (value: string): Literal => ({ ...v, value });
    if (chars.length > 1) {
      add("reversed", "Reversed", str([...chars].reverse().join("")));
      add("random", "Shuffled", str(shuffled(chars, random).join("")));
    }
    add("empty", "Empty", str(""));
    if (chars.length) add("one", "One character", str(chars[0]));
  } else if (v.kind === "bool") {
    add("flip", format({ kind: "bool", value: !v.value }, language), { kind: "bool", value: !v.value });
  }
  // A variant that's what's written anyway: kept (it's still that kind of input), marked so.
  for (const variant of out.slice(1)) if (variant.text === input.written) variant.label += " (as written)";
  return out;
}

type NumLiteral = Extract<Literal, { kind: "num" }>;

const roundTo = (n: number, decimals: number) => Number(n.toFixed(Math.min(6, decimals)));

/** As many numbers as there are, between the least and the most written (from 0 to 99 when they're all the same). */
function randomNumbers(items: NumLiteral[], random: () => number): Literal[] {
  const values = items.map((v) => v.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo = Math.min(0, lo);
    hi = Math.max(lo + 99, hi);
  }
  const decimals = items.reduce<number | null>(
    (d, v) => (v.decimals === null ? d : Math.max(d ?? 0, v.decimals)),
    null,
  );
  return items.map(() => {
    const r = lo + random() * (hi - lo + (decimals === null ? 1 : 0));
    return { kind: "num", value: decimals === null ? Math.floor(r) : roundTo(r, decimals), decimals };
  });
}

// ---------------------------------------------------------------- the code that's run

/** An input that's run with another value: for the editor's note beside it. */
export interface AppliedInput {
  name: string;
  line: number;
  label: string;
  text: string;
}

/**
 * The code with each input's chosen value swapped in, on the same lines:
 * a value written over several lines keeps its line count (the new one's
 * new lines go before its closing bracket), so line numbers still match.
 */
export function applyInputs(
  code: string,
  language: InputLanguage,
  choices: ReadonlyMap<string, InputChoice>,
): { code: string; applied: AppliedInput[] } {
  if (!choices.size) return { code, applied: [] };
  const { inputs } = findInputs(code, language);
  const applied: AppliedInput[] = [];
  let out = "";
  let at = 0;
  for (const input of inputs) {
    const choice = choices.get(input.name);
    if (!choice || choice.variant === WRITTEN) continue;
    const variant = variantsOf(input, language, choice.seed).find((v) => v.id === choice.variant);
    if (!variant) continue;
    const newLines = input.written.split("\n").length - 1;
    let text = variant.text;
    if (newLines) text = `${text.slice(0, -1)}${"\n".repeat(newLines)}${text.slice(-1)}`;
    out += code.slice(at, input.start) + text;
    at = input.end;
    applied.push({ name: input.name, line: input.line, label: variant.label, text: variant.text });
  }
  return { code: out + code.slice(at), applied };
}
