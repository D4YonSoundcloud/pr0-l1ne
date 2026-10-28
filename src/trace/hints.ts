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

export const KEYWORDS = ["hide", "show", "pointers", "window", "tree", "list", "graph", "plain", "size"] as const;
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

    if (keyword === "window") {
      const window = parseWindow(rest, line);
      if (!window) {
        warn(
          line,
          `"window" looks like: viz: window nums: [left, right]  (both ends in), or [i, i + k)  (the end left out)`,
        );
        continue;
      }
      hints.windows = [...(hints.windows ?? []).filter((w) => w.container !== window.container), window];
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

/**
 * A string a window is over becomes a list of its characters on every
 * step, so it's drawn (and animated) like any list, with its window and
 * pointers. Its id is the frame and name, so it's the same object from step
 * to step.
 */
function stringsAsLists(steps: Step[], names: Set<string>): Step[] {
  if (!names.size) return steps;
  return steps.map((step) => {
    let heap: Record<string, HeapObject> | null = null;
    const convert = (frame: Step["stack"][number]) => {
      let changed = false;
      const locals = frame.locals.map(([name, value]): [string, Value] => {
        if (!names.has(name)) return [name, value];
        const chars = charsOf(value);
        if (!chars || chars.length > MAX_STRING_CELLS) return [name, value];
        const id = `str:${frame.id}:${name}`;
        heap ??= { ...step.heap };
        const type = value.kind === "prim" && value.type === "str" ? "str" : "string";
        heap[id] = {
          kind: "list",
          id,
          typeName: type,
          items: chars.map((c) => ({ kind: "prim", type, repr: type === "str" ? pyRepr(c) : JSON.stringify(c) })),
          length: chars.length,
          ...(value.kind === "prim" && value.size !== undefined ? { size: value.size } : {}),
        };
        changed = true;
        return [name, { kind: "ref", id }];
      });
      return changed ? { ...frame, locals } : frame;
    };
    const stack = step.stack.map(convert);
    const suspended = step.suspended?.map(convert);
    return heap ? { ...step, stack, ...(suspended ? { suspended } : {}), heap } : step;
  });
}

/** One character as Python writes it: 'a', '\'', '\n'. */
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
  const steps = stringsAsLists(filtered, new Set(windows.map((w) => w.container)));

  const indexNames = { ...trace.indexNames };
  const addIndexNames = (key: string, list: string[]) => {
    indexNames[key] = [...new Set([...(indexNames[key] ?? []), ...list])].sort();
  };
  for (const [key, list] of Object.entries(viz.pointers)) addIndexNames(key, list);
  // A window's ends, when each is just a name, are pointers too. A name
  // only ever added to an end (k in [i, i + k)) is a length, not a place:
  // it isn't drawn as a pointer, unless a pointers hint says so.
  for (const w of windows) {
    const lone = [loneName(w.start), loneName(w.end)].filter((n) => n !== null);
    addIndexNames(w.container, lone);
    const asked = new Set([...lone, ...(viz.pointers[w.container] ?? [])]);
    const lengths = [...w.start.terms, ...w.end.terms].flatMap((term) =>
      term.name && !asked.has(term.name) ? [term.name] : [],
    );
    indexNames[w.container] = indexNames[w.container].filter((n) => !lengths.includes(n));
  }
  return { ...trace, steps, indexNames, viz };
}
