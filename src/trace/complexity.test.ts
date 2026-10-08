import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES } from "../examples/javascript";
import { PYTHON_EXAMPLES } from "../examples/python";
import { TYPESCRIPT_EXAMPLES } from "../examples/typescript";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { estimateComplexity } from "./complexity";
import { applyHints } from "./hints";
import type { Trace } from "./types";

function tracePython(source: string): Trace | null {
  try {
    const json = execFileSync("python3", ["-c",
      "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read(), 3000))"],
    { input: source, encoding: "utf8" });
    return JSON.parse(json) as Trace;
  } catch {
    return null; // Python not installed: those cases are skipped
  }
}

/**
 * What a textbook says, per example: [time, space]. Where a language's
 * version is written differently, it has its own answer: JavaScript's BFS
 * and topological sort dequeue with array.shift(), which moves every item,
 * and its Dijkstra sorts the whole array on every pass.
 */
const EXPECTED: Record<string, [string, string] | Record<string, [string, string]>> = {
  "Bubble sort": ["O(n²)", "O(1)"],
  "Insertion sort": ["O(n²)", "O(1)"],
  "Merge sort": ["O(n log n)", "O(n)"],
  "Binary search": ["O(log n)", "O(1)"],
  "Reverse a string": ["O(n)", "O(1)"],
  "Two sum": ["O(n)", "O(n)"],
  "Sliding window": { python: ["O(k + n)", "O(k)"], javascript: ["O(k + n)", "O(1)"], typescript: ["O(k + n)", "O(1)"] },
  "Word frequency": ["O(n)", "O(n)"],
  "Reverse a linked list": ["O(n)", "O(1)"],
  "Find a cycle": ["O(n)", "O(1)"],
  "Binary search tree insert": ["O(n)", "O(1)"],
  "Tree traversal": ["O(n)", "O(n)"],
  "Trie": ["O(n)", "O(n)"],
  "Breadth-first search": { python: ["O(V + E)", "O(V)"], javascript: ["O(V² + E)", "O(V)"], typescript: ["O(V² + E)", "O(V)"] },
  "Depth-first search": ["O(V + E)", "O(V)"],
  "Dijkstra": { python: ["O(E log V + V)", "O(V)"], javascript: ["O(V·E log V)", "O(V)"], typescript: ["O(V·E log V)", "O(V)"] },
  "Topological sort": { python: ["O(V + E)", "O(V)"], javascript: ["O(V² + E)", "O(V)"], typescript: ["O(V² + E)", "O(V)"] },
  "Graph of objects": ["O(V + E)", "O(V)"],
  "Grid paths": ["O(n·m)", "O(n·m)"],
  "Longest common subsequence": ["O(n·m)", "O(n·m)"],
  "Coin change": ["O(n·m)", "O(n)"],
  "Number of islands": ["O(n·m)", "O(n·m)"],
  "Fibonacci with a memo": ["O(n)", "O(n)"],
  "Recursion (factorial)": ["O(n)", "O(n)"],
  "9 · graph edgelist": ["O(E log E)", "O(E + n)"],
};

type Tracer = (code: string) => Trace | null | Promise<Trace | null>;
const LANGUAGES: [string, { name: string; code: string }[], Tracer][] = [
  ["python", PYTHON_EXAMPLES, tracePython],
  ["javascript", JAVASCRIPT_EXAMPLES, (c) => traceJavaScript(c, 3000)],
  ["typescript", TYPESCRIPT_EXAMPLES, (c) => traceTypeScript(c, 3000)],
];

const cases: [string, string, string, [string, string], Tracer][] = [];
for (const [language, examples, tracer] of LANGUAGES) {
  for (const [prefix, expected] of Object.entries(EXPECTED)) {
    const example = examples.find((e) => e.name.startsWith(prefix));
    if (!example) continue;
    const answer = Array.isArray(expected) ? expected : expected[language];
    cases.push([language, example.name, example.code, answer, tracer]);
  }
}

describe("complexity of the examples", () => {
  it.each(cases)("%s: %s", async (_language, _name, code, [time, space], tracer) => {
    const raw = await tracer(code);
    if (!raw) return;
    const estimate = estimateComplexity(applyHints(raw));
    expect(estimate).not.toBeNull();
    expect([estimate!.time, estimate!.space]).toEqual([time, space]);
  });

  it("every example gets an estimate without errors", async () => {
    for (const [, examples, tracer] of LANGUAGES) {
      for (const example of examples) {
        const raw = await tracer(example.code);
        if (!raw) continue;
        const estimate = estimateComplexity(applyHints(raw));
        expect(estimate, example.name).not.toBeNull();
        expect(estimate!.time, example.name).toMatch(/^O\(.+\)$/);
      }
    }
  });
});

describe("explanations", () => {
  const estimate = async (code: string, js = false) => {
    const raw = js ? await traceJavaScript(code, 3000) : tracePython(code);
    return raw ? estimateComplexity(applyHints(raw)) : null;
  };

  it("labels each loop and says where the run was used", async () => {
    const e = await estimate(`
nums = [4, 1, 3, 2, 5, 6]
pairs = 0
for i in range(len(nums)):
    for j in range(i + 1, len(nums)):
        pairs += 1
queue = [1, 2, 3]
while queue:
    queue.pop()
`);
    if (!e) return;
    // queue is its own input: draining it is O(m)
    expect(e.time).toBe("O(n² + m)");
    const [outer, inner, drain] = e.loops;
    expect(outer.label).toBe("× n");
    expect(inner.label).toBe("× n");
    expect(drain.fromRun).toBe(true);
    expect(e.legend.find((l) => l.name === "n")).toMatchObject({ meaning: "len(nums)", value: 6 });
  });

  it("amortizes an inner loop that never resets (a sliding window)", async () => {
    const e = await estimate(`
nums = [1, 2, 1, 4, 1, 1, 2, 3, 1, 1]
left = 0
total = 0
best = 0
for right in range(len(nums)):
    total += nums[right]
    while total > 5:
        total -= nums[left]
        left += 1
    best = max(best, right - left + 1)
`);
    if (!e) return;
    expect(e.time).toBe("O(n)");
    expect(e.loops[1].label).toBe("n in total");
    expect(e.loops[1].checked).toMatch(/adds to that loop/);
  });

  it("solves recursion patterns and checks them against the call count", async () => {
    const fib = await estimate(`
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
fib(7)
`);
    if (!fib) return;
    expect(fib.time).toBe("O(2ⁿ)");
    expect(fib.space).toBe("O(n)");
    const search = await estimate(`
def search(items, lo, hi, target):
    if lo > hi:
        return -1
    mid = (lo + hi) // 2
    if items[mid] == target:
        return mid
    if items[mid] < target:
        return search(items, mid + 1, hi, target)
    return search(items, lo, mid - 1, target)
data = list(range(40))
search(data, 0, len(data) - 1, 31)
`);
    // in the function's own terms: the length of its items
    expect(search!.functions.find((f) => f.name === "search")!.time).toMatch(/^O\(log [a-z]\)$/);
  });

  it("flags costly built-ins inside loops", async () => {
    const e = await estimate(`
const items = [5, 3, 8, 1, 9, 2];
const queue = [...items];
while (queue.length > 0) {
  const x = queue.shift();
  if (items.includes(x)) {}
}
`, true);
    if (!e) return;
    expect(e.time).toBe("O(n²)");
    expect(e.notes.some((n) => /queue\.shift\(\) costs n/.test(n))).toBe(true);
  });
});
