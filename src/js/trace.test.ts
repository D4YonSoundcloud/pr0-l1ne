import { describe, expect, it } from "vitest";
import type { HeapObject, SequenceObject, Step, Trace, Value } from "../trace/types";
import { inspect, parseParams } from "./runtime";
import { traceJavaScript } from "./trace";

const last = (trace: Trace) => trace.steps[trace.steps.length - 1];
const localsOf = (step: Step) => new Map(step.stack[step.stack.length - 1].locals);
const heapOf = (step: Step, value: Value | undefined): HeapObject => {
  if (value?.kind !== "ref") throw new Error("expected a reference");
  return step.heap[value.id];
};
const reprs = (obj: HeapObject) => ("items" in obj ? obj.items.map((v) => (v.kind === "prim" ? v.repr : "ref")) : []);

describe("values and the heap", () => {
  it("draws arrays as lists in the heap", async () => {
    const t = await traceJavaScript(`const arr = [3, "a", null, undefined];`);
    const arr = heapOf(last(t), localsOf(last(t)).get("arr"));
    expect(arr.kind).toBe("list");
    expect(reprs(arr)).toEqual(["3", '"a"', "null", "undefined"]);
  });

  it("keeps object ids stable across steps", async () => {
    const t = await traceJavaScript(`const arr = [1];\narr.push(2);\narr.push(3);`);
    const ids = new Set(
      t.steps
        .map((s) => localsOf(s).get("arr"))
        .filter((v) => v?.kind === "ref")
        .map((v) => (v as { id: string }).id),
    );
    expect(ids.size).toBe(1);
  });

  it("draws plain objects and Maps as dicts, class instances as objects", async () => {
    const t = await traceJavaScript(`
      class Point { constructor(x) { this.x = x; } }
      const counts = { a: 1 };
      const m = new Map([["k", 2]]);
      const p = new Point(5);
    `);
    const step = last(t);
    const locals = localsOf(step);
    expect(heapOf(step, locals.get("counts"))).toMatchObject({ kind: "dict", typeName: "Object" });
    expect(heapOf(step, locals.get("m"))).toMatchObject({ kind: "dict", typeName: "Map" });
    expect(heapOf(step, locals.get("p"))).toMatchObject({
      kind: "object",
      typeName: "Point",
      fields: [["x", { repr: "5" }]],
    });
    expect(heapOf(step, locals.get("Point"))).toMatchObject({ kind: "class", name: "Point" });
  });

  it("does not run getters while taking snapshots", async () => {
    const t = await traceJavaScript(`
      let calls = 0;
      const o = { get x() { calls++; return 1; } };
      const done = true;
    `);
    expect(localsOf(last(t)).get("calls")).toMatchObject({ repr: "0" });
  });
});

describe("loops", () => {
  it("counts for-of iterations like the Python tracer", async () => {
    const t = await traceJavaScript(`
      let total = 0;
      for (const x of [5, 6, 7]) {
        total += x;
      }
    `);
    const iterations = new Set(t.steps.flatMap((s) => s.loops.map((l) => l.iteration)));
    expect([...iterations].sort()).toEqual([0, 1, 2, 3]);
  });

  it("counts while iterations", async () => {
    const t = await traceJavaScript(`let n = 0;\nwhile (n < 4) {\n  n++;\n}`);
    expect(Math.max(...t.steps.flatMap((s) => s.loops.map((l) => l.iteration)))).toBe(4);
  });

  it("gives the inner loop a new instance per outer iteration", async () => {
    const t = await traceJavaScript(`
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          i + j;
        }
      }
    `);
    const inner = t.loops[1].id;
    const instances = new Set(t.steps.flatMap((s) => s.loops.filter((l) => l.loop === inner).map((l) => l.instance)));
    expect([...instances]).toEqual([1, 2, 3]);
  });

  it("records the end of an iteration on continue, including labeled continue", async () => {
    const t = await traceJavaScript(`
      let hits = 0;
      outer: for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (j === 1) continue outer;
          hits++;
        }
      }
    `);
    expect(t.error).toBeNull();
    expect(localsOf(last(t)).get("hits")).toMatchObject({ repr: "3" });
    const outer = t.loops[0].id;
    expect(Math.max(...t.steps.flatMap((s) => s.loops.filter((l) => l.loop === outer).map((l) => l.iteration)))).toBe(
      3,
    );
  });

  it("records nested indexing per level", async () => {
    const t = await traceJavaScript(`const g = [[0]];\nlet r = 0;\nlet c = 0;\ng[r][c] += 1;`);
    expect(t.indexNames).toEqual({ g: ["r"], "g[]": ["c"] });
  });

  it("finds which names index which arrays", async () => {
    const t = await traceJavaScript(`const arr = [1, 2, 3];\nlet i = 0;\narr[i + 1] = arr[i];\narr.length;`);
    expect(t.indexNames).toEqual({ arr: ["i"] });
  });
});

