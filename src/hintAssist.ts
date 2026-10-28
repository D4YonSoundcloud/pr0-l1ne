/**
 * Help writing `viz:` hints in the editor: what can come next (completions),
 * what a hint means (hovers), names that aren't in the program (with the
 * likely one), and hints worth adding, offered on the line they're about
 * (code actions). The editor wires these into Monaco (hintEditor.ts).
 *
 * Everything here is plain text in, plain data out, so it's tested without
 * an editor. What the program has (its variables, which hold lists or whole
 * numbers, its classes and their links) comes from the last run's trace
 * (hintContext), so suggestions use the program's real names.
 */
import { KEYWORDS, parseBound } from "./trace/hints";
import { GRAPH_OPTIONS, type HeapObject, type Trace, type Value } from "./trace/types";

export type HintLanguage = "python" | "javascript" | "typescript";

/** What a variable held during the run. */
export type VarKind = "int" | "number" | "str" | "list" | "grid" | "dict" | "set" | "object" | "function" | "other";

export interface HintContext {
  variables: Map<string, Set<VarKind>>;
  /** Classes with objects in the run: their fields, and the fields that hold another of the same class. */
  classes: Map<string, { fields: string[]; links: string[] }>;
}

export const emptyContext = (): HintContext => ({ variables: new Map(), classes: new Map() });

/** At most this many steps are read for a context: plenty to see every variable. */
const MAX_STEPS = 400;

/** What a program has, from its trace (before hints are applied, so hidden variables count too). */
export function hintContext(trace: Trace): HintContext {
  const ctx = emptyContext();
  const steps = trace.steps;
  const every = Math.max(1, Math.ceil(steps.length / MAX_STEPS));
  const fieldsOf = new Map<string, Set<string>>();
  const linksOf = new Map<string, Set<string>>();
  for (let i = 0; i < steps.length; i += every) {
    const step = steps[i];
    for (const frame of [...step.stack, ...(step.suspended ?? [])]) {
      for (const [name, value] of frame.locals) {
        const kinds = ctx.variables.get(name) ?? new Set<VarKind>();
        kinds.add(kindOf(value, step.heap));
        ctx.variables.set(name, kinds);
      }
    }
    for (const obj of Object.values(step.heap)) {
      if (obj.kind !== "object") continue;
      const fields = fieldsOf.get(obj.typeName) ?? new Set<string>();
      const links = linksOf.get(obj.typeName) ?? new Set<string>();
      for (const [field, value] of obj.fields) {
        fields.add(field);
        const target = value.kind === "ref" ? step.heap[value.id] : undefined;
        if (target?.kind === "object" && target.typeName === obj.typeName) links.add(field);
      }
      fieldsOf.set(obj.typeName, fields);
      linksOf.set(obj.typeName, links);
    }
  }
  for (const [name, fields] of fieldsOf)
    ctx.classes.set(name, { fields: [...fields], links: [...(linksOf.get(name) ?? [])] });
  return ctx;
}

function kindOf(value: Value, heap: Record<string, HeapObject>): VarKind {
  if (value.kind === "prim") {
    if (value.type === "int") return "int";
    if (value.type === "number") return Number.isInteger(Number(value.repr)) ? "int" : "number";
    if (value.type === "str" || value.type === "string") return "str";
    return "other";
  }
  const obj = heap[value.id];
  if (!obj) return "other";
  if (obj.kind === "list" || obj.kind === "tuple") {
    const first = obj.items[0];
    const inner = first?.kind === "ref" ? heap[first.id] : undefined;
    return inner && (inner.kind === "list" || inner.kind === "tuple") ? "grid" : "list";
  }
  if (obj.kind === "set") return "set";
  if (obj.kind === "dict") return "dict";
  if (obj.kind === "object") return "object";
  if (obj.kind === "function" || obj.kind === "class") return "function";
  return "other";
}

const has = (ctx: HintContext, name: string, ...kinds: VarKind[]) =>
  [...(ctx.variables.get(name) ?? [])].some((k) => kinds.includes(k));
