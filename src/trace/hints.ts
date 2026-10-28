/**
 * `# viz:` / `// viz:` hints: comments that tell the canvas how to draw a
 * program when the automatic choices aren't what you want.
 *
 * The tracers only collect hint comments (with their line numbers). This
 * module parses them, the same way for every language, and applies them to
 * a trace before it's drawn. See the README's "Hints" section.
 *
 *   viz: hide temp, scratch          don't draw these variables
 *   viz: show total, seen            always include these in loop history
 *   viz: pointers nums: lo, hi       draw lo and hi as positions in nums
 *   viz: pointers grid[]: col        ...or as a column in a grid
 *   viz: tree Node(left, right)      draw Node objects as a binary tree
 *   viz: list Node(next)             draw Node objects as a linked list
 *   viz: graph adj                   draw adj as a graph (adjacency dict,
 *                                    list of lists, matrix or edge list)
 *   viz: graph Node(neighbors)       draw Node objects as a graph
 *   viz: graph adj directed: seen    ...with options, and variables to
 *                                    draw on it
 *   viz: plain adj                   never draw adj as a graph
 *   viz: window nums: [left, right]  draw the part of nums from left to
 *   viz: window s: [i, i + k)          right as a band (both ends in,
 *                                    unless written with ( or ); a string
 *                                    is drawn as a row of its characters)
 *   viz: size n                      n is the input size: Measure can
 *   viz: size n = 40000, k             rerun the program at smaller sizes
 *                                    to see how its cost grows
 */
import { parseExpr } from "./expr";
import {
  GRAPH_OPTIONS,
  type GraphOption,
  type HeapObject,
  type LinkedHint,
  type RawHint,
  type Step,
  type Trace,
  type Value,
  type VizHints,
  type WindowBound,
  type WindowHint,
} from "./types";

const NAME = /^[A-Za-z_$][\w$]*$/;
const CONTAINER = /^([A-Za-z_$][\w$]*)(\[\])?$/;
const CLASS_LINKS = /^([A-Za-z_$][\w$.]*)\s*\(([^)]*)\)$/;

export const KEYWORDS = [
  "hide",
  "show",
  "pointers",
  "window",
  "region",
  "compare",
  "chars",
  "bits",
  "format",
  "hex",
  "label",
  "rows",
  "focus",
  "watch",
  "check",
  "tree",
  "list",
  "graph",
  "plain",
  "size",
] as const;

/** Number formats `viz: format` knows: hex, bin, oct, or [,][.N](f|e|%), or just "," or ".N". */
export const FORMAT_SPEC = /^(hex|bin|oct|,?(?:\.\d{1,2})?[fe%]?)$/;
/** n, or n = 40000 */
const SIZE = /^([A-Za-z_$][\w$]*)\s*(?:=\s*([0-9][0-9_]*))?$/;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
/** graph <target>[(fields)] [options] [: names] */
const GRAPH = /^([A-Za-z_$][\w$.]*)\s*(?:\(([^)]*)\))?\s*([A-Za-z\s]*?)\s*(?::\s*(.*))?$/;

