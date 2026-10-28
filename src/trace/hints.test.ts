import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { applyHints, charsOf, focusedLoop, formatNumber, intervalOf, numberOf, parseHints } from "./hints";
import { findLinkedTrack, linkedRow } from "./linked";
import { buildLoopHistory } from "./loopHistory";
import type { Trace } from "./types";

const hint = (text: string, line = 1) => ({ line, text });

describe("parseHints", () => {
  it("reads every kind of hint", () => {
    const h = parseHints([
      hint("hide temp, scratch"),
      hint("show total"),
      hint("pointers nums: lo, hi"),
      hint("pointers grid[]: col"),
      hint("tree Node(left, right)"),
      hint("list Item(next)"),
    ]);
    expect(h).toMatchObject({
      hide: ["temp", "scratch"],
      show: ["total"],
      pointers: { nums: ["lo", "hi"], "grid[]": ["col"] },
      linked: [
        { shape: "tree", typeName: "Node", links: ["left", "right"] },
        { shape: "list", typeName: "Item", links: ["next"] },
      ],
      warnings: [],
    });
  });

  it("is forgiving about case and spacing", () => {
    expect(parseHints([hint("HIDE   a ,b")]).hide).toEqual(["a", "b"]);
    expect(parseHints([hint("pointers  nums :lo")]).pointers).toEqual({ nums: ["lo"] });
  });

  it("explains hints it can't understand, with their line", () => {
    const h = parseHints([
      hint("colour red", 3),
      hint("tree Node(left)", 4),
      hint("pointers nums", 5),
      hint("hide", 6),
    ]);
    expect(h.warnings.map((w) => w.line)).toEqual([3, 4, 5, 6]);
    expect(h.warnings[0].message).toContain("Unknown hint");
    expect(h.warnings[1].message).toContain("viz: tree Node(left, right)");
    expect(h.warnings[2].message).toContain("viz: pointers nums: lo, hi");
  });

  it("lets a later tree/list hint for the same class win", () => {
    const h = parseHints([hint("list Node(next)"), hint("tree Node(left, right)")]);
    expect(h.linked).toHaveLength(1);
    expect(h.linked[0].shape).toBe("tree");
  });
});

describe("collecting hints", () => {
  it("collects // viz: comments in JavaScript and TypeScript", async () => {
    const js = await traceJavaScript(`let a = 1; // viz: hide a\n/* viz: show b */\nlet b = "// viz: not a comment";`);
    expect(js.hints).toEqual([
      { line: 1, text: "hide a" },
      { line: 2, text: "show b" },
    ]);
    const ts = await traceTypeScript(`interface P { x: number }\n// viz: hide p\nconst p: P = { x: 1 };`);
    expect(ts.hints).toEqual([{ line: 2, text: "hide p" }]);
  });

  it("collects # viz: comments in Python", () => {
    let json: string;
    try {
      json = execFileSync(
        "python3",
        [
          "-c",
          "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read()))",
        ],
        { input: `x = 1  # viz: hide x\ns = "# viz: nope"\n# viz: pointers a: i\n`, encoding: "utf8" },
      );
    } catch {
      return; // no Python
    }
    expect((JSON.parse(json) as Trace).hints).toEqual([
      { line: 1, text: "hide x" },
      { line: 3, text: "pointers a: i" },
    ]);
  });
});

describe("applying hints", () => {
  it("hides variables in every frame of every step", async () => {
    const t = applyHints(
      await traceJavaScript(
        `// viz: hide scratch\nfunction f() {\n  const scratch = 2;\n  return scratch;\n}\nconst scratch = f();\nconst kept = 1;`,
      ),
    );
    const seen = new Set(t.steps.flatMap((s) => s.stack.flatMap((f) => f.locals.map(([n]) => n))));
    expect(seen.has("scratch")).toBe(false);
    expect(seen.has("kept")).toBe(true);
  });

  it("adds pointer names to the index analysis", async () => {
    const t = applyHints(
      await traceJavaScript(
        `// viz: pointers nums: first, last\nconst nums = [1, 2, 3];\nconst first = 0;\nconst last = 2;`,
      ),
    );
    expect(t.indexNames.nums).toEqual(["first", "last"]);
  });

  it("draws a tree with parent pointers as a tree when told to", async () => {
    const code = (withHint: boolean) => `${withHint ? "// viz: tree T(left, right)\n" : ""}
class T { constructor(k, parent) { this.key = k; this.parent = parent; this.left = null; this.right = null; } }
const root = new T(5, null);
root.left = new T(2, root);
root.right = new T(8, root);
let node = root.left;
while (node) {
  node = node.parent;
}`;
    const rowsOf = (t: Trace) =>
      buildLoopHistory(t, t.steps.length - 2, null)!.rows.map((r) => ({ locals: r.frame.locals, heap: r.heap }));
    const plain = applyHints(await traceJavaScript(code(false)));
    expect(findLinkedTrack(rowsOf(plain), plain.viz?.linked)?.shape).toBe("list"); // three links: not a tree
    const hinted = applyHints(await traceJavaScript(code(true)));
    const track = findLinkedTrack(rowsOf(hinted), hinted.viz?.linked)!;
    expect(track).toMatchObject({ shape: "tree", links: ["left", "right"], valueField: "key" });
    const keys = track.order.map(
      (id) => (linkedRow(track, rowsOf(hinted)[0]).nodes.get(id)!.value as { repr: string }).repr,
    );
    expect(keys).toEqual(["2", "5", "8"]); // in order
  });

  it("leaves a trace without hints alone", async () => {
    const t = await traceJavaScript(`const a = 1;`);
    const applied = applyHints(t);
    expect(applied.steps).toBe(t.steps);
    expect(applied.viz?.warnings).toEqual([]);
  });
});

