/**
 * The app's check of what the runner sends: real traces pass, and anything
 * a program could do to its own trace to trip the app up is refused,
 * naming what's wrong.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { dataLimitProblem, traceProblem } from "./checkTrace";

const real = () =>
  traceJavaScript("const xs = [1, 2, 3];\nconst o = { a: xs };\nfor (const x of xs) console.log(x);\n");
type Loose = { steps: { heap: Record<string, Record<string, unknown>>; line: unknown }[] } & Record<string, unknown>;

describe("traceProblem", () => {
  it("accepts a real trace, heap objects shared between steps and all", async () => {
    const trace = await real();
    expect(traceProblem(trace)).toBeNull();
    // Share one heap object between every step, as the Python worker does.
    const shared = trace.steps.at(-1)!.heap;
    const id = Object.keys(shared)[0];
    for (const step of trace.steps) step.heap[id] = shared[id];
    expect(traceProblem(trace)).toBeNull();
  });

  it("names the field that doesn't fit the trace format", async () => {
    const trace = (await real()) as unknown as Loose;
    trace.steps[1].line = "two";
    expect(traceProblem(trace)).toBe("steps[1].line: should be number");
  });

  it("checks heap objects, naming where they are", async () => {
    const trace = (await real()) as unknown as Loose;
    const last = trace.steps.length - 1;
    const id = Object.keys(trace.steps[last].heap)[0];
    trace.steps[last].heap[id] = { kind: "list" };
    expect(traceProblem(trace)).toMatch(new RegExp(`^steps\\[${last}\\]\\.heap\\.${id}: `));
    trace.steps[last].heap[id] = "not an object" as unknown as Record<string, unknown>;
    expect(traceProblem(trace)).toMatch(/heap/);
  });

  it("refuses fields the format doesn't have, and things that aren't a trace", async () => {
    const trace = (await real()) as unknown as Loose;
    expect(traceProblem({ ...trace, surprise: 1 })).toBe(
      'the trace: has "surprise", which isn\'t part of the trace format',
    );
    expect(traceProblem(null)).not.toBeNull();
    expect(traceProblem([])).not.toBeNull();
  });

  it("refuses a `__proto__` key, which could reach every object's prototype", async () => {
    const trace = (await real()) as unknown as Loose;
    // JSON.parse (like structured clone) makes "__proto__" an ordinary key of its own.
    trace.steps[0].heap = JSON.parse('{"__proto__": {"kind": "list", "items": []}}');
    expect(traceProblem(trace)).toBe('it has a "__proto__" key');
  });

  it("refuses a trace that refers to itself", async () => {
    const trace = (await real()) as unknown as Loose;
    trace.loop = trace;
    expect(traceProblem(trace)).toBe("it refers to itself (a cycle)");
  });
});

describe("dataLimitProblem", () => {
  it("accepts plain data, shared or not", () => {
    const shared = { a: [1, "two", null, true] };
    expect(dataLimitProblem({ x: shared, y: shared, z: [shared, shared] })).toBeNull();
    expect(dataLimitProblem(Object.assign(Object.create(null), { a: 1 }))).toBeNull();
  });

  it("refuses anything but plain data", () => {
    expect(dataLimitProblem({ a: new Map() })).toBe("it holds a Map object");
    expect(dataLimitProblem({ a: new Date() })).toBe("it holds a Date object");
    expect(dataLimitProblem({ a: () => 1 })).toBe("it holds a function");
    expect(dataLimitProblem({ a: 1n })).toBe("it holds a bigint");
    expect(dataLimitProblem({ a: undefined })).toBe("it holds a undefined");
    class Sneaky extends Array {}
    expect(dataLimitProblem([new Sneaky()])).toBe("it holds a non-plain array");
  });

  it("refuses cycles at any depth", () => {
    const a: Record<string, unknown> = {};
    const b = { a };
    a.b = [b];
    expect(dataLimitProblem({ start: a })).toBe("it refers to itself (a cycle)");
  });

  it("holds to its limits on objects, depth and text", () => {
    const limits = { objects: 10, depth: 5, chars: 20 };
    expect(
      dataLimitProblem(
        Array.from({ length: 10 }, () => ({})),
        limits,
      ),
    ).toBe("it has too many objects");
    let deep: unknown = 1;
    for (let i = 0; i < 6; i++) deep = [deep];
    expect(dataLimitProblem(deep, limits)).toBe("it nests too deeply");
    expect(dataLimitProblem({ a: "x".repeat(21) }, limits)).toBe("it has too much text");
    expect(dataLimitProblem({ ["k".repeat(21)]: 1 }, limits)).toBe("it has too much text");
    // A deep structure under the default limit doesn't overflow the stack: it's walked without recursion.
    let deeper: unknown = 1;
    for (let i = 0; i < 99; i++) deeper = { d: deeper };
    expect(dataLimitProblem(deeper)).toBeNull();
  });
});