const variablesOf = (ctx: HintContext, ...kinds: VarKind[]) =>
  [...ctx.variables.keys()].filter((name) => has(ctx, name, ...kinds)).sort();

// ---------------------------------------------------------------- what each hint means

export interface HintDoc {
  syntax: string;
  summary: string;
  example: string;
}

export const HINT_DOCS: Record<(typeof KEYWORDS)[number], HintDoc> = {
  hide: {
    syntax: "viz: hide temp, scratch",
    summary:
      "Never draws these variables, in the memory view or the loop history. Objects only they point at disappear too.",
    example: "viz: hide i, tmp",
  },
  show: {
    syntax: "viz: show total, seen",
    summary: "Always includes these variables in the loop history, even when they don't change during the loop.",
    example: "viz: show target",
  },
  pointers: {
    syntax: "viz: pointers nums: lo, hi",
    summary:
      "Draws these whole-number variables as pointer markers under the list. Use `grid[]: col` for a grid's columns.",
    example: "viz: pointers nums: read, write",
  },
  window: {
    syntax: "viz: window nums: [left, right]",
    summary:
      "Draws the part of a list or string between two indexes as a band over its cells: a sliding window. Both ends are in the window; write `)` to leave the end out, as in `[i, i + k)`. Ends can add and take away names and numbers. A string is drawn as a row of its characters.",
    example: "viz: window s: [left, right]",
  },
  region: {
    syntax: 'viz: region nums: [0, i) "sorted"',
    summary:
      "Marks part of a list with a band in its own color and a label above it. Several regions can sit on one list, like the sorted and unsorted parts of insertion sort. Ends work as in `window`; the label is optional.",
    example: 'viz: region nums: [0, i) "sorted"',
  },
  compare: {
    syntax: "viz: compare nums: j, j + 1",
    summary:
      "Outlines the two cells of a list being compared, and flashes them when they change. Each index can add and take away names and whole numbers.",
    example: "viz: compare nums: j, j + 1",
  },
  heatmap: {
    syntax: "viz: heatmap dp",
    summary:
      "Colors each cell of a list or grid by its number, from the smallest it holds in the whole run to the largest, so the colors mean the same on every step. On a grid, the cell the line works on is outlined, and each cell it reads gets an arrow to it: `dp[i][j] = dp[i - 1][j] + dp[i][j - 1]` shows where dp[i][j] comes from.",
    example: "viz: heatmap dp",
  },
  table: {
    syntax: "viz: table people",
    summary:
      "Draws a list of dicts or objects (or a dict of them) as one table: a row for each item, a column for each key. Sorting the list slides its rows.",
    example: "viz: table rows",
  },
  intervals: {
    syntax: "viz: intervals meetings",
    summary:
      "Draws a list of pairs, like `[start, end]`, as bars along a number line, one row each, so overlaps and gaps show. Objects and dicts work too: their start and end (or lo and hi...), or the two fields you name after a colon.",
    example: "viz: intervals meetings: start, end",
  },
  chars: {
    syntax: "viz: chars s",
    summary: "Draws a string as a row of its characters, with index numbers and pointers, like a list.",
    example: "viz: chars s, word",
  },
  bits: {
    syntax: "viz: bits mask 8",
    summary:
      "Draws a whole number as its binary digits, bit 0 on the right. The number says how many digits; without it, as many as the number ever needs.",
    example: "viz: bits mask",
  },
  format: {
    syntax: "viz: format price .2f",
    summary:
      "Shows numbers in a format: `hex`, `bin`, `oct`, `,` (thousands), `.2f` (2 decimals), `.3e` (exponent), `.1%` (percent). It applies to the variable, and to the numbers in a list or dict it holds.",
    example: "viz: format total ,.2f",
  },
  hex: {
    syntax: "viz: hex flags",
    summary: "Shows these numbers in hexadecimal: the same as `viz: format flags hex`.",
    example: "viz: hex flags, mask",
  },
  label: {
    syntax: "viz: label Node by val",
    summary:
      "Names a class's boxes by one of its fields (Node 5), and shows that field in its nodes in the loop history.",
    example: "viz: label TreeNode by key",
  },
  rows: {
    syntax: "viz: rows by i",
    summary:
      "Labels the loop history's rows by a variable's value (i = 3) instead of #3. With several names, each loop uses the one in its own header.",
    example: "viz: rows by i, j",
  },
  focus: {
    syntax: "viz: focus",
    summary:
      "Opens the loop history on the loop just below the hint. Or: `focus line 12`, `focus while` (the first while loop), `focus all` (nested loops together).",
    example: "viz: focus",
  },
  watch: {
    syntax: "viz: watch right - left + 1",
    summary:
      "Shows an expression's value in every loop row, next to the variables. It can use arithmetic, comparisons, `len`, `sum`, `min`, `max`, `abs`, indexing and slices.",
    example: "viz: watch right - left + 1",
  },
  check: {
    syntax: "viz: check total == sum(nums[:i])",
    summary:
      "An invariant: a loop row where it's false turns red, with the expression beside it. Good for checking a loop does what you think.",
    example: "viz: check lo <= hi",
  },
  tree: {
    syntax: "viz: tree Node(left, right)",
    summary: "Draws objects of this class as a binary tree, with these two fields as the children.",
    example: "viz: tree TreeNode(left, right)",
  },
  list: {
    syntax: "viz: list Node(next)",
    summary: "Draws objects of this class as a linked list in the loop history, following this field.",
    example: "viz: list ListNode(next)",
  },
  graph: {
    syntax: "viz: graph adj [options]: names",
    summary:
      "Draws a variable (a dict, a list of neighbor lists, a matrix or an edge list) or a class (`Node(neighbors)`) as a graph, with options, and the variables after `:` drawn on it.",
    example: "viz: graph adj directed: seen, queue",
  },
  plain: {
    syntax: "viz: plain graph",
    summary: "Never draws this variable (or class) as a graph, though it looks like one.",
    example: "viz: plain lookup",
  },
  size: {
    syntax: "viz: size n = 40000",
    summary:
      "Marks a number set at the top of the program as the input size, so Measure can rerun it smaller to see how its cost grows.",
    example: "viz: size n = 40000",
  },
};