describe("functions and scope", () => {
  it("shows one frame per recursive call", async () => {
    const t = await traceJavaScript(`
      function fact(n) {
        return n <= 1 ? 1 : n * fact(n - 1);
      }
      fact(3);
    `);
    expect(Math.max(...t.steps.map((s) => s.stack.length))).toBe(4);
    expect(
      t.steps.some((s) => s.event === "return" && s.returnValue?.kind === "prim" && s.returnValue.repr === "6"),
    ).toBe(true);
  });

  it("names arrow functions, methods and constructors", async () => {
    const t = await traceJavaScript(`
      const double = (x) => x * 2;
      class Box { constructor() { this.v = 1; } get() { return this.v; } }
      double(2);
      new Box().get();
    `);
    const names = new Set(t.steps.flatMap((s) => s.stack.map((f) => f.func)));
    expect(names).toEqual(new Set(["Global", "double", "Box.constructor", "Box.get"]));
  });

  it("shows `this` on every step inside methods, not just the call", async () => {
    const t = await traceJavaScript(`
      class Counter { constructor() { this.n = 0; } inc() { this.n++; return this.n; } }
      new Counter().inc();
    `);
    const inMethod = t.steps.filter((s) => s.stack[s.stack.length - 1].func === "Counter.inc");
    expect(inMethod.map((s) => s.event)).toContain("line");
    expect(inMethod.every((s) => localsOf(s).has("this"))).toBe(true);
  });

  it("shows `this` inside loops in methods, and in arrows within methods", async () => {
    const t = await traceJavaScript(`
      class Bag {
        constructor() { this.items = [1, 2]; }
        sum() {
          let total = 0;
          for (const x of this.items) {
            total += x;
          }
          this.items.forEach((x) => {
            total += x;
          });
          return total;
        }
      }
      new Bag().sum();
    `);
    const loopSteps = t.steps.filter((s) => s.loops.length);
    expect(loopSteps.length).toBeGreaterThan(0);
    expect(loopSteps.every((s) => localsOf(s).has("this"))).toBe(true);
    const inArrow = t.steps.filter((s) => s.event === "line" && s.stack[s.stack.length - 1].func === "anonymous");
    expect(inArrow.length).toBeGreaterThan(0);
    expect(inArrow.every((s) => localsOf(s).has("this"))).toBe(true);
  });

  it("doesn't show `this` in plain functions", async () => {
    const t = await traceJavaScript(`function f() {
  const a = 1;
  return a;
}
f();`);
    expect(t.steps.some((s) => localsOf(s).has("this"))).toBe(false);
  });

  it("shows closure variables on the function object", async () => {
    const t = await traceJavaScript(`
      function makeCounter() {
        let count = 7;
        return () => { count++; return count; };
      }
      const counter = makeCounter();
    `);
    const fn = heapOf(last(t), localsOf(last(t)).get("counter"));
    expect(fn).toMatchObject({ kind: "function", fields: [["count", { repr: "7" }]] });
  });

  it("hides let/const before their declaration instead of crashing", async () => {
    const t = await traceJavaScript(`const a = 1;\nconst b = 2;`);
    expect(t.error).toBeNull();
    expect([...localsOf(t.steps[1]).keys()]).toEqual([]); // before line 1 runs
  });

  it("runs generators and async functions untraced", async () => {
    const t = await traceJavaScript(`
      function* gen() { yield 1; yield 2; }
      const values = [...gen()];
    `);
    expect(t.error).toBeNull();
    expect(reprs(heapOf(last(t), localsOf(last(t)).get("values")))).toEqual(["1", "2"]);
  });
});

