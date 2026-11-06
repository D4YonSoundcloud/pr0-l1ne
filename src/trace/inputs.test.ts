/**
 * Inputs you can switch between (inputs.ts): `viz: input` above a value
 * written out, or naming variables; the values it reads (lists, tuples,
 * numbers, strings, true / false, over several lines); its variants; and
 * the code that's run, with the value swapped in on the same lines.
 */
import { describe, expect, it } from "vitest";
import { applyInputs, findInputs, type InputChoice, parseLiteral, seeded, variantsOf, WRITTEN } from "./inputs";

const choose = (entries: Record<string, string>, seed = 7): Map<string, InputChoice> =>
  new Map(Object.entries(entries).map(([name, variant]) => [name, { variant, seed }]));
const labels = (code: string, language: "python" | "javascript" = "python") => {
  const [input] = findInputs(code, language).inputs;
  return variantsOf(input, language).map((v) => `${v.label}: ${v.text}`);
};

describe("finding inputs", () => {
  it("takes the variable on the next line (past blank lines and other hints), or the ones it names", () => {
    const py = `# viz: input
nums = [5, 3, 8]  # to sort

# viz: input
# viz: heatmap grid
target = 11
k: int = 3
# viz: input k
`;
    const { inputs, problems } = findInputs(py, "python");
    expect(inputs.map((v) => [v.name, v.line, v.kind, v.written])).toEqual([
      ["nums", 2, "numbers", "[5, 3, 8]"],
      ["target", 6, "number", "11"],
      ["k", 7, "number", "3"],
    ]);
    expect(problems).toEqual([]);
    const js = `// viz: input words, flag
const words: string[] = ["b", 'a'];
let flag = true;
`;
    expect(findInputs(js, "javascript").inputs.map((v) => [v.name, v.kind])).toEqual([
      ["words", "strings"],
      ["flag", "bool"],
    ]);
  });

  it("says why when it can't: not above a top-level assignment, a value that's worked out, a name not set", () => {
    const { inputs, problems } = findInputs(
      `# viz: input
def f():
    pass
# viz: input
nums = list(range(10))
# viz: input
total = 1 + 2
# viz: input missing
`,
      "python",
    );
    expect(inputs).toEqual([]);
    expect(problems.map((p) => p.line)).toEqual([1, 4, 6, 8]);
    expect(problems[0].message).toMatch(/goes on the line above a variable/);
    expect(problems[1].message).toMatch(/^nums: "input" works on a value written out/);
    expect(problems[3].message).toMatch(/no "missing = …"/);
  });
});

describe("reading a value written out", () => {
  const read = (text: string, language: "python" | "javascript" = "python") => parseLiteral(text, 0, language)?.value;
  it("reads numbers, strings, true / false and lists of them, nested, over several lines with comments", () => {
    expect(read("-2.50")).toEqual({ kind: "num", value: -2.5, decimals: 2 });
    expect(read("40_000")).toEqual({ kind: "num", value: 40000, decimals: null });
    expect(read(`'it\\'s'`)).toEqual({ kind: "str", value: "it's", quote: "'" });
    expect(read("True")).toEqual({ kind: "bool", value: true });
    expect(read("true", "javascript")).toEqual({ kind: "bool", value: true });
    expect(read("(1,)")).toMatchObject({ kind: "list", open: "(", items: [{ value: 1 }] });
    expect(read("(4)")).toMatchObject({ kind: "num", value: 4 });
    const grid = parseLiteral("[\n  [1, 2],  # first\n  [3, 4],\n];\nx = 1", 0, "python");
    expect(grid?.value).toMatchObject({ kind: "list", items: [{ kind: "list" }, { kind: "list" }] });
    expect(grid?.end).toBe("[\n  [1, 2],  # first\n  [3, 4],\n]".length);
  });

  it("doesn't read what's worked out", () => {
    for (const text of ["[1, 2] + [3]", "len(x)", "[x, 1]", "`$" + "{a}`", "f'{x}'", "[1 2]", "{'a': 1}"])
      expect(read(text, text.startsWith("`") ? "javascript" : "python"), text).toBeUndefined();
  });
});