export const OPTION_DOCS: Record<string, string> = {
  directed: "Draw arrowheads: each edge goes one way.",
  undirected: "No arrowheads: every edge goes both ways.",
  matrix: "Read a list of lists as an adjacency matrix: m[i][j] is the edge from i to j.",
  edgelist: "Read a list of (a, b) or (a, b, weight) as edges.",
  layered: "Lay it out in layers from top to bottom; edges that close a cycle point up.",
  force: "Spread it out by distance: nodes a few edges apart sit about that far apart.",
  circle: "Lay the nodes out in a ring.",
  sideways: "Draw a layered graph left to right.",
  straight: "Draw edges as straight lines.",
  curved: "Draw edges as gentle curves.",
  angled: "Draw edges with right angles, nodes lined up in rows and columns.",
};

/** A hover's text (Markdown) for a keyword. */
export function keywordHover(keyword: (typeof KEYWORDS)[number]): string {
  const doc = HINT_DOCS[keyword];
  return [
    `**\`${doc.syntax}\`**`,
    doc.summary,
    `For example: \`${doc.example}\``,
    "[All hints](/docs/hints.html)",
  ].join("\n\n");
}

// ---------------------------------------------------------------- where a hint is on a line

export interface HintSpan {
  /** 0-based offset of the hint's text (after "viz:"). */
  start: number;
  text: string;
}

/** The `viz:` hint in a line, if there is one: `# viz: ...` (Python) or `// viz: ...`. */
export function hintOnLine(line: string, language: HintLanguage): HintSpan | null {
  const re = language === "python" ? /#\s*viz\s*:\s?/ : /\/\/\s*viz\s*:\s?|\/\*\s*viz\s*:\s?/;
  const m = re.exec(line);
  if (!m) return null;
  const start = m.index + m[0].length;
  return { start, text: line.slice(start).replace(/\*\/\s*$/, "") };
}

export const commentPrefix = (language: HintLanguage) => (language === "python" ? "#" : "//");

// ---------------------------------------------------------------- completions

export type CompletionKind = "keyword" | "variable" | "class" | "field" | "option" | "snippet";