describe("window hints", () => {
  it("reads both ends, inclusive unless written with ( or )", () => {
    const h = parseHints([hint("window s: [left, right]"), hint("window nums: [i, i + k)", 2)]);
    expect(h.warnings).toEqual([]);
    expect(h.windows).toEqual([
      {
        container: "s",
        start: { terms: [{ sign: 1, name: "left" }] },
        end: { terms: [{ sign: 1, name: "right" }] },
        startOpen: false,
        endOpen: false,
        text: "[left, right]",
        line: 1,
      },
      {
        container: "nums",
        start: { terms: [{ sign: 1, name: "i" }] },
        end: {
          terms: [
            { sign: 1, name: "i" },
            { sign: 1, name: "k" },
          ],
        },
        startOpen: false,
        endOpen: true,
        text: "[i, i + k)",
        line: 2,
      },
    ]);
    // Without brackets, both ends are in; ( leaves the start out.
    expect(parseHints([hint("window nums: lo, hi")]).windows?.[0]).toMatchObject({ startOpen: false, endOpen: false });
    expect(parseHints([hint("window nums: (lo, hi]")]).windows?.[0]).toMatchObject({ startOpen: true, endOpen: false });
    expect(parseHints([hint("window nums: [r - k + 1, r]")]).windows?.[0].start.terms).toEqual([
      { sign: 1, name: "r" },
      { sign: -1, name: "k" },
      { sign: 1, value: 1 },
    ]);
  });

  it("explains a window it can't read", () => {
    for (const text of [
      "window nums",
      "window nums: [lo]",
      "window nums: [lo, hi",
      "window nums: [lo * 2, hi]",
      "window: [a, b]",
    ]) {
      const h = parseHints([hint(text, 7)]);
      expect(h.windows, text).toEqual([]);
      expect(h.warnings[0].message, text).toMatch(/"window" looks like/);
    }
  });

  it("ignores a hint that's still being typed", () => {
    expect(parseHints([hint("")]).warnings).toEqual([]);
  });

  it("reads a string's characters back from its repr", () => {
    expect(charsOf({ kind: "prim", type: "str", repr: "'abc'" })).toEqual(["a", "b", "c"]);
    expect(charsOf({ kind: "prim", type: "str", repr: `"it's"` })).toEqual(["i", "t", "'", "s"]);
    expect(charsOf({ kind: "prim", type: "str", repr: String.raw`'a\nb\\'` })).toEqual(["a", "\n", "b", "\\"]);
    expect(charsOf({ kind: "prim", type: "string", repr: '"\\u00e9\\ud83d\\ude00x"' })).toEqual([
      "é",
      "\u{1F600}",
      "x",
    ]);
    // Shortened, or not a string: can't.
    expect(charsOf({ kind: "prim", type: "string", repr: '"abc…"', length: 500 })).toBeNull();
    expect(charsOf({ kind: "prim", type: "int", repr: "3" })).toBeNull();
  });

  it("draws a string with a window over it as a list of its characters, the same object on every step", async () => {
    const code = `// viz: window s: [left, right]
const s = "abca";
let left = 0;
for (let right = 0; right < s.length; right++) { if (right === 3) left = 1; }`;
    const t = applyHints(await traceJavaScript(code));
    const ids = new Set<string>();
    for (const step of t.steps) {
      const value = step.stack[0].locals.find(([n]) => n === "s")?.[1];
      if (!value) continue;
      expect(value.kind).toBe("ref");
      if (value.kind !== "ref") continue;
      ids.add(value.id);
      const obj = step.heap[value.id];
      expect(obj).toMatchObject({ kind: "list", typeName: "string", length: 4 });
      expect(obj.kind === "list" && obj.items.map((v) => (v.kind === "prim" ? v.repr : ""))).toEqual([
        '"a"',
        '"b"',
        '"c"',
        '"a"',
      ]);
    }
    expect(ids.size).toBe(1);
    // Its ends are pointers too, when each is a name.
    expect(t.indexNames.s).toEqual(["left", "right"]);
  });

  it("doesn't draw a name only added to an end as a pointer: it's a length", async () => {
    const code = `// viz: window nums: [i, i + k)
const nums = [1, 2, 3, 4], k = 2;
let total = 0;
for (let i = 0; i + k <= nums.length; i++) total = nums[i] + nums[i + k - 1];`;
    const raw = await traceJavaScript(code);
    expect(raw.indexNames.nums).toContain("k"); // nums[i + k - 1]
    expect(applyHints(raw).indexNames.nums).toEqual(["i"]);
    // ...unless a pointers hint asks for it.
    expect(applyHints(await traceJavaScript(`// viz: pointers nums: k\n${code}`)).indexNames.nums).toEqual(["i", "k"]);
  });
});