describe("the variants", () => {
  it("of a list of numbers: sorted, reversed, random within its range, empty, one item, all the same", () => {
    expect(labels("# viz: input\nnums = [5, 3, 8, 1]\n")).toEqual([
      "As written: [5, 3, 8, 1]",
      "Sorted: [1, 3, 5, 8]",
      "Reversed (largest first): [8, 5, 3, 1]",
      expect.stringMatching(/^Random: \[\d, \d, \d, \d\]$/),
      "Empty: []",
      "One item: [5]",
      "All the same: [5, 5, 5, 5]",
    ]);
    const [input] = findInputs("# viz: input\nnums = [5, 3, 8, 1]\n", "python").inputs;
    for (let seed = 1; seed < 50; seed++) {
      const random = variantsOf(input, "python", seed).find((v) => v.id === "random")!.text;
      for (const n of JSON.parse(random) as number[]) expect(n >= 1 && n <= 8 && Number.isInteger(n)).toBe(true);
    }
    // The same seed, the same values; another, others.
    const at = (seed: number) => variantsOf(input, "python", seed).find((v) => v.id === "random")!.text;
    expect(at(3)).toBe(at(3));
    expect(new Set([1, 2, 3, 4, 5].map(at)).size).toBeGreaterThan(1);
  });

  it("of strings, other lists, a number, a string and true / false", () => {
    expect(labels(`# viz: input\nnames = ["bo", "al", "cy"]\n`)).toEqual([
      'As written: ["bo", "al", "cy"]',
      'Sorted: ["al", "bo", "cy"]',
      'Reversed (Z to A): ["cy", "bo", "al"]',
      expect.stringMatching(/^Shuffled: \[/),
      "Empty: []",
      'One item: ["bo"]',
    ]);
    expect(labels("# viz: input\nedges = [(1, 2), (2, 3)]\n")).toEqual([
      "As written: [(1, 2), (2, 3)]",
      "Reversed: [(2, 3), (1, 2)]",
      "Shuffled: [(2, 3), (1, 2)]",
      "Empty: []",
      "One item: [(1, 2)]",
    ]);
    expect(labels("# viz: input\nn = 10\n").slice(0, 5)).toEqual([
      "As written: 10",
      "0: 0",
      "1: 1",
      "Half: 5",
      "Double: 20",
    ]);
    expect(labels("# viz: input\nrate = 0.5\n").slice(3, 5)).toEqual(["Half: 0.25", "Double: 1.0"]);
    expect(labels(`// viz: input\nconst s = "abc";\n`, "javascript")).toEqual([
      'As written: "abc"',
      'Reversed: "cba"',
      expect.stringMatching(/^Shuffled: "[abc]{3}"$/),
      'Empty: ""',
      'One character: "a"',
    ]);
    expect(labels("# viz: input\ndone = False\n")).toEqual(["As written: False", "True: True"]);
    // Already sorted: still there, marked.
    expect(labels("# viz: input\nnums = [1, 2]\n")[1]).toBe("Sorted (as written): [1, 2]");
  });

  it("random numbers come from the seed", () => {
    const a = seeded(42);
    const b = seeded(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("the code that's run", () => {
  it("has the chosen value swapped in, and the rest as it was", () => {
    const code = "# viz: input\nnums = [5, 3, 8]  # to sort\nprint(nums)\n";
    const { code: run, applied } = applyInputs(code, "python", choose({ nums: "sorted" }));
    expect(run).toBe("# viz: input\nnums = [3, 5, 8]  # to sort\nprint(nums)\n");
    expect(applied).toEqual([{ name: "nums", line: 2, label: "Sorted", text: "[3, 5, 8]" }]);
    expect(applyInputs(code, "python", choose({ nums: WRITTEN })).code).toBe(code);
    expect(applyInputs(code, "python", choose({ other: "sorted" })).code).toBe(code);
    expect(applyInputs(code, "python", choose({ nums: "no such" })).code).toBe(code);
  });

  it("keeps a value written over several lines on as many lines, so line numbers still match", () => {
    const code = "// viz: input\nconst grid = [\n  [1, 2],\n  [3, 4],\n];\nconsole.log(grid);\n";
    const { code: run } = applyInputs(code, "javascript", choose({ grid: "empty" }));
    expect(run).toBe("// viz: input\nconst grid = [\n\n\n];\nconsole.log(grid);\n");
    expect(run.split("\n")).toHaveLength(code.split("\n").length);
  });
});
