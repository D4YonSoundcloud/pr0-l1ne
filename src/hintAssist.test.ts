import { describe, expect, it } from "vitest";
import {
  closest,
  completionsAt,
  emptyContext,
  type HintContext,
  hintContext,
  hintLine,
  hintOnLine,
  keywordHover,
  keywordProblem,
  nameProblems,
  suggestionsFor,
  type VarKind,
} from "./hintAssist";
import { traceJavaScript } from "./js/trace";
import { KEYWORDS } from "./trace/hints";

function ctxWith(vars: Record<string, VarKind[]>, classes: Record<string, { fields: string[]; links: string[] }> = {}) {
  const ctx: HintContext = emptyContext();
  for (const [name, kinds] of Object.entries(vars)) ctx.variables.set(name, new Set(kinds));
  for (const [name, info] of Object.entries(classes)) ctx.classes.set(name, info);
  return ctx;
}

const ctx = ctxWith(
  {
    s: ["str"],
    nums: ["list"],
    grid: ["grid"],
    left: ["int"],
    right: ["int"],
    best: ["int"],
    seen: ["set"],
    adj: ["dict"],
  },
  { Node: { fields: ["val", "left", "right", "parent"], links: ["left", "right", "parent"] } },
);

/** Completions with the cursor at the end of a line ("|" marks it otherwise). */
function complete(line: string, language: "python" | "javascript" = "javascript") {
  const column = line.includes("|") ? line.indexOf("|") : line.length;
  const result = completionsAt(line.replace("|", ""), column, language, ctx);
  return result && { from: result.from, labels: result.items.map((i) => i.label), items: result.items };
}

describe("where a hint is", () => {
  it("finds hints in Python and JavaScript comments, own line or trailing", () => {
    expect(hintOnLine("# viz: hide i", "python")).toEqual({ start: 7, text: "hide i" });
    expect(hintOnLine("    x = 1  # viz: hide x", "python")?.text).toBe("hide x");
    expect(hintOnLine("// viz:window s", "javascript")?.text).toBe("window s");
    expect(hintOnLine("/* viz: hide i */", "typescript")?.text).toBe("hide i ");
    expect(hintOnLine("// just a comment", "javascript")).toBeNull();
    expect(hintOnLine("// viz: hide i", "python")).toBeNull();
  });
});

describe("completions", () => {
  it("offers every hint right after viz:", () => {
    const c = complete("// viz: ");
    expect(c?.labels).toEqual([...KEYWORDS]);
    expect(c?.items.every((i) => i.retrigger)).toBe(true);
    // A partly typed one replaces the word.
    expect(complete("  // viz: win")?.from).toBe(10);
  });

  it("offers nothing outside a hint, or before viz:", () => {
    expect(complete("const x = 1")).toBeNull();
    expect(complete("// v|iz: hide")).toBeNull();
  });

  it("offers the program's variables to hide or show, leaving out the ones listed", () => {
    const c = complete("# viz: hide left, ", "python");
    expect(c?.labels).toContain("right");
    expect(c?.labels).not.toContain("left");
  });

  it("offers lists and strings for a window, then whole windows from pairs of names, then whole numbers", () => {
    expect(complete("// viz: window ")?.labels).toEqual(["nums", "s"]);
    expect(complete("// viz: window ")?.items[0].insert).toBe("nums: ");
    const ends = complete("// viz: window s: ");
    expect(ends?.labels.slice(0, 1)).toEqual(["[left, right]"]);
    expect(ends?.labels).toContain("best");
    expect(complete("// viz: window s: [left, ")?.labels).toEqual(["best", "right"]);
  });

  it("offers lists, and a grid's columns, for pointers", () => {
    expect(complete("// viz: pointers ")?.labels).toEqual(["grid", "nums", "grid[]"]);
  });

  it("fills in a class's links for tree and list, then offers its fields", () => {
    const tree = complete("# viz: tree ", "python")!;
    expect(tree.items[0]).toMatchObject({ label: "Node", insert: "Node(left, right)" });
    expect(complete("# viz: tree Node(", "python")?.labels).toEqual(["left", "right", "parent", "val"]);
  });

  it("offers graph targets, then options not used yet, then names after the colon", () => {
    expect(complete("// viz: graph ")?.labels).toContain("adj");
    const options = complete("// viz: graph adj directed ")?.labels;
    expect(options).toContain("circle");
    expect(options).not.toContain("directed");
    expect(options).toContain(":");
    expect(complete("// viz: graph adj: ")?.labels).toContain("seen");
  });

  it("explains each hint", () => {
    expect(keywordHover("window")).toMatch(/viz: window nums: \[left, right\]/);
    expect(keywordHover("window")).toMatch(/\/docs\/hints\.html/);
  });
});