describe("more hints", () => {
  it("reads each of them", () => {
    const h = parseHints([
      hint("chars s, word"),
      hint("bits mask 8"),
      hint("bits flags"),
      hint("format price .2f"),
      hint("hex a, b"),
      hint("label Node by val"),
      hint("rows by i, j"),
      hint("focus while"),
      hint("watch right - left + 1"),
      hint("check total == sum(nums[0:i])"),
      hint('region nums: [0, i) "sorted"'),
      hint("region nums: [i, n)"),
      hint("compare nums: j - 1, j"),
    ]);
    expect(h.warnings).toEqual([]);
    expect(h.chars).toEqual(["s", "word"]);
    expect(h.bits).toEqual([
      { names: ["mask"], width: 8, line: 1 },
      { names: ["flags"], line: 1 },
    ]);
    expect(h.formats).toEqual([
      { names: ["price"], spec: ".2f", line: 1 },
      { names: ["a", "b"], spec: "hex", line: 1 },
    ]);
    expect(h.labels).toEqual([{ typeName: "Node", field: "val", line: 1 }]);
    expect(h.rowsBy).toEqual(["i", "j"]);
    expect(h.focus).toEqual({ target: { kind: "while" }, line: 1 });
    expect(h.watches).toEqual([{ text: "right - left + 1", line: 1 }]);
    expect(h.checks).toEqual([{ text: "total == sum(nums[0:i])", line: 1 }]);
    // Regions: several on one list, each with its place for its color; a window is separate.
    expect(h.windows?.map((w) => [w.text, w.region])).toEqual([
      ["[0, i)", { label: "sorted", index: 0 }],
      ["[i, n)", { label: null, index: 1 }],
    ]);
    expect(h.compares?.[0]).toMatchObject({ container: "nums", text: "j - 1, j" });
    expect(parseHints([hint("focus")]).focus?.target).toEqual({ next: true });
    expect(parseHints([hint("focus line 12")]).focus?.target).toEqual({ line: 12 });
  });

  it("says what each should look like when it can't read one", () => {
    const cases: [string, RegExp][] = [
      ["chars 1x", /"chars" needs string variables/],
      ["bits mask 99", /"bits" looks like/],
      ["format price fancy", /"format" looks like/],
      ["hex", /"hex" needs variable names/],
      ["label Node", /"label" looks like/],
      ["rows i", /"rows" looks like/],
      ["focus sideways", /"focus" looks like/],
      ["watch a +", /"watch" needs an expression/],
      ["check open(x)", /"check" needs an expression/],
      ['region nums "x"', /"region" looks like/],
      ["compare nums: j", /"compare" looks like/],
    ];
    for (const [text, message] of cases) expect(parseHints([hint(text)]).warnings[0]?.message, text).toMatch(message);
  });

  it("formats numbers", () => {
    expect(formatNumber("255", "hex")).toBe("0xff");
    expect(formatNumber("-5", "bin")).toBe("-0b101");
    expect(formatNumber("8", "oct")).toBe("0o10");
    expect(formatNumber("3", ".2f")).toBe("3.00");
    expect(formatNumber("1234567.891", ",.1f")).toBe("1,234,567.9");
    expect(formatNumber("1234567", ",")).toBe("1,234,567");
    expect(formatNumber("0.4251", ".1%")).toBe("42.5%");
    expect(formatNumber("12345", ".2e")).toBe("1.23e+4");
    expect(formatNumber("12345678901234567890", "hex")).toBe("0xab54a98ceb1f0ad2");
    expect(formatNumber("'a'", "hex")).toBeNull();
  });

  it("draws numbers as their bits, as wide as the widest, and formats numbers in lists", async () => {
    const code = `// viz: bits mask
// viz: format prices .2f
const prices = [1, 2.5];
let mask = 1;
mask = 5;
mask = 2;`;
    const t = applyHints(await traceJavaScript(code));
    const last = t.steps.at(-1)!;
    const value = last.stack[0].locals.find(([n]) => n === "mask")![1];
    expect(value.kind).toBe("ref");
    const bits = value.kind === "ref" ? last.heap[value.id] : null;
    expect(bits).toMatchObject({ kind: "list", typeName: "bits", length: 3 });
    expect(bits?.kind === "list" && bits.items.map((v) => (v.kind === "prim" ? v.repr : ""))).toEqual(["0", "1", "0"]);
    const prices = last.stack[0].locals.find(([n]) => n === "prices")![1];
    const list = prices.kind === "ref" ? last.heap[prices.id] : null;
    expect(list?.kind === "list" && list.items.map((v) => (v.kind === "prim" ? v.repr : ""))).toEqual(["1.00", "2.50"]);
  });

  it("finds the loop a focus hint means", () => {
    const loops = [
      { id: "L1", kind: "for" as const, line: 2, bodyStart: 3, bodyEnd: 3, header: "" },
      { id: "L2", kind: "while" as const, line: 6, bodyStart: 7, bodyEnd: 7, header: "" },
    ];
    const at = (text: string, line = 1) => focusedLoop({ loops, viz: parseHints([hint(text, line)]) });
    expect(at("focus", 5)).toBe("L2"); // the loop below it
    expect(at("focus", 1)).toBe("L1");
    expect(at("focus line 6")).toBe("L2");
    expect(at("focus for")).toBe("L1");
    expect(at("focus all")).toBe("all");
    expect(at("focus line 9")).toBeNull();
    expect(focusedLoop({ loops, viz: parseHints([]) })).toBeNull();
  });
});

