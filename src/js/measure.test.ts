import { generate } from "@babel/generator";
import { describe, expect, it } from "vitest";
import { parseProgram } from "./instrument";
import { applyOverrides, measureProgram } from "./measure";
import { stripTypes } from "./typescript";

const js = (source: string, limitMs = 10_000) => measureProgram(source, limitMs, (s) => parseProgram(s));
const ts = (source: string) => measureProgram(source, 10_000, (s) => stripTypes(parseProgram(s, ["typescript"]), s));

describe("measure", () => {
  it("counts lines, loop passes and loop lengths", async () => {
    const r = await js(`let total = 0;
for (let i = 0; i < 50; i++) {
  for (let j = 0; j < i; j++) {
    total++;
  }
}
console.log(total);
`);
    expect(r.status).toBe("done");
    expect(r.lines["4"]).toBe(1225);
    expect(r.passes["2"]).toBe(50);
    expect(r.passes["3"]).toBe(1225);
    expect(r.totals["2"]).toBe(50);
    expect(r.stdout).toBe("1225\n");
    expect(r.plainMs).not.toBeNull();
  });

  it("counts work hidden inside array methods, and puts them back afterwards", async () => {
    const original = Array.prototype.shift;
    const r = await js(`const nums = Array.from({ length: 1000 }, (_, i) => i);
for (let r = 0; r < 10; r++) nums.unshift(nums.pop());
const found = nums.includes(999);
const part = nums.slice(0, 100);
const seen = new Set(nums);
const hit = seen.has(5);
nums.sort((a, b) => a - b);
`);
    expect(r.work["2"]).toBe(10 * 999); // unshift moves what's left after the pop
    expect(r.workKind["2"]).toBe("m");
    expect(r.work["3"]).toBe(1000);
    expect(r.work["4"]).toBe(100);
    expect(r.work["6"]).toBeUndefined(); // Set lookups are O(1)
    expect(r.workKind["7"]).toBe("o");
    expect(Array.prototype.shift).toBe(original);
  });

  it("stops at the time limit and says how far the outer loop got", async () => {
    const r = await js(
      `function spin(k) {
  for (let r = 0; r < k; r++) {
    let x = 0;
    for (let j = 0; j < 100000; j++) x += j;
  }
}
spin(1e9);
`,
      400,
    );
    expect(r.status).toBe("limit");
    expect(r.stoppedAt?.loop).toMatchObject({ line: 2, total: 1e9 });
    expect(r.stoppedAt!.loop!.done).toBeGreaterThan(0);
  });

  it("can't be kept going by a catch", async () => {
    const r = await js(`while (true) { try { let a = 1; } catch (e) {} }`, 300);
    expect(r.status).toBe("limit");
  });

  it("stops recursion without loops", async () => {
    const r = await js(`const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2)); fib(60);`, 300);
    expect(r.status).toBe("limit");
  });

  it("reports errors on their line, and syntax errors", async () => {
    const r = await js(`const a = [1];
a.missing();
`);
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ type: "TypeError", line: 2 });
    const bad = await js("for (let i = 0; i < 3 {}");
    expect(bad.error?.type).toBe("SyntaxError");
  });

  it("runs timers and async code, in order", async () => {
    const r = await js(`setTimeout(() => console.log("late"), 500);
setTimeout(() => console.log("soon"), 5);
(async () => { await null; console.log("first"); })();
`);
    expect(r.stdout).toBe("first\nsoon\nlate\n");
    expect(r.lines["1"]).toBe(2); // scheduling the timer, then its callback, written on the same line
  });

  it("measures TypeScript after removing its types", async () => {
    const r = await ts(`function rotate(nums: number[], k: number): void {
  for (let r = 0; r < k; r++) nums.unshift(nums.pop()!);
}
const nums: number[] = Array.from({ length: 2000 }, (_, i) => i);
rotate(nums, 100);
`);
    expect(r.status).toBe("done");
    expect(r.passes["2"]).toBe(100);
    expect(r.work["2"]).toBe(100 * 1999);
  });

  it("counts calls by the line each function starts on", async () => {
    const r = await measureProgram(
      `function fib(n) {\n  return n < 2 ? n : fib(n - 1) + fib(n - 2);\n}\nconst sq = (x) => x * x;\nfib(15);\n[1, 2, 3].map(sq);`,
      10000,
      (s) => parseProgram(s),
    );
    expect(r.calls["1"]).toBe(1973);
    expect(r.calls["4"]).toBe(3);
  });

  it("learns how many passes a for...of loop will make, from what it walks", async () => {
    const r = await js(`for (const x of [1, 2, 3]) {}
for (const ch of "hello") {}
for (const [k, v] of new Map([[1, 2]])) {}
for (const x of new Set([1, 2, 3, 4])) {}
function* gen() { yield 1; }
for (const x of gen()) {}
`);
    expect(r.totals).toEqual({ "1": 3, "2": 5, "3": 1, "4": 4 }); // a generator's length isn't known
    expect(r.passes["6"]).toBe(1);
  });

  it("learns a counted loop's passes when its bounds are simple", async () => {
    const r = await js(`const arr = [1, 2, 3, 4, 5, 6];
const half = { n: 2 };
for (let i = 0; i <= arr.length - 1; i += 1) {}
for (let i = -2; i < half.n * 2 + 1; i++) {}
for (let i = 0; i < arr.length; i += 2) {}
for (let i = 0; i < Math.min(3, 4); i++) {}
for (let [i] = [0]; i < 3; i++) {}
for (let i = 0, j = 0; i < 3; i++) {}
`);
    expect(r.totals).toEqual({ "3": 6, "4": 7 }); // steps of 2, calls and patterns aren't counted ahead
    expect(r.passes["5"]).toBe(3);
  });

  it("counts statements in switch cases, if/else chains and one-line arrows", async () => {
    const r = await js(`const pick = (x) =>
  x * 2;
for (let i = 0; i < 4; i++) {
  switch (i % 2) {
    case 0:
      pick(i);
      break;
    default:
      if (i === 1) pick(1);
      else if (i === 3) pick(3);
      else pick(0);
  }
}
`);
    expect(r.lines["6"]).toBe(2);
    expect(r.lines["9"]).toBe(3); // the if, twice, and pick(1) once: a body on the same line counts too
    expect(r.lines["10"]).toBe(1); // else if: only its body (the if is part of the one above)
    expect(r.calls["1"]).toBe(4);
    expect(r.lines["2"]).toBe(4); // the arrow's body, on its own line
  });

  it("counts copies by the size of what they make", async () => {
    const r = await js(`const a = Array.from({ length: 50 }, (_, i) => i);
const b = a.slice(10);
const c = a.concat(a);
const d = [[1, 2], [3]].flat();
const e = a.toReversed();
a.copyWithin(0, 1);
`);
    expect(r.work).toMatchObject({ "2": 40, "3": 100, "4": 3, "5": 50, "6": 50 });
    expect(r.workKind).toMatchObject({ "2": "c", "5": "c", "6": "m" });
  });

  it("runs intervals until they're cleared, and ignores timers that aren't functions", async () => {
    const r = await js(`let n = 0;
const id = setInterval(() => {
  n++;
  if (n === 3) clearInterval(id);
}, "soon");
const gone = setTimeout(() => console.log("never"), 1);
clearTimeout(gone);
console.log(setTimeout("not a function"));
setTimeout(() => console.log("a"));
setTimeout(() => console.log("b"));
setTimeout(() => console.log("n", n), 10);
`);
    expect(r.stdout).toBe("0\na\nb\nn 3\n");
  });

  it("prints values the way a console does, and stops keeping output past its limit", async () => {
    const r = await js(`console.log([1, "a", [2]], { k: 1 }, null, undefined);
console.log(Array.from({ length: 102 }, () => 0));
const loop = {}; loop.self = loop;
console.log(loop, { toJSON() { return undefined; } });
`);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe(`[ 1, 'a', [ 2 ] ] {"k":1} null undefined`);
    expect(lines[1]).toMatch(/^\[ 0, .*, 0, \.\.\. 2 more items \]$/);
    expect(lines[2]).toBe("[object Object] [object Object]");
    const big = await js(`for (let i = 0; i < 2000; i++) console.log("x".repeat(99));`);
    expect(big.stdout.length).toBe(100_000);
    expect(big.droppedOutput).toBe(200_000 - 100_000);
  });

  it("reports what was thrown when it isn't an Error, and keeps the first of several failures", async () => {
    const r = await js(`throw "boom";`);
    expect(r.error).toEqual({ type: "Uncaught", message: "boom", line: 1 });
    const two = await js(`Promise.reject(new RangeError("first"));
Promise.reject(new Error("second"));
`);
    expect(two.error).toMatchObject({ type: "RangeError", message: "first", line: null }); // after the script ran
  });

  it("says why it couldn't prepare a program, whatever was thrown", async () => {
    const r = await measureProgram("x", 1000, () => {
      throw "no parser";
    });
    expect(r.error).toEqual({ type: "SyntaxError", message: "no parser", line: null });
  });

  it("can't be kept going by a catch around a loop that never ends", async () => {
    const r = await js(
      `try {
  while (true) {}
} catch (e) {
  console.log("caught");
}
`,
      300,
    );
    expect(r.status).toBe("limit");
    expect(r.plainMs).toBeNull(); // the untouched program would never stop: it isn't run
  });

  it("reports progress on the outermost unfinished loop", async () => {
    const seen: { loop?: { line: number; total: number } }[] = [];
    await measureProgram(
      `for (let r = 0; r < 1e9; r++) {
  for (let j = 0; j < 1000; j++) {}
}
`,
      700,
      (s) => parseProgram(s),
      (p) => seen.push(p),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.loop).toMatchObject({ line: 1, total: 1e9 });
  });

  it("only gives an honest time when the untouched run finishes too", async () => {
    const r = await js(`globalThis.__measureRuns = (globalThis.__measureRuns ?? 0) + 1;
if (globalThis.__measureRuns > 1) throw new Error("ran twice");
`);
    delete (globalThis as { __measureRuns?: number }).__measureRuns;
    expect(r.status).toBe("done");
    expect(r.plainMs).toBeNull();
  });
});

describe("applyOverrides", () => {
  const code = (source: string, overrides?: Record<string, number>) =>
    generate(applyOverrides(parseProgram(source), overrides)).code;

  it("sets top-level whole numbers to the sizes given", () => {
    expect(code("const n = 10, m = 2;\nlet k;\nk = 5;\nn2 = 1.5;\nk += 1;", { n: 99, k: 7, n2: 3 })).toBe(
      "const n = 99,\n  m = 2;\nlet k;\nk = 7;\nn2 = 1.5;\nk += 1;",
    );
  });

  it("leaves everything else alone", () => {
    const source = "function f() {\n  const n = 10;\n}\nconst [n] = [1];\nconst s = 'n';";
    expect(code(source, { n: 99 })).toBe(code(source));
    expect(code("const n = 10;", {})).toBe("const n = 10;");
    expect(code("const n = 10;")).toBe("const n = 10;");
  });
});