function names(text: string): string[] {
  return text
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

export function emptyHints(): VizHints {
  return {
    hide: [],
    show: [],
    pointers: {},
    windows: [],
    linked: [],
    graphs: [],
    plain: [],
    sizes: [],
    warnings: [],
  };
}

/** Parse hint comments. Anything that doesn't make sense becomes a warning. */
export function parseHints(raw: RawHint[]): VizHints {
  const hints = emptyHints();
  const warn = (line: number, message: string) => hints.warnings.push({ line, message });

  for (const { line, text } of raw) {
    // A hint still being typed ("viz:" and nothing yet): nothing to say about it.
    if (!text.trim()) continue;
    const match = /^([a-z]+)\b\s*(.*)$/i.exec(text);
    const keyword = match?.[1].toLowerCase() ?? "";
    const rest = match?.[2].trim() ?? "";
    if (!(KEYWORDS as readonly string[]).includes(keyword)) {
      warn(line, `Unknown hint "${text || "(empty)"}". Hints are: ${KEYWORDS.join(", ")}.`);
      continue;
    }

    if (keyword === "hide" || keyword === "show") {
      const list = names(rest);
      const bad = list.filter((n) => !NAME.test(n));
      if (!list.length || bad.length) {
        warn(line, `"${keyword}" needs variable names, like: viz: ${keyword} total, seen`);
        continue;
      }
      hints[keyword].push(...list);
      continue;
    }

    if (keyword === "pointers") {
      const [target, list] = rest.split(":").map((part) => part?.trim());
      const container = CONTAINER.exec(target ?? "");
      const pointerNames = names(list ?? "");
      if (!container || !pointerNames.length || pointerNames.some((n) => !NAME.test(n))) {
        warn(line, `"pointers" looks like: viz: pointers nums: lo, hi  (or grid[]: col for grid columns)`);
        continue;
      }
      const key = container[1] + (container[2] ?? "");
      hints.pointers[key] = [...new Set([...(hints.pointers[key] ?? []), ...pointerNames])];
      continue;
    }

    if (keyword === "region") {
      // Like a window, with an optional label in quotes at the end; a list can have several.
      const m = /^(.*?)\s*(?:(["'])(.*)\2)?$/.exec(rest)!;
      const region = parseWindow(m[1], line);
      if (!region) {
        warn(line, `"region" looks like: viz: region nums: [0, i) "sorted"  (the label is optional)`);
        continue;
      }
      const same = (hints.windows ?? []).filter((w) => w.container === region.container && w.region);
      region.region = { label: m[3] ?? null, index: same.length };
      hints.windows = [...(hints.windows ?? []), region];
      continue;
    }

    if (keyword === "compare") {
      const m = /^([A-Za-z_$][\w$.]*)\s*:\s*([^,]+?)\s*,\s*([^,]+?)\s*$/.exec(rest);
      const a = m && parseBound(m[2]);
      const b = m && parseBound(m[3]);
      if (!m || !a || !b) {
        warn(line, `"compare" looks like: viz: compare nums: j, j + 1  (two cells of a list)`);
        continue;
      }
      hints.compares = [
        ...(hints.compares ?? []),
        { container: m[1], a, b, text: `${m[2].trim()}, ${m[3].trim()}`, line },
      ];
      continue;
    }

    if (keyword === "chars") {
      const list = names(rest);
      if (!list.length || list.some((n) => !NAME.test(n))) {
        warn(line, `"chars" needs string variables, like: viz: chars s, word`);
        continue;
      }
      hints.chars = [...new Set([...(hints.chars ?? []), ...list])];
      continue;
    }

    if (keyword === "bits") {
      const m = /^(.*?)(?:\s+(\d+))?$/.exec(rest)!;
      const list = names(m[1]);
      const width = m[2] !== undefined ? Number(m[2]) : undefined;
      if (!list.length || list.some((n) => !NAME.test(n)) || (width !== undefined && (width < 1 || width > 64))) {
        warn(line, `"bits" looks like: viz: bits mask  or  viz: bits mask 8  (how many digits, 1 to 64)`);
        continue;
      }
      hints.bits = [...(hints.bits ?? []), { names: list, ...(width !== undefined ? { width } : {}), line }];
      continue;
    }

    if (keyword === "format" || keyword === "hex") {
      // format price .2f / format flags hex / hex flags, mask
      const parts = rest.split(/\s+/);
      const spec = keyword === "hex" ? "hex" : parts.length > 1 ? parts.pop()! : "";
      const list = names(keyword === "hex" ? rest : parts.join(" "));
      if (!list.length || list.some((n) => !NAME.test(n)) || !spec || !FORMAT_SPEC.test(spec)) {
        warn(
          line,
          keyword === "hex"
            ? `"hex" needs variable names, like: viz: hex flags`
            : `"format" looks like: viz: format price .2f  (formats: hex, bin, oct, ",", .2f, .3e, .1%)`,
        );
        continue;
      }
      hints.formats = [...(hints.formats ?? []), { names: list, spec, line }];
      continue;
    }

    if (keyword === "label") {
      const m = /^([A-Za-z_$][\w$.]*)\s+by\s+([A-Za-z_$][\w$]*)$/.exec(rest);
      if (!m) {
        warn(line, `"label" looks like: viz: label Node by val  (a class, and the field to name its boxes by)`);
        continue;
      }
      hints.labels = [
        ...(hints.labels ?? []).filter((l) => l.typeName !== m[1]),
        { typeName: m[1], field: m[2], line },
      ];
      continue;
    }

    if (keyword === "rows") {
      const m = /^by\s+(.+)$/.exec(rest);
      const list = m ? names(m[1]) : [];
      if (!list.length || list.some((n) => !NAME.test(n))) {
        warn(line, `"rows" looks like: viz: rows by i  (label the loop's rows by a variable)`);
        continue;
      }
      hints.rowsBy = [...new Set([...(hints.rowsBy ?? []), ...list])];
      continue;
    }

    if (keyword === "focus") {
      const lineMatch = /^line\s+(\d+)$/.exec(rest);
      const target: NonNullable<VizHints["focus"]>["target"] | null = !rest
        ? { next: true }
        : lineMatch
          ? { line: Number(lineMatch[1]) }
          : rest === "for" || rest === "while"
            ? { kind: rest }
            : rest === "all"
              ? { all: true }
              : null;
      if (!target) {
        warn(line, `"focus" looks like: viz: focus  (the loop below it), or focus line 12, focus while, focus all`);
        continue;
      }
      hints.focus = { target, line };
      continue;
    }

    if (keyword === "watch" || keyword === "check") {
      try {
        parseExpr(rest);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        warn(
          line,
          `"${keyword}" needs an expression, like: viz: ${keyword === "watch" ? "watch right - left + 1" : "check total == sum(nums)"} (${why})`,
        );
        continue;
      }
      if (keyword === "watch") hints.watches = [...(hints.watches ?? []), { text: rest, line }];
      else hints.checks = [...(hints.checks ?? []), { text: rest, line }];
      continue;
    }

    if (keyword === "window") {
      const window = parseWindow(rest, line);
      if (!window) {
        warn(
          line,
          `"window" looks like: viz: window nums: [left, right]  (both ends in), or [i, i + k)  (the end left out)`,
        );
        continue;
      }
      hints.windows = [...(hints.windows ?? []).filter((w) => w.container !== window.container || w.region), window];
      continue;
    }

    if (keyword === "size") {
      const parts = names(rest).map((part) => SIZE.exec(part));
      if (!parts.length || parts.some((m) => !m)) {
        warn(
          line,
          `"size" looks like: viz: size n  or  viz: size n = 40000, k  (variables set to a number at the top of the program)`,
        );
        continue;
      }
      for (const m of parts as RegExpExecArray[]) {
        const value = m[2] !== undefined ? Number(m[2].replace(/_/g, "")) : undefined;
        hints.sizes = [
          ...hints.sizes.filter((s) => s.name !== m[1]),
          { name: m[1], ...(value !== undefined ? { value } : {}), line },
        ];
      }
      continue;
    }

    if (keyword === "plain") {
      const list = names(rest);
      if (!list.length || list.some((n) => !DOTTED.test(n))) {
        warn(line, `"plain" needs variable or class names, like: viz: plain graph`);
        continue;
      }
      hints.plain.push(...list);
      continue;
    }

    if (keyword === "graph") {
      const match = GRAPH.exec(rest);
      const fields = match?.[2] !== undefined ? names(match[2]) : undefined;
      const options = (match?.[3] ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((o) => o.toLowerCase());
      const drawn = names(match?.[4] ?? "");
      if (
        !match ||
        !DOTTED.test(match[1]) ||
        (fields && (!fields.length || fields.some((n) => !NAME.test(n)))) ||
        drawn.some((n) => !DOTTED.test(n))
      ) {
        warn(
          line,
          `"graph" looks like: viz: graph adj  (a variable), or viz: graph Node(neighbors)  (a class and its neighbor field), optionally followed by options and ": names to draw on it"`,
        );
        continue;
      }
      const unknown = options.filter((o) => !(GRAPH_OPTIONS as readonly string[]).includes(o));
      if (unknown.length) {
        warn(line, `Unknown graph option "${unknown[0]}". Options are: ${GRAPH_OPTIONS.join(", ")}.`);
        continue;
      }
      hints.graphs = [
        ...hints.graphs.filter((g) => g.target !== match[1]),
        {
          target: match[1],
          ...(fields ? { fields } : {}),
          options: options as GraphOption[],
          names: drawn,
          line,
        },
      ];
      continue;
    }

    // tree / list
    const shape = CLASS_LINKS.exec(rest);
    const links = shape ? names(shape[2]) : [];
    const want = keyword === "tree" ? 2 : 1;
    if (!shape || links.length !== want || links.some((n) => !NAME.test(n))) {
      warn(
        line,
        keyword === "tree"
          ? `"tree" looks like: viz: tree Node(left, right)  (a class and its two child fields)`
          : `"list" looks like: viz: list Node(next)  (a class and its link field)`,
      );
      continue;
    }
    const linked: LinkedHint = { shape: keyword as "tree" | "list", typeName: shape[1], links, line };
    hints.linked = [...hints.linked.filter((h) => h.typeName !== linked.typeName), linked];
  }
  return hints;
}

/** `nums: [left, right]`, `s: [i, i + k)`, or without brackets `nums: lo, hi` (both ends in). */
const WINDOW = /^([A-Za-z_$][\w$.]*)\s*:\s*([[(]?)\s*([^,]+?)\s*,\s*([^,]+?)\s*([\])]?)$/;
const TERM = /^([A-Za-z_$][\w$]*|[0-9]+)$/;

/** An index written as names and whole numbers added and taken away: `i + k - 1`. */
export function parseBound(text: string): WindowBound | null {
  const tokens = text.replace(/\s+/g, "").match(/[+-]|[^+-]+/g);
  if (!tokens) return null;
  const terms: WindowBound["terms"] = [];
  let sign: 1 | -1 = 1;
  let expectTerm = true;
  for (const token of tokens) {
    if (token === "+" || token === "-") {
      if (!expectTerm && terms.length) {
        sign = token === "-" ? -1 : 1;
        expectTerm = true;
        continue;
      }
      if (terms.length === 0 && expectTerm) {
        sign = token === "-" ? -1 : 1;
        continue;
      }
      return null;
    }
    if (!expectTerm || !TERM.test(token)) return null;
    terms.push(/^[0-9]/.test(token) ? { sign, value: Number(token) } : { sign, name: token });
    sign = 1;
    expectTerm = false;
  }
  return terms.length && !expectTerm ? { terms } : null;
}

function parseWindow(rest: string, line: number): WindowHint | null {
  const m = WINDOW.exec(rest);
  if (!m) return null;
  const [, container, open, startText, endText, close] = m;
  // Brackets come in pairs: both or neither.
  if (!open !== !close) return null;
  const start = parseBound(startText);
  const end = parseBound(endText);
  if (!start || !end) return null;
  return {
    container,
    start,
    end,
    startOpen: open === "(",
    endOpen: close === ")",
    text: `${open || "["}${startText.trim()}, ${endText.trim()}${close || "]"}`,
    line,
  };
}

/** A name the window ends on by itself (`left` in `[left, right]`), which is drawn as a pointer too. */
const loneName = (bound: WindowBound): string | null =>
  bound.terms.length === 1 && bound.terms[0].name && bound.terms[0].sign === 1 ? bound.terms[0].name : null;

/**
 * A string's characters from its repr: Python's 'abc' (or "it's"), or
 * JavaScript's "abc", with the escapes either writes. Null when it can't
 * be read back exactly (a shortened string).
 */
export function charsOf(value: Value): string[] | null {
  if (value.kind !== "prim" || (value.type !== "str" && value.type !== "string")) return null;
  if (value.length !== undefined) return null; // shortened: not all of it is here
  const repr = value.repr;
  const quote = repr[0];
  if (repr.length < 2 || (quote !== "'" && quote !== '"' && quote !== "`") || repr[repr.length - 1] !== quote)
    return null;
  const body = repr.slice(1, -1);
  const out: string[] = [];
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    "0": "\0",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "`": "`",
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      // A whole code point, so emoji stay one character.
      const cp = body.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push(ch);
      i += ch.length - 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (next in simple) {
      out.push(simple[next]);
      i++;
    } else if (next === "x" && /^[0-9a-f]{2}$/i.test(body.slice(i + 2, i + 4))) {
      out.push(String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 4), 16)));
      i += 3;
    } else if (next === "u" && /^[0-9a-f]{4}$/i.test(body.slice(i + 2, i + 6))) {
      out.push(String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 6), 16)));
      i += 5;
    } else if (next === "U" && /^[0-9a-f]{8}$/i.test(body.slice(i + 2, i + 10))) {
      out.push(String.fromCodePoint(Number.parseInt(body.slice(i + 2, i + 10), 16)));
      i += 9;
    } else return null;
  }
  // \ud83d\ude00 written as two escapes is still one character.
  for (let i = out.length - 2; i >= 0; i--) {
    if (/^[\ud800-\udbff]$/.test(out[i]) && /^[\udc00-\udfff]$/.test(out[i + 1])) out.splice(i, 2, out[i] + out[i + 1]);
  }
  return out;
}