describe("heatmap, table and intervals hints", () => {
  it("reads them, and explains ones it can't", () => {
    const h = parseHints([
      hint("heatmap dp, cost", 1),
      hint("table people", 2),
      hint("intervals meetings", 3),
      hint("intervals slots: begin, finish", 4),
      hint("heatmap", 5),
      hint("intervals a: b", 6),
    ]);
    expect(h.heatmaps).toEqual([
      { name: "dp", line: 1 },
      { name: "cost", line: 1 },
    ]);
    expect(h.tables).toEqual(["people"]);
    expect(h.intervals).toEqual([
      { name: "meetings", line: 3 },
      { name: "slots", line: 4, fields: ["begin", "finish"] },
    ]);
    expect(h.warnings.map((w) => w.line)).toEqual([5, 6]);
  });

  it("works out the numbers a heatmap or intervals holds over the whole run, and never draws them as graphs", async () => {
    const code = `// viz: heatmap dp
// viz: intervals spans
const dp = [[0, 0], [0, 0]];
dp[1][1] = 7;
dp[0][0] = -2;
const spans = [[3, 5], { start: 1, end: 9 }];`;
    const t = applyHints(await traceJavaScript(code));
    expect(t.viz?.heatmaps).toEqual([{ name: "dp", line: 1, min: -2, max: 7 }]);
    expect(t.viz?.intervals).toEqual([{ name: "spans", line: 2, min: 1, max: 9 }]);
    expect(t.viz?.plain).toEqual(expect.arrayContaining(["dp", "spans"]));
  });

  it("reads an interval from a pair, an object's start and end, or the fields named", () => {
    const heap = {
      a: { kind: "list", id: "a", typeName: "list", items: [num("2"), num("4")], length: 2 },
      b: {
        kind: "object",
        id: "b",
        typeName: "Meeting",
        fields: [
          ["room", num("7")],
          ["lo", num("1")],
          ["hi", num("3")],
        ],
      },
      c: {
        kind: "dict",
        id: "c",
        typeName: "dict",
        entries: [
          [{ kind: "prim", type: "str", repr: "'from'" }, num("5")],
          [{ kind: "prim", type: "str", repr: "'to'" }, num("6")],
        ],
      },
      d: { kind: "list", id: "d", typeName: "list", items: [num("1")], length: 1 },
    } as unknown as Record<string, import("./types").HeapObject>;
    const ref = (id: string) => ({ kind: "ref" as const, id });
    expect(intervalOf(ref("a"), heap)).toEqual([2, 4]);
    expect(intervalOf(ref("b"), heap)).toEqual([1, 3]);
    expect(intervalOf(ref("b"), heap, ["room", "hi"])).toEqual([7, 3]);
    expect(intervalOf(ref("c"), heap)).toEqual([5, 6]);
    expect(intervalOf(ref("d"), heap)).toBeNull();
    expect(numberOf(num("inf"))).toBe(Infinity);
    expect(numberOf({ kind: "prim", type: "bool", repr: "True" })).toBe(1);
  });
});

function num(repr: string) {
  return { kind: "prim" as const, type: "int", repr };
}
