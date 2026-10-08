import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { applyHints, parseHints } from "./hints";
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
    expect(js.hints).toEqual([{ line: 1, text: "hide a" }, { line: 2, text: "show b" }]);
    const ts = await traceTypeScript(`interface P { x: number }\n// viz: hide p\nconst p: P = { x: 1 };`);
    expect(ts.hints).toEqual([{ line: 2, text: "hide p" }]);
  });

  it("collects # viz: comments in Python", () => {
    let json: string;
    try {
      json = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read()))"],
        { input: `x = 1  # viz: hide x\ns = "# viz: nope"\n# viz: pointers a: i\n`, encoding: "utf8" });
    } catch {
      return; // no Python
    }
    expect((JSON.parse(json) as Trace).hints).toEqual([{ line: 1, text: "hide x" }, { line: 3, text: "pointers a: i" }]);
  });
});

describe("applying hints", () => {
  it("hides variables in every frame of every step", async () => {
    const t = applyHints(await traceJavaScript(`// viz: hide scratch\nfunction f() {\n  const scratch = 2;\n  return scratch;\n}\nconst scratch = f();\nconst kept = 1;`));
    const seen = new Set(t.steps.flatMap((s) => s.stack.flatMap((f) => f.locals.map(([n]) => n))));
    expect(seen.has("scratch")).toBe(false);
    expect(seen.has("kept")).toBe(true);
  });

  it("adds pointer names to the index analysis", async () => {
    const t = applyHints(await traceJavaScript(`// viz: pointers nums: first, last\nconst nums = [1, 2, 3];\nconst first = 0;\nconst last = 2;`));
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
    const rowsOf = (t: Trace) => buildLoopHistory(t, t.steps.length - 2, null)!.rows.map((r) => ({ locals: r.frame.locals, heap: r.heap }));
    const plain = applyHints(await traceJavaScript(code(false)));
    expect(findLinkedTrack(rowsOf(plain), plain.viz?.linked)?.shape).toBe("list"); // three links: not a tree
    const hinted = applyHints(await traceJavaScript(code(true)));
    const track = findLinkedTrack(rowsOf(hinted), hinted.viz?.linked)!;
    expect(track).toMatchObject({ shape: "tree", links: ["left", "right"], valueField: "key" });
    const keys = track.order.map((id) => (linkedRow(track, rowsOf(hinted)[0]).nodes.get(id)?.value as { repr: string }).repr);
    expect(keys).toEqual(["2", "5", "8"]); // in order
  });

  it("leaves a trace without hints alone", async () => {
    const t = await traceJavaScript(`const a = 1;`);
    const applied = applyHints(t);
    expect(applied.steps).toBe(t.steps);
    expect(applied.viz?.warnings).toEqual([]);
  });
});