export interface Completion {
  label: string;
  insert: string;
  kind: CompletionKind;
  detail?: string;
  /** Markdown. */
  docs?: string;
  /** Open the list again after inserting (the next part of the hint). */
  retrigger?: boolean;
  /** Sort before the others. */
  preferred?: boolean;
}

/**
 * What can come next in a hint, at a 0-based column of the line, and the
 * 0-based column the word being typed starts at (what a choice replaces).
 */
export function completionsAt(
  line: string,
  column: number,
  language: HintLanguage,
  ctx: HintContext,
): { from: number; items: Completion[] } | null {
  const hint = hintOnLine(line, language);
  if (!hint || column < hint.start) return null;
  const before = line.slice(hint.start, column);
  const word = /[\w$.]*$/.exec(before)![0];
  const from = column - word.length;
  const done = (items: Completion[]) => ({ from, items });

  const first = /^\s*([a-z]*)$/i.exec(before);
  if (first) {
    return done(
      KEYWORDS.map((k) => ({
        label: k,
        insert: `${k} `,
        kind: "keyword" as const,
        detail: HINT_DOCS[k].syntax,
        docs: keywordHover(k),
        retrigger: true,
      })),
    );
  }
  const m = /^\s*([a-z]+)\s+(.*)$/i.exec(before);
  if (!m) return done([]);
  const keyword = m[1].toLowerCase();
  const rest = m[2];
  const listed = new Set(rest.split(/[,:\s()[\]]+/).filter(Boolean));
  const vars = (kinds: VarKind[], detail: (name: string) => string) =>
    variablesOf(ctx, ...kinds)
      .filter((n) => !listed.has(n) || n === word)
      .map((name) => ({ label: name, insert: name, kind: "variable" as const, detail: detail(name) }));
  const whole = (name: string) => `${name}: a whole number`;
  const describe = (name: string) => describeVar(ctx, name);

  switch (keyword) {
    case "hide":
    case "show":
      return done(vars(["int", "number", "str", "list", "grid", "dict", "set", "object", "other"], describe));
    case "plain":
      return done([
        ...vars(["dict", "list", "grid"], describe),
        ...[...ctx.classes.keys()].map((c) => ({ label: c, insert: c, kind: "class" as const, detail: "a class" })),
      ]);
    case "size":
    case "hex":
      return done(vars(["int"], whole));
    case "bits":
      return done(vars(["int"], whole));
    case "chars":
      return done(vars(["str"], describe));
    case "heatmap":
      return done(vars(["grid", "list"], describe));
    case "table":
      return done(vars(["list", "dict"], describe));
    case "intervals": {
      const colon = rest.indexOf(":");
      if (colon < 0) return done(vars(["list", "grid"], describe));
      // After the colon: the fields of the program's classes.
      const fields = [...new Set([...ctx.classes.values()].flatMap((c) => c.fields))];
      return done(fields.map((f) => ({ label: f, insert: f, kind: "field" as const })));
    }
    case "watch":
    case "check":
      return done(vars(["int", "number", "str", "list", "grid", "dict", "set", "other"], describe));
    case "format": {
      // A name, then how to show it.
      if (!/^[\w$]+(\s*,\s*[\w$]+)*\s+/.test(rest))
        return done(
          vars(["int", "number", "list", "dict"], describe).map((c) => ({
            ...c,
            insert: `${c.label} `,
            retrigger: true,
          })),
        );
      return done(
        FORMAT_EXAMPLES.map(([spec, what]) => ({ label: spec, insert: spec, kind: "option" as const, detail: what })),
      );
    }
    case "rows":
      if (!/^by\s/.test(rest)) return done([{ label: "by", insert: "by ", kind: "keyword", retrigger: true }]);
      return done(vars(["int", "number", "str"], describe));
    case "focus":
      return done(
        [
          ["line ", "the loop on a line"],
          ["for", "the first for loop"],
          ["while", "the first while loop"],
          ["all", "nested loops together"],
        ].map(([label, detail]) => ({ label: label.trim(), insert: label, kind: "option" as const, detail })),
      );
    case "label": {
      const by = /^([\w$.]+)\s+by\s+/.exec(rest);
      if (by) {
        const info = ctx.classes.get(by[1]);
        return done(
          (info?.fields ?? [])
            .filter((f) => !info?.links.includes(f))
            .map((f) => ({ label: f, insert: f, kind: "field" as const })),
        );
      }
      return done(
        [...ctx.classes.keys()].map((c) => ({
          label: c,
          insert: `${c} by `,
          kind: "class" as const,
          detail: "a class",
          retrigger: true,
        })),
      );
    }
    case "pointers":
    case "region":
    case "compare":
    case "window": {
      const colon = rest.indexOf(":");
      if (colon < 0) {
        const kinds: VarKind[] = keyword === "pointers" ? ["list", "grid"] : ["list", "str"];
        const items: Completion[] = vars(kinds, describe).map((c) => ({
          ...c,
          insert: `${c.label}: `,
          retrigger: true,
        }));
        if (keyword === "pointers")
          for (const g of variablesOf(ctx, "grid"))
            items.push({
              label: `${g}[]`,
              insert: `${g}[]: `,
              kind: "variable",
              detail: `${g}'s columns`,
              retrigger: true,
            });
        return done(items);
      }
      const ints = vars(["int"], whole);
      if ((keyword === "window" || keyword === "region") && !/[[(]/.test(rest.slice(colon + 1))) {
        // Nothing after the colon yet: whole windows first, from the program's pairs of names.
        return done([...windowPairs(ctx), ...ints]);
      }
      return done(ints);
    }
    case "tree":
    case "list": {
      const paren = rest.indexOf("(");
      if (paren < 0) {
        return done(
          [...ctx.classes].map(([name, info]) => {
            const links = guessLinks(keyword, info);
            return {
              label: name,
              insert: links ? `${name}(${links.join(", ")})` : `${name}(`,
              kind: "class" as const,
              detail: links ? `${name}(${links.join(", ")})` : "a class",
              retrigger: !links,
              preferred: !!links,
            };
          }),
        );
      }
      const info = ctx.classes.get(rest.slice(0, paren).trim());
      if (!info) return done([]);
      return done(
        [...info.links, ...info.fields.filter((f) => !info.links.includes(f))]
          .filter((f) => !listed.has(f) || f === word)
          .map((f) => ({
            label: f,
            insert: f,
            kind: "field" as const,
            detail: info.links.includes(f) ? "links to another of the same class" : "a field",
            preferred: info.links.includes(f),
          })),
      );
    }
    case "graph": {
      const colon = rest.indexOf(":");
      if (colon >= 0) return done(vars(["int", "str", "list", "set", "dict", "other"], describe));
      const targetDone = /^[\w$.]+(\([^)]*\))?\s+/.exec(rest);
      if (!targetDone) {
        return done([
          ...vars(["dict", "list", "grid"], describe).map((c) => ({ ...c, insert: `${c.label} `, retrigger: true })),
          ...[...ctx.classes].map(([name, info]) => ({
            label: `${name}(…)`,
            insert: `${name}(${info.links.join(", ")}) `,
            kind: "class" as const,
            detail: `objects of ${name}, linked by ${info.links.join(", ") || "a field"}`,
            retrigger: true,
          })),
        ]);
      }
      const used = new Set(rest.toLowerCase().split(/\s+/));
      const options: Completion[] = GRAPH_OPTIONS.filter((o) => !used.has(o) || o === word).map((o) => ({
        label: o,
        insert: `${o} `,
        kind: "option",
        detail: OPTION_DOCS[o],
        retrigger: true,
      }));
      options.push({
        label: ":",
        insert: ": ",
        kind: "snippet",
        detail: "then variables to draw on the graph",
        retrigger: true,
      });
      return done(options);
    }
  }
  return done([]);
}

function describeVar(ctx: HintContext, name: string): string {
  const kinds = [...(ctx.variables.get(name) ?? [])];
  const words: Record<VarKind, string> = {
    int: "a whole number",
    number: "a number",
    str: "a string",
    list: "a list",
    grid: "a grid (list of lists)",
    dict: "a dict",
    set: "a set",
    object: "an object",
    function: "a function",
    other: "a value",
  };
  return `${name}: ${kinds.map((k) => words[k]).join(" or ") || "a variable"}`;
}

/** The fields to draw a class as a tree (two links) or list (one), when the run makes them clear. */
function guessLinks(shape: "tree" | "list", info: { fields: string[]; links: string[] }): string[] | null {
  if (shape === "tree") {
    if (info.links.includes("left") && info.links.includes("right")) return ["left", "right"];
    return info.links.length === 2 ? info.links : null;
  }
  if (info.links.includes("next")) return ["next"];
  return info.links.length === 1 ? info.links : null;
}

/** Names that come in pairs, start first. */
const PAIRS: [string, string][] = [
  ["left", "right"],
  ["l", "r"],
  ["lo", "hi"],
  ["low", "high"],
  ["start", "end"],
  ["i", "j"],
  ["slow", "fast"],
];

/** Whole windows from pairs of whole-number variables the program has. */
function windowPairs(ctx: HintContext): Completion[] {
  return PAIRS.filter(([a, b]) => has(ctx, a, "int") && has(ctx, b, "int")).map(([a, b]) => ({
    label: `[${a}, ${b}]`,
    insert: `[${a}, ${b}]`,
    kind: "snippet" as const,
    detail: `from ${a} to ${b}, both in`,
    preferred: true,
  }));
}

/** Number formats for `viz: format`, with what each does. */
const FORMAT_EXAMPLES: [string, string][] = [
  ["hex", "hexadecimal: 0xff"],
  ["bin", "binary: 0b1011"],
  ["oct", "octal: 0o17"],
  [",", "thousands: 1,234,567"],
  [".2f", "2 decimals: 3.14"],
  [",.2f", "thousands and 2 decimals"],
  [".3e", "exponent: 1.234e+5"],
  [".1%", "percent: 42.5%"],
];

// ---------------------------------------------------------------- names that aren't in the program

export interface NameProblem {
  /** 0-based columns of the name in the line. */
  from: number;
  to: number;
  name: string;
  message: string;
  /** The closest name the program has, if one is close. */
  suggestion: string | null;
}

/** Edit distance, for "did you mean": a swap of two neighbors counts as one edit (bets, best). */
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** The closest of `options` to `word`, if it's close enough to be a typo. */
export function closest(word: string, options: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const d = distance(word.toLowerCase(), option.toLowerCase());
    if (d < bestD) [best, bestD] = [option, d];
  }
  const limit = word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
  return best !== null && bestD > 0 && bestD <= limit ? best : null;
}

