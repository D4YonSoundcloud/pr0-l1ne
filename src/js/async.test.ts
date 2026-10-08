import { describe, expect, it } from "vitest";
import { buildLoopHistory } from "../trace/loopHistory";
import type { Step, Trace } from "../trace/types";
import { traceJavaScript } from "./trace";
import { traceTypeScript } from "./typescript";

const events = (t: Trace) => t.steps.map((s) => s.event);
const names = (step: Step) => step.stack.map((f) => f.func);
const paused = (step: Step) => (step.suspended ?? []).map((f) => f.func);
const value = (t: Trace, name: string) => {
  const last = t.steps[t.steps.length - 1];
  const v = new Map(last.stack[0]?.locals ?? []).get(name);
  return v?.kind === "prim" ? v.repr : v;
};

describe("generators", () => {
  const COUNTDOWN = `
function* countdown(n) {
  while (n > 0) {
    yield n;
    n--;
  }
}
const g = countdown(2);
const a = g.next().value;
const b = g.next().value;
`;

  it("records yields and resumes, with the generator's own frame", async () => {
    const t = await traceJavaScript(COUNTDOWN);
    expect(t.error).toBeNull();
    expect(value(t, "a")).toBe("2");
    expect(value(t, "b")).toBe("1");
    const yields = t.steps.filter((s) => s.event === "yield");
    expect(yields.map((s) => s.returnValue)).toEqual([
      { kind: "prim", type: "number", repr: "2" },
      { kind: "prim", type: "number", repr: "1" },
    ]);
    expect(events(t)).toContain("resume");
    const resume = t.steps.find((s) => s.event === "resume")!;
    expect(names(resume)).toEqual(["Global", "countdown"]);
  });

  it("shows a paused generator as suspended, keeping its variables", async () => {
    const t = await traceJavaScript(COUNTDOWN);
    const between = t.steps.find((s) => s.event === "line" && s.line === 10)!; // const b = ...
    expect(names(between)).toEqual(["Global"]);
    expect(paused(between)).toEqual(["countdown"]);
    expect(between.suspended![0]).toMatchObject({ state: "suspended", locals: [["n", { repr: "2" }]] });
  });

  it("keeps the loop history of a loop that spans pauses", async () => {
    const t = await traceJavaScript(`
function* naturals() {
  let i = 0;
  while (true) {
    yield i;
    i++;
  }
}
const it = naturals();
const firstThree = [it.next().value, it.next().value, it.next().value];
`);
    const index = t.steps.length - 2;
    const history = buildLoopHistory(t, index, null)!;
    expect(history.info.kind).toBe("while");
    // "before", then three passes: the third is still running, paused at
    // its yield.
    expect(history.rows.map((r) => r.iteration)).toEqual([0, 1, 2, 3]);
    expect(history.running).toBe(true);
  });

  it("follows yield* into the inner generator", async () => {
    const t = await traceJavaScript(`
function* inner() {
  yield 1;
  yield 2;
}
function* outer() {
  yield* inner();
  yield 3;
}
const all = [...outer()];
`);
    expect(t.error).toBeNull();
    const funcs = new Set(t.steps.flatMap((s) => s.stack.map((f) => f.func)));
    expect(funcs).toEqual(new Set(["Global", "outer", "inner"]));
    const last = t.steps[t.steps.length - 1];
    expect(last.event).toBe("return");
    expect(last.suspended ?? []).toEqual([]);
  });

  it("handles an exception thrown into a paused generator", async () => {
    const t = await traceJavaScript(`
function* careful() {
  try {
    yield 1;
  } catch (e) {
    const recovered = e.message;
    yield recovered;
  }
}
const g = careful();
g.next();
const answer = g.throw(new Error("boom")).value;
`);
    expect(t.error).toBeNull();
    expect(value(t, "answer")).toBe('"boom"');
    const recovering = t.steps.find((s) => s.event === "line" && s.line === 6)!;
    expect(names(recovering)).toEqual(["Global", "careful"]);
  });

  it("forgets a generator that finished", async () => {
    const t = await traceJavaScript(`function* one() {\n  yield 1;\n}\nconst xs = [...one()];\nconst done = true;`);
    const last = t.steps[t.steps.length - 1];
    expect(last.suspended ?? []).toEqual([]);
  });
});