describe("names that aren't in the program", () => {
  it("suggests the likely name, a swap of letters counting as one slip", () => {
    expect(closest("bets", ["best", "left"])).toBe("best");
    expect(closest("nmus", ["nums", "s"])).toBe("nums");
    expect(closest("xyz", ["nums"])).toBeNull();
    expect(closest("best", ["best"])).toBeNull(); // not a typo
  });

  it("marks names a hint uses that weren't in this run, where they are", () => {
    const line = "// viz: window nmus: [left, rigth]";
    const problems = nameProblems(line, "javascript", ctx);
    expect(problems.map((p) => [line.slice(p.from, p.to), p.suggestion])).toEqual([
      ["nmus", "nums"],
      ["rigth", "right"],
    ]);
    expect(problems[0].message).toBe(`"nmus" isn't a variable in this run. Did you mean "nums"?`);
  });

  it("checks classes and their fields for tree and list", () => {
    const problems = nameProblems("# viz: tree Node(left, rigt)", "python", ctx);
    expect(problems.map((p) => p.suggestion)).toEqual(["right"]);
    expect(nameProblems("# viz: tree Nod(left, right)", "python", ctx)[0].suggestion).toBe("Node");
  });

  it("leaves numbers, dotted names and finished hints alone, and says nothing before a run", () => {
    expect(nameProblems("// viz: window s: [left, right + 1)", "javascript", ctx)).toEqual([]);
    expect(nameProblems("// viz: hide self.cache", "javascript", ctx)).toEqual([]);
    expect(nameProblems("// viz: size n = 40000", "javascript", ctxWith({ n: ["int"] }))).toEqual([]);
    expect(nameProblems("// viz: hide anything", "javascript", emptyContext())).toEqual([]);
  });

  it("suggests the hint meant by a misspelled one", () => {
    const line = "# viz: windw s: [left, right]";
    const p = keywordProblem(line, "python")!;
    expect([line.slice(p.from, p.to), p.suggestion]).toEqual(["windw", "window"]);
    expect(keywordProblem("# viz: window s: [a, b]", "python")).toBeNull();
  });
});