/** Strings longer than this stay strings: a window over them would be too wide to read. */
const MAX_STRING_CELLS = 200;

/** How a number is shown with a `format` spec (FORMAT_SPEC), from its repr; null if it isn't a number. */
export function formatNumber(repr: string, spec: string): string | null {
  const trimmed = repr.replace(/n$/, ""); // JavaScript BigInt
  if (!/^-?(\d+\.?\d*(e[-+]?\d+)?|\.\d+|inf|Infinity)$/i.test(trimmed)) return null;
  if (spec === "hex" || spec === "bin" || spec === "oct") {
    if (!/^-?\d+$/.test(trimmed)) return null;
    const big = BigInt(trimmed);
    const abs = big < 0n ? -big : big;
    const [base, prefix] = spec === "hex" ? [16, "0x"] : spec === "bin" ? [2, "0b"] : [8, "0o"];
    return `${big < 0n ? "-" : ""}${prefix}${abs.toString(base)}`;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return repr;
  const m = /^(,)?(?:\.(\d{1,2}))?([fe%])?$/.exec(spec);
  if (!m) return null;
  const [, comma, digits, kind] = m;
  const places = digits !== undefined ? Number(digits) : undefined;
  let text: string;
  if (kind === "e") return n.toExponential(places ?? 6);
  if (kind === "%") text = `${(n * 100).toFixed(places ?? 0)}`;
  else if (kind === "f" || places !== undefined) text = n.toFixed(places ?? 6);
  else text = trimmed;
  if (comma) {
    const [whole, frac] = text.split(".");
    const sign = whole.startsWith("-") ? "-" : "";
    const grouped = whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    text = `${sign}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
  }
  return kind === "%" ? `${text}%` : text;
}

const NUMERIC = new Set(["int", "float", "number", "bigint"]);

/** A whole number's binary digits, `width` of them; null for a negative or non-whole number. */
function bitsOf(value: Value, width: number): string[] | null {
  if (value.kind !== "prim" || !NUMERIC.has(value.type)) return null;
  const repr = value.repr.replace(/n$/, "");
  if (!/^\d+$/.test(repr)) return null;
  const digits = BigInt(repr).toString(2);
  return (digits.length > width ? digits : digits.padStart(width, "0")).split("");
}

/** What `viz: chars`, `bits` and `format` turn a program's values into. */
interface ValueRules {
  /** Strings drawn as lists of their characters. */
  chars: Set<string>;
  /** Whole numbers drawn as their bits, this many. */
  bits: Map<string, number>;
  /** Numbers shown in a format. */
  formats: Map<string, string>;
}

/**
 * Hinted values, as they're drawn, on every step: a string as a list of
 * its characters, a number as a list of its bits, numbers formatted. The
 * new lists' ids are the frame and name, so each is the same object from
 * step to step and animates like any list.
 */
function transformValues(steps: Step[], rules: ValueRules): Step[] {
  if (!rules.chars.size && !rules.bits.size && !rules.formats.size) return steps;
  return steps.map((step) => {
    let heap: Record<string, HeapObject> | null = null;
    const writable = () => {
      heap ??= { ...step.heap };
      return heap;
    };
    const formatted = (value: Value, spec: string): Value => {
      if (value.kind !== "prim" || !NUMERIC.has(value.type)) return value;
      const repr = formatNumber(value.repr, spec);
      return repr === null ? value : { ...value, repr };
    };
    const convert = (frame: Step["stack"][number]) => {
      let changed = false;
      const locals = frame.locals.map(([name, value]): [string, Value] => {
        const spec = rules.formats.get(name);
        if (spec !== undefined) {
          if (value.kind === "prim") {
            const next = formatted(value, spec);
            if (next !== value) {
              changed = true;
              return [name, next];
            }
          } else {
            // The numbers in a list or dict it holds.
            const obj = (heap ?? step.heap)[value.id];
            if (obj && (obj.kind === "list" || obj.kind === "tuple" || obj.kind === "set")) {
              writable()[obj.id] = { ...obj, items: obj.items.map((v) => formatted(v, spec)) };
            } else if (obj?.kind === "dict") {
              writable()[obj.id] = { ...obj, entries: obj.entries.map(([k, v]) => [k, formatted(v, spec)]) };
            }
          }
        }
        const width = rules.bits.get(name);
        if (width !== undefined) {
          const digits = bitsOf(value, width);
          if (digits) {
            const id = `bits:${frame.id}:${name}`;
            const type = value.kind === "prim" ? value.type : "int";
            writable()[id] = {
              kind: "list",
              id,
              typeName: "bits",
              items: digits.map((d) => ({ kind: "prim", type, repr: d })),
              length: digits.length,
            };
            changed = true;
            return [name, { kind: "ref", id }];
          }
        }
        if (rules.chars.has(name)) {
          const chars = charsOf(value);
          if (chars && chars.length <= MAX_STRING_CELLS) {
            const id = `str:${frame.id}:${name}`;
            const type = value.kind === "prim" && value.type === "str" ? "str" : "string";
            writable()[id] = {
              kind: "list",
              id,
              typeName: type,
              items: chars.map((c) => ({ kind: "prim", type, repr: type === "str" ? pyRepr(c) : JSON.stringify(c) })),
              length: chars.length,
              ...(value.kind === "prim" && value.size !== undefined ? { size: value.size } : {}),
            };
            changed = true;
            return [name, { kind: "ref", id }];
          }
        }
        return [name, value];
      });
      return changed ? { ...frame, locals } : frame;
    };
    const stack = step.stack.map(convert);
    const suspended = step.suspended?.map(convert);
    const out = heap ? { ...step, heap } : step;
    return stack.some((f, i) => f !== step.stack[i]) || heap
      ? { ...out, stack, ...(suspended ? { suspended } : {}) }
      : step;
  });
}

/** The most binary digits a hinted number takes anywhere in the run: its bits' width, so it doesn't change. */
function widestBits(steps: Step[], names: Set<string>): Map<string, number> {
  const widths = new Map<string, number>();
  for (const step of steps)
    for (const frame of [...step.stack, ...(step.suspended ?? [])])
      for (const [name, value] of frame.locals) {
        if (!names.has(name)) continue;
        const digits = bitsOf(value, 1);
        if (digits) widths.set(name, Math.max(widths.get(name) ?? 1, digits.length));
      }
  return widths;
}

/** One character as Python writes it: 'a', '\\'', '\\n'. */
function pyRepr(c: string): string {
  if (c === "'") return `"'"`;
  const escaped = c.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");
  return `'${escaped}'`;
}

/**
 * Apply a trace's hints: hidden variables are removed from every step,
 * pointer hints join the index analysis, and the rest is kept on
 * `trace.viz` for the renderers.
 */
export function applyHints(trace: Trace): Trace {
  // SQL has one hint of its own (`-- viz: database shop`, read by its tracer), which leaves it only the rest to warn about.
  if (trace.language === "sql") {
    const viz = emptyHints();
    for (const { line, text } of trace.hints ?? [])
      viz.warnings.push({ line, message: `Unknown hint "${text || "(empty)"}". SQL has one: viz: database <name>.` });
    return { ...trace, viz };
  }
  const viz = parseHints(trace.hints ?? []);
  if (!trace.hints?.length) return { ...trace, viz };

  const hidden = new Set(viz.hide);
  const filtered = hidden.size
    ? trace.steps.map((step) => ({
        ...step,
        stack: step.stack.map((frame) => ({ ...frame, locals: frame.locals.filter(([name]) => !hidden.has(name)) })),
        suspended: step.suspended?.map((frame) => ({
          ...frame,
          locals: frame.locals.filter(([name]) => !hidden.has(name)),
        })),
      }))
    : trace.steps;
  const windows = viz.windows ?? [];
  const compares = viz.compares ?? [];
  // A string a window, region or compare is over is drawn as its characters too.
  const chars = new Set([
    ...(viz.chars ?? []),
    ...windows.map((w) => w.container),
    ...compares.map((c) => c.container),
  ]);
  const bitNames = new Set((viz.bits ?? []).flatMap((b) => b.names));
  const widest = widestBits(filtered, bitNames);
  const bits = new Map<string, number>();
  for (const hint of viz.bits ?? []) for (const name of hint.names) bits.set(name, hint.width ?? widest.get(name) ?? 1);
  const formats = new Map<string, string>();
  for (const hint of viz.formats ?? []) for (const name of hint.names) formats.set(name, hint.spec);
  const steps = transformValues(filtered, { chars, bits, formats });

  const indexNames = { ...trace.indexNames };
  const addIndexNames = (key: string, list: string[]) => {
    indexNames[key] = [...new Set([...(indexNames[key] ?? []), ...list])].sort();
  };
  for (const [key, list] of Object.entries(viz.pointers)) addIndexNames(key, list);
  // A window's ends, when each is just a name, are pointers too. A name
  // only ever added to an end (k in [i, i + k)) is a length, not a place:
  // it isn't drawn as a pointer, unless a pointers hint says so.
  const ends = [
    ...windows.map((w) => ({ container: w.container, bounds: [w.start, w.end] })),
    ...compares.map((c) => ({ container: c.container, bounds: [c.a, c.b] })),
  ];
  const lone = new Map<string, Set<string>>();
  for (const { container, bounds } of ends) {
    const names = bounds.map(loneName).filter((n) => n !== null);
    addIndexNames(container, names);
    lone.set(container, new Set([...(lone.get(container) ?? []), ...names, ...(viz.pointers[container] ?? [])]));
  }
  for (const { container, bounds } of ends) {
    const asked = lone.get(container)!;
    const lengths = bounds.flatMap((b) =>
      b.terms.flatMap((term) => (term.name && !asked.has(term.name) ? [term.name] : [])),
    );
    indexNames[container] = indexNames[container].filter((n) => !lengths.includes(n));
  }
  return { ...trace, steps, indexNames, viz };
}

/**
 * The loop a `viz: focus` hint picks, by its id, or "all" for nested loops
 * together; null without one (or when no loop matches).
 */
export function focusedLoop(trace: Pick<Trace, "loops" | "viz">): string | "all" | null {
  const focus = trace.viz?.focus;
  if (!focus) return null;
  const target = focus.target;
  if ("all" in target) return "all";
  const loops = [...trace.loops].sort((a, b) => a.line - b.line);
  if ("next" in target) return loops.find((l) => l.line > focus.line)?.id ?? null;
  if ("line" in target) return loops.find((l) => l.line === target.line)?.id ?? null;
  return loops.find((l) => l.kind === target.kind)?.id ?? null;
}