describe("async functions", () => {
  it("runs code after await, with Global still on the stack", async () => {
    const t = await traceJavaScript(`
async function double(x) {
  await null;
  return x * 2;
}
let result = 0;
double(21).then((v) => {
  result = v;
});
`);
    expect(t.error).toBeNull();
    expect(value(t, "result")).toBe("42");
    const afterAwait = t.steps.find((s) => s.event === "resume")!;
    expect(names(afterAwait)).toEqual(["Global", "double"]);
    expect(t.steps[t.steps.length - 1].event).toBe("return"); // Program finished, at the very end
  });

  it("shows an async function as suspended while it waits", async () => {
    const t = await traceJavaScript(`
async function wait() {
  await null;
}
wait();
const meanwhile = 1;
`);
    const meanwhile = t.steps.find((s) => s.event === "line" && s.line === 6)!;
    expect(paused(meanwhile)).toEqual(["wait"]);
  });

  it("takes a paused function off the stack before other code runs", async () => {
    // wait() pauses on the script's last line, so the next thing to run is
    // the timer callback: the paused frame must not be under it.
    const t = await traceJavaScript(`
async function wait() {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
setTimeout(() => {
  const tick = 1;
}, 50);
wait();
`);
    const inCallback = t.steps.find((s) => s.event === "line" && s.line === 6)!;
    expect(names(inCallback)).toEqual(["Global", "anonymous"]);
    expect(paused(inCallback)).toEqual(["wait"]);
  });

  it("runs timers in deadline order on a virtual clock", async () => {
    const started = Date.now();
    const t = await traceJavaScript(`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const order = [];
async function task(name, ms) {
  await sleep(ms);
  order.push(name);
}
task("slow", 5000);
task("fast", 1000);
setTimeout(() => order.push("timer"), 3000);
`);
    expect(t.error).toBeNull();
    const last = t.steps[t.steps.length - 1];
    const order = new Map(last.stack[0].locals).get("order");
    const heap = order?.kind === "ref" ? last.heap[order.id] : null;
    expect(heap && "items" in heap ? heap.items.map((v) => (v.kind === "prim" ? v.repr : "")) : []).toEqual(['"fast"', '"timer"', '"slow"']);
    expect(Date.now() - started).toBeLessThan(2000); // 5 virtual seconds, not real ones
  });

  it("reports an async error nobody caught, with its line", async () => {
    const t = await traceJavaScript(`
async function fail() {
  await null;
  throw new TypeError("bad input");
}
fail();
`);
    expect(t.error).toMatchObject({ type: "TypeError", message: "bad input", line: 4 });
  });

  it("doesn't report an async error that was caught", async () => {
    const t = await traceJavaScript(`
async function fail() {
  await null;
  throw new Error("handled");
}
async function main() {
  try {
    await fail();
  } catch (e) {
    return e.message;
  }
}
main();
`);
    expect(t.error).toBeNull();
  });

  it("traces for await over an async generator, as a loop", async () => {
    const t = await traceJavaScript(`
async function* ticks(n) {
  for (let i = 0; i < n; i++) {
    yield i;
  }
}
async function main() {
  let sum = 0;
  for await (const t of ticks(3)) {
    sum += t;
  }
  return sum;
}
main();
`);
    expect(t.error).toBeNull();
    const awaitLoop = t.loops.find((l) => l.header.startsWith("for await"))!;
    const iterations = t.steps.flatMap((s) => s.loops.filter((l) => l.loop === awaitLoop.id).map((l) => l.iteration));
    expect(Math.max(...iterations)).toBe(3);
    const ret = t.steps.find((s) => s.event === "return" && s.stack[s.stack.length - 1].func === "main")!;
    expect(ret.returnValue).toMatchObject({ repr: "3" });
  });

  it("stops an endless setInterval at the step limit", async () => {
    const t = await traceJavaScript(`let n = 0;\nsetInterval(() => {\n  n++;\n}, 10);`, 300);
    expect(t.truncated).toBe(true);
  });

  it("stops an endless async loop at the step limit", async () => {
    const t = await traceJavaScript(`async function spin() {\n  while (true) {\n    await null;\n  }\n}\nspin();`, 300);
    expect(t.truncated).toBe(true);
    expect(t.error).toBeNull();
  });

  it("works in TypeScript too", async () => {
    const t = await traceTypeScript(`
async function square(x: number): Promise<number> {
  await null;
  return x * x;
}
let out: number = 0;
square(7).then((v: number) => {
  out = v;
});
`);
    expect(t.error).toBeNull();
    expect(value(t, "out")).toBe("49");
  });
});