describe("hints worth adding", () => {
  const python = `s = "abcabcbb"
seen = set()
left = 0
for right in range(len(s)):
    while s[right] in seen:
        seen.remove(s[left])
        left += 1
    seen.add(s[right])
`;

  it("offers a window on a loop that reads a list from two ends, to go above it", () => {
    expect(suggestionsFor(python, 4, "python", ctx)).toEqual([
      { hint: "window s: [left, right]", title: "Show left to right as a sliding window over s", line: 4 },
    ]);
    // Not on other lines, and not once there's a window hint for that list.
    expect(suggestionsFor(python, 2, "python", ctx)).toEqual([]);
    const hinted = python.replace("for right", "# viz: window s: [left, right]\nfor right");
    expect(suggestionsFor(hinted, 5, "python", ctx)).toEqual([]);
  });

  it("reads slices as windows, an end of x + 1 as including x", () => {
    const code = `best = 0
for i in range(len(nums) - 2):
    total = sum(nums[i:i + 3])
for left in range(len(s)):
    print(s[left:right + 1])
`;
    expect(suggestionsFor(code, 2, "python", ctx)[0].hint).toBe("window nums: [i, i + 3)");
    expect(suggestionsFor(code, 4, "python", ctx)[0].hint).toBe("window s: [left, right]");
  });

  it("reads JavaScript loops by their braces, and slice() as a window", () => {
    const code = `for (let right = 0; right < s.length; right++) {
  const part = s.slice(left, right + 1);
}
const after = nums[left] + nums[right];
`;
    expect(suggestionsFor(code, 1, "javascript", ctx).map((s) => s.hint)).toEqual(["window s: [left, right]"]);
  });

  it("writes the hint indented like the line it goes above", () => {
    expect(hintLine("window s: [left, right]", "    for right in range(9):", "python")).toBe(
      "    # viz: window s: [left, right]",
    );
    expect(hintLine("hide i", "  for (;;) {", "typescript")).toBe("  // viz: hide i");
  });
});

describe("hintContext", () => {
  it("reads the program's variables, what they held, and its classes' links", async () => {
    const trace = await traceJavaScript(`class Node { constructor(v) { this.v = v; this.next = null; } }
const a = new Node(1);
a.next = new Node(2);
const s = "ab";
const nums = [1, 2];
const grid = [[1], [2]];
let i = 0;
let x = 1.5;`);
    const c = hintContext(trace);
    expect([...c.variables.get("s")!]).toEqual(["str"]);
    expect(c.variables.get("nums")?.has("list")).toBe(true);
    expect(c.variables.get("grid")?.has("grid")).toBe(true);
    expect(c.variables.get("i")?.has("int")).toBe(true);
    expect(c.variables.get("x")?.has("number")).toBe(true);
    expect(c.classes.get("Node")).toEqual({ fields: ["v", "next"], links: ["next"] });
  });
});

describe("the newer hints in the editor", () => {
  it("completes each with the right kinds of name", () => {
    expect(complete("// viz: bits ")?.labels).toEqual(["best", "left", "right"]);
    expect(complete("// viz: chars ")?.labels).toEqual(["s"]);
    expect(complete("// viz: region ")?.labels).toEqual(["nums", "s"]);
    expect(complete("// viz: region nums: ")?.labels[0]).toBe("[left, right]");
    expect(complete("// viz: compare ")?.labels).toEqual(["nums", "s"]);
    expect(complete("// viz: format best ")?.labels).toEqual(expect.arrayContaining(["hex", ".2f", ".1%"]));
    expect(complete("// viz: rows ")?.labels).toEqual(["by"]);
    expect(complete("// viz: rows by ")?.labels).toContain("left");
    expect(complete("// viz: focus ")?.labels).toEqual(["line", "for", "while", "all"]);
    expect(complete("// viz: label ")?.items[0]).toMatchObject({ label: "Node", insert: "Node by " });
    expect(complete("// viz: label Node by ")?.labels).toEqual(["val"]);
    expect(complete("// viz: watch ")?.labels).toContain("nums");
  });

  it("checks their names, leaving out labels, formats, widths and functions", () => {
    const quiet = [
      '// viz: region nums: [0, left) "sorted"',
      "// viz: format best .2f",
      "// viz: bits best 8",
      "// viz: rows by left",
      "// viz: focus line 3",
      "// viz: watch sum(nums[0:left]) + len(s)",
      "// viz: check left <= right and not seen",
      "// viz: label Node by val",
    ];
    for (const line of quiet) expect(nameProblems(line, "javascript", ctx), line).toEqual([]);
    expect(nameProblems("// viz: watch rigth - left", "javascript", ctx)[0].suggestion).toBe("right");
    expect(nameProblems("// viz: label Node by vall", "javascript", ctx)[0].suggestion).toBe("val");
  });
});