/** The hint's keyword, if it's misspelled: its place and the likely one. */
export function keywordProblem(line: string, language: HintLanguage): NameProblem | null {
  const hint = hintOnLine(line, language);
  if (!hint) return null;
  const m = /^(\s*)([a-z]+)/i.exec(hint.text);
  if (!m || (KEYWORDS as readonly string[]).includes(m[2].toLowerCase())) return null;
  const suggestion = closest(m[2], KEYWORDS);
  const from = hint.start + m[1].length;
  return {
    from,
    to: from + m[2].length,
    name: m[2],
    message: suggestion ? `Did you mean "${suggestion}"?` : `Hints are: ${KEYWORDS.join(", ")}.`,
    suggestion,
  };
}

/**
 * Names in a hint that never appeared in this run. A name may only exist in
 * some runs, so these are notes, not errors.
 */
export function nameProblems(line: string, language: HintLanguage, ctx: HintContext): NameProblem[] {
  const hint = hintOnLine(line, language);
  if (!hint || !ctx.variables.size) return [];
  const m = /^(\s*)([a-z]+)\s*(.*)$/i.exec(hint.text);
  if (!m) return [];
  const keyword = m[2].toLowerCase();
  if (!(KEYWORDS as readonly string[]).includes(keyword)) return [];
  const restStart = hint.start + hint.text.length - m[3].length;
  const rest = m[3];
  const out: NameProblem[] = [];
  const check = (name: string, at: number, known: Iterable<string>, what: string) => {
    const list = [...known];
    if (list.includes(name)) return;
    const suggestion = closest(name, list);
    out.push({
      from: restStart + at,
      to: restStart + at + name.length,
      name,
      message: `"${name}" isn't ${what} in this run.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
      suggestion,
    });
  };
  const variables = [...ctx.variables.keys()];
  const classes = [...ctx.classes.keys()];
  const identifiers = (text: string, offset: number) =>
    [...text.matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => ({ name: x[0], at: offset + x.index! }));

  if (keyword === "tree" || keyword === "list") {
    const shape = /^([\w$.]+)\s*\(([^)]*)\)?/.exec(rest);
    if (!shape) return out;
    check(shape[1], 0, classes, "a class with objects");
    const info = ctx.classes.get(shape[1]);
    if (info)
      for (const f of identifiers(shape[2], rest.indexOf("(") + 1))
        check(f.name, f.at, info.fields, `a field of ${shape[1]}`);
    return out;
  }
  if (keyword === "graph") {
    const target = /^[\w$]+/.exec(rest);
    if (target && !rest.slice(target[0].length).trimStart().startsWith("(") && !target[0].includes("."))
      check(target[0], 0, [...variables, ...classes], "a variable");
    const colon = rest.indexOf(":");
    if (colon >= 0)
      for (const n of identifiers(rest.slice(colon + 1), colon + 1)) check(n.name, n.at, variables, "a variable");
    return out;
  }
  if (keyword === "size") {
    for (const n of identifiers(
      rest.replace(/=\s*[\d_]+/g, (s) => " ".repeat(s.length)),
      0,
    ))
      check(n.name, n.at, variables, "a variable");
    return out;
  }
  if (keyword === "plain") {
    for (const n of identifiers(rest, 0)) check(n.name, n.at, [...variables, ...classes], "a variable or class");
    return out;
  }
  if (keyword === "focus") return out; // line numbers and loop kinds, not names
  if (keyword === "label") {
    const m = /^([\w$.]+)(\s+by\s+)([\w$]+)/.exec(rest);
    if (!m) return out;
    check(m[1], 0, classes, "a class with objects");
    const info = ctx.classes.get(m[1]);
    if (info) check(m[3], m[1].length + m[2].length, info.fields, `a field of ${m[1]}`);
    return out;
  }
  // The rest name variables, among other words: leave out quoted labels,
  // "by", number formats and widths, functions and words in expressions.
  const blank = (text: string) => " ".repeat(text.length);
  let names = rest.replace(/(["'])[^"']*\1/g, blank);
  if (keyword === "rows") names = names.replace(/^by\b/, blank);
  if (keyword === "format") names = names.replace(/\s+\S+$/, blank);
  if (keyword === "bits") names = names.replace(/\b\d+\s*$/, blank);
  if (keyword === "intervals") names = names.replace(/:.*$/, blank); // after the colon: fields
  const notNames = new Set([
    "len",
    "sum",
    "min",
    "max",
    "abs",
    "round",
    "int",
    "and",
    "or",
    "not",
    "in",
    "True",
    "False",
    "None",
    "true",
    "false",
    "null",
    "undefined",
    "length",
    "size",
  ]);
  // hide, show, pointers, window, region, compare, chars, bits, hex, rows, watch, check:
  // every name is a variable (dotted names are fields: left alone).
  for (const n of identifiers(names, 0)) {
    if ((keyword === "watch" || keyword === "check") && notNames.has(n.name)) continue;
    const prevChar = rest[n.at - 1];
    if (prevChar === ".") continue;
    if (rest[n.at + n.name.length] === ".") continue;
    check(n.name, n.at, variables, "a variable");
  }
  return out;
}

// ---------------------------------------------------------------- hints worth adding

export interface Suggestion {
  /** The hint, without "viz:". */
  hint: string;
  /** Why: shown as the action's title. */
  title: string;
  /** 1-based line the hint goes above. */
  line: number;
}

const ID = String.raw`[A-Za-z_$][\w$]*`;

/** A loop's header and the lines in it (by indentation for Python, by braces otherwise). */
function loopAt(lines: string[], index: number, language: HintLanguage): { body: string } | null {
  const header = lines[index];
  const isLoop = language === "python" ? /^\s*(for|while)\b/.test(header) : /^\s*(for|while)\s*\(/.test(header);
  if (!isLoop) return null;
  const indent = /^\s*/.exec(header)![0].length;
  const body: string[] = [header];
  if (language === "python") {
    for (let i = index + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() && /^\s*/.exec(l)![0].length <= indent) break;
      body.push(l);
    }
  } else {
    let depth = 0;
    let opened = false;
    for (let i = index; i < lines.length && i < index + 200; i++) {
      const l = lines[i];
      if (i > index) body.push(l);
      for (const c of l) {
        if (c === "{") {
          depth++;
          opened = true;
        } else if (c === "}") depth--;
      }
      if (opened && depth <= 0) break;
      if (!opened && i > index) break; // a loop without braces: just its next line
    }
  }
  return { body: body.join("\n") };
}

/** `right + 1` as an inclusive end: `right`. */
function inclusiveEnd(end: string): { end: string; inclusive: boolean } {
  const m = /^(.*?)\s*\+\s*1$/.exec(end.trim());
  return m ? { end: m[1], inclusive: true } : { end: end.trim(), inclusive: false };
}

/**
 * Hints worth adding for a line: a sliding window over a list or string
 * the loop starting there reads from two ends of, or slices.
 */
export function suggestionsFor(
  code: string,
  lineNumber: number,
  language: HintLanguage,
  ctx: HintContext,
): Suggestion[] {
  const lines = code.split("\n");
  const index = lineNumber - 1;
  if (index < 0 || index >= lines.length) return [];
  const loop = loopAt(lines, index, language);
  if (!loop) return [];
  const existing = new Set(
    lines.flatMap((l) => {
      const h = hintOnLine(l, language);
      const m = h && /^\s*window\s+([\w$.]+)/.exec(h.text);
      return m ? [m[1]] : [];
    }),
  );
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (container: string, window: string, why: string) => {
    if (existing.has(container) || seen.has(container)) return;
    seen.add(container);
    out.push({
      hint: `window ${container}: ${window}`,
      title: `Show ${why} as a sliding window over ${container}`,
      line: lineNumber,
    });
  };
  const sequences = variablesOf(ctx, "list", "str");
  const body = loop.body;

  // Slices: s[left:right + 1], nums[i:i + k], s.slice(a, b), s.substring(a, b).
  const sliceRe =
    language === "python"
      ? new RegExp(String.raw`(${ID})\[([^\[\]:]+):([^\[\]:]+)\]`, "g")
      : new RegExp(String.raw`(${ID})\.(?:slice|substring)\(([^(),]+),([^(),]+)\)`, "g");
  for (const m of body.matchAll(sliceRe)) {
    const [, container, a, b] = m;
    if (!sequences.includes(container) || !parseBound(a) || !parseBound(b)) continue;
    const { end, inclusive } = inclusiveEnd(b);
    if (!parseBound(end)) continue;
    add(
      container,
      inclusive ? `[${a.trim()}, ${end}]` : `[${a.trim()}, ${end})`,
      `the slice ${container}[${a.trim()}…${b.trim()}]`,
    );
  }

  // Two ends: nums[left] and nums[right], for a pair of names that go together.
  for (const container of sequences) {
    const subscripts = new Set(
      [...body.matchAll(new RegExp(String.raw`\b${container.replace(/\$/g, "\\$")}\[\s*(${ID})\s*\]`, "g"))].map(
        (x) => x[1],
      ),
    );
    for (const [a, b] of PAIRS) {
      if (subscripts.has(a) && subscripts.has(b) && has(ctx, a, "int") && has(ctx, b, "int")) {
        add(container, `[${a}, ${b}]`, `${a} to ${b}`);
        break;
      }
    }
  }
  return out;
}

/** The comment line for a hint, indented like the line it goes above. */
export function hintLine(hint: string, aboveLine: string, language: HintLanguage): string {
  const indent = /^\s*/.exec(aboveLine)![0];
  return `${indent}${commentPrefix(language)} viz: ${hint}`;
}
