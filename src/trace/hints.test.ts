import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { applyHints, charsOf, parseHints } from "./hints";
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