describe("errors, limits and output", () => {
  it("reports syntax errors with a line and no steps", async () => {
    const t = await traceJavaScript(`const x = 1;\nconst y = (;`);
    expect(t.steps).toEqual([]);
    expect(t.error).toMatchObject({ type: "SyntaxError", line: 2 });
  });

  it("reports runtime errors with the line they happened on", async () => {
    const t = await traceJavaScript(`const a = null;\nconst b = 1;\na.x;`);
    expect(t.error).toMatchObject({ type: "TypeError", line: 3 });
  });

  it("stops infinite loops (sampled, so at the time budget)", async () => {
    const t = await traceJavaScript(`while (true) {}`, 200, 0.3);
    expect(t.truncated).toBe(true);
    expect(t.stoppedBy).toBe("time");
    expect(t.steps.length).toBeLessThanOrEqual(200);
  });

  it("stops at the step limit when nothing can be sampled", async () => {
    const t = await traceJavaScript(`let a = 0;\n${Array.from({ length: 300 }, () => "a++;").join("\n")}`, 200);
    expect(t.truncated).toBe(true);
    expect(t.stoppedBy).toBe("steps");
    expect(t.steps.length).toBe(200);
  });

  it("doesn't let user code catch the step limit", async () => {
    // Without the catch rewrite, this catch block would run and print.
    const t = await traceJavaScript(
      `
      try {
        while (true) {}
      } catch (e) {
        console.log("caught", e);
      }
    `,
      150,
      0.3,
    );
    expect(t.truncated).toBe(true);
    expect(t.stdout).toBe("");
  });

  it("catches runaway recursion with a clear message", async () => {
    const t = await traceJavaScript(`function f(n) { return f(n + 1); }\nf(0);`, 100000);
    expect(t.error?.type).toBe("RangeError");
    expect(t.error?.message).toContain("base case");
  });

  it("captures console.log output per step", async () => {
    const t = await traceJavaScript(`console.log("a", 1);\nconsole.log([1, "b"], { k: new Map([[1, 2]]) });`);
    expect(t.stdout).toBe(`a 1\n[ 1, 'b' ] { k: Map(1) { 1 => 2 } }\n`);
    expect(last(t).stdoutLength).toBe(t.stdout.length);
  });
});

describe("helpers", () => {
  it("parses parameter lists", async () => {
    expect(parseParams("function f(a, b = 2, ...rest) {}")).toEqual(["a", "b", "...rest"]);
    expect(parseParams("x => x")).toEqual(["x"]);
    expect(parseParams("({ a, b }, [c]) => {}")).toEqual(["{ a, b }", "[c]"]);
  });

  it("formats values like a console", async () => {
    expect(inspect([1, "a", [2]])).toBe("[ 1, 'a', [ 2 ] ]");
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(inspect(o)).toBe("{ a: 1, self: [Circular] }");
  });
});

describe("printed output", () => {
  it("tags the step after console.log with its line and the printed objects", async () => {
    const trace = await traceJavaScript(`const nums = [3, 1, 2];
console.log("start");
nums.sort();
console.log("sorted:", nums, [9]);
setTimeout(() => console.log("later"), 5);
`);
    const outs = trace.steps.filter((s) => s.output).map((s) => s.output!);
    expect(outs.map((o) => o.line)).toEqual([2, 4, 5]);
    const numsId = (last(trace).stack[0].locals.find(([n]) => n === "nums")![1] as { id: string }).id;
    expect(outs[1].refs).toEqual([numsId]); // the temporary [9] isn't drawn, so it isn't listed
    const { printedAt } = await import("../trace/output");
    const i = trace.steps.findIndex((s) => s.output?.line === 4);
    expect(printedAt(trace, i)).toEqual({ text: "sorted: [ 1, 2, 3 ] [ 9 ]", line: 4, refs: [numsId] });
    expect(printedAt(trace, i - 1)).toBeNull();
  });
});

