import { describe, expect, it } from "vitest";
import { parseProgram } from "./instrument";
import { measureProgram } from "./measure";
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
});