describe("sampling long loops", () => {
  const passes = (t: Trace, loop: string) => {
    const seen = new Set<number>();
    for (const s of t.steps) for (const c of s.loops) if (c.loop === loop && c.instance === 1) seen.add(c.iteration);
    return seen;
  };

  it("records a short loop in full", async () => {
    const t = await traceJavaScript(`let s = 0;\nfor (let i = 0; i < 30; i++) s += i;`, 3000);
    expect(t.sampled).toBeFalsy();
    expect([...passes(t, "L2")].length).toBe(31);
  });

  it("keeps a long loop's first, round-numbered and last passes, and counts the rest", async () => {
    const t = await traceJavaScript(
      `let s = 0;\nfor (let i = 0; i < 40000; i++) {\n  s += i;\n}\nconsole.log(s);`,
      3000,
    );
    expect(t.truncated).toBe(false);
    expect(t.sampled).toBe(true);
    expect(t.stdout).toBe("799980000\n");
    const seen = passes(t, "L2");
    for (const n of [1, 5, 10, 100, 1000, 30000, 39996, 40000]) expect(seen.has(n)).toBe(true);
    expect(seen.has(6)).toBe(false);
    expect(seen.has(1234)).toBe(false);
    const skipped = t.steps.reduce((sum, s) => sum + (s.skipped ?? 0), 0) + (last(t).skippedAfter ?? 0);
    expect(t.steps.length + skipped).toBe(t.counts!.steps);
  });

  it("keeps the last passes of a while loop that ends on a round number", async () => {
    const t = await traceJavaScript(`let n = 0;\nwhile (n < 20000) {\n  n++;\n}\nconst done = n;`, 3000);
    const seen = passes(t, "L2");
    for (const n of [19996, 19997, 19998, 19999, 20000]) expect(seen.has(n)).toBe(true);
    expect(localsOf(last(t)).get("done")).toMatchObject({ repr: "20000" });
  });

  it("samples a callback called again and again (Array.from, map)", async () => {
    const t = await traceJavaScript(
      `const nums = Array.from({ length: 40000 }, (_, i) => i);\nconst d = nums.map((x) => x * 2);`,
      3000,
    );
    expect(t.truncated).toBe(false);
    expect(t.sampled).toBe(true);
    expect(t.steps.length).toBeLessThan(1500);
  });

  it("counts calls and recursion depth", async () => {
    const t = await traceJavaScript(`function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }\nfact(30);`);
    expect(t.counts!.calls.fact).toBe(30);
    expect(t.counts!.depth.fact).toBe(30);
  });

  it("stops at the time budget", async () => {
    const t = await traceJavaScript(`let i = 0;\nwhile (true) { i++; }`, 3000, 0.3);
    expect(t.truncated).toBe(true);
    expect(t.stoppedBy).toBe("time");
    expect(t.counts!.steps).toBeGreaterThan(1000);
  });
});

describe("long lists", () => {
  const listAt = (step: Step) => Object.values(step.heap).find((o) => o.kind === "list") as SequenceObject;
  it("shows a window of cells that follows the index variables", async () => {
    const t = await traceJavaScript(
      `const nums = Array.from({ length: 1000 }, (_, i) => i);\nfor (let j = 990; j > 400; j--) {\n  nums[j] = nums[j - 1];\n}`,
      3000,
    );
    const offsets = new Set(t.steps.map((s) => listAt(s)?.offset ?? 0));
    expect(offsets.has(940)).toBe(true);
    const step = t.steps.find((s) => listAt(s)?.offset === 940)!;
    expect(listAt(step).items[0]).toMatchObject({ repr: expect.any(String) });
  });

  it("adds a strip of evenly spaced samples of a long list of numbers", async () => {
    const t = await traceJavaScript(`const nums = Array.from({ length: 40000 }, (_, i) => i);`, 3000);
    const list = listAt(last(t));
    expect(list.strip!.values.length).toBe(256);
    expect(list.strip!.values[128]).toBe(20000);
    expect(list.offset).toBeUndefined();
  });
});
