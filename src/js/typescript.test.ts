import { describe, expect, it } from "vitest";
import type { HeapObject, Step, Trace, Value } from "../trace/types";
import { traceJavaScript } from "./trace";
import { traceTypeScript } from "./typescript";

const last = (trace: Trace) => trace.steps[trace.steps.length - 1];
const localsOf = (step: Step) => new Map(step.stack[step.stack.length - 1].locals);
const heapOf = (step: Step, value: Value | undefined): HeapObject => {
  if (value?.kind !== "ref") throw new Error("expected a reference");
  return step.heap[value.id];
};
const frameNames = (trace: Trace) => new Set(trace.steps.flatMap((s) => s.stack.map((f) => f.func)));
const globalLines = (trace: Trace) =>
  trace.steps.filter((s) => s.stack.length === 1 && s.event === "line").map((s) => s.line);

describe("TypeScript", () => {
  it("traces exactly like the equivalent JavaScript once types are removed", async () => {
    const ts = await traceTypeScript(`
      const arr: number[] = [3, 1, 2];
      for (let i: number = 0; i < arr.length; i++) {
        arr[i] = (arr[i] as number) * 2;
      }
    `);
    const js = await traceJavaScript(`
      const arr = [3, 1, 2];
      for (let i = 0; i < arr.length; i++) {
        arr[i] = (arr[i]) * 2;
      }
    `);
    expect(ts.error).toBeNull();
    expect(ts.language).toBe("typescript");
    expect(ts.steps.map((s) => [s.event, s.line])).toEqual(js.steps.map((s) => [s.event, s.line]));
    expect(ts.indexNames).toEqual({ arr: ["i"] });
  });

  it("keeps line numbers when type-only declarations are removed", async () => {
    const t = await traceTypeScript(`interface P {\n  x: number;\n}\ntype Id = string;\nconst a: P = { x: 1 };\nconst b: Id = "z";`);
    expect(globalLines(t)).toEqual([5, 6]);
  });

  it("removes overload signatures, generics, `!` and `satisfies`", async () => {
    const t = await traceTypeScript(`
      function pick(x: string): string;
      function pick(x: number): number;
      function pick<T>(x: T): T { return x; }
      const v = pick<number>(4)!;
      const o = { k: 1 } satisfies Record<string, number>;
    `);
    expect(t.error).toBeNull();
    expect(localsOf(last(t)).get("v")).toMatchObject({ repr: "4" });
  });

  it("turns parameter properties into fields without extra steps", async () => {
    const t = await traceTypeScript(`
      class Pt {
        constructor(public x: number, private y: number) {}
      }
      const p = new Pt(1, 2);
    `);
    expect(heapOf(last(t), localsOf(last(t)).get("p"))).toMatchObject({
      kind: "object",
      typeName: "Pt",
      fields: [["x", { repr: "1" }], ["y", { repr: "2" }]],
    });
    // The generated `this.x = x` lines are not steps of their own.
    const inCtor = t.steps.filter((s) => s.stack[s.stack.length - 1].func === "Pt.constructor");
    expect(inCtor.map((s) => s.event)).toEqual(["call", "return"]);
  });

  it("gives enums a step on their own line and hides the generated helper", async () => {
    const t = await traceTypeScript(`enum Color {\n  Red,\n  Green,\n}\nconst c = Color.Green;`);
    expect(t.error).toBeNull();
    expect(globalLines(t)).toEqual([1, 5]);
    expect(frameNames(t)).toEqual(new Set(["Global"]));
    expect(localsOf(last(t)).get("c")).toMatchObject({ repr: "1" });
  });

  it("runs namespaces untraced but makes their exports available", async () => {
    const t = await traceTypeScript(`namespace Geo {\n  export const unit = 2;\n}\nconst r = Geo.unit * 3;`);
    expect(t.error).toBeNull();
    expect(localsOf(last(t)).get("r")).toMatchObject({ repr: "6" });
    expect(globalLines(t)).toEqual([1, 4]);
  });

  it("drops abstract and declare members and keeps real fields", async () => {
    const t = await traceTypeScript(`
      abstract class Shape {
        abstract area(): number;
        declare tag: string;
        sides = 0;
      }
      class Square extends Shape {
        constructor(private side: number) { super(); this.sides = 4; }
        area(): number { return this.side * this.side; }
      }
      const a = new Square(3).area();
    `);
    expect(t.error).toBeNull();
    expect(localsOf(last(t)).get("a")).toMatchObject({ repr: "9" });
    expect(frameNames(t)).toEqual(new Set(["Global", "Square.constructor", "Square.area"]));
  });

  it("reports TypeScript syntax errors with a line", async () => {
    const t = await traceTypeScript(`const ok = 1;\nlet x: = 5;`);
    expect(t.steps).toEqual([]);
    expect(t.error).toMatchObject({ type: "SyntaxError", line: 2 });
  });

  it("runs code with type errors, like a compiler with type checking off", async () => {
    const t = await traceTypeScript(`const n: number = "not a number" as any;\nconst m: string = n;`);
    expect(t.error).toBeNull();
    expect(localsOf(last(t)).get("m")).toMatchObject({ repr: '"not a number"' });
  });

  it("explains unsupported JSX and decorators", async () => {
    expect((await traceTypeScript(`const a = 1;\nconst el = <div>hi</div>;`)).error).toMatchObject({ line: 2, message: expect.stringContaining("JSX isn't supported") });
    expect((await traceTypeScript(`function log(t: any) {}\n@log\nclass A {}`)).error).toMatchObject({ line: 2, message: "Decorators aren't supported." });
    expect((await traceJavaScript(`const el = <p/>;`)).error?.message).toContain("JSX isn't supported");
  });

  it("rejects imports and exports with a clear message", async () => {
    const t = await traceTypeScript(`import { x } from "y";\nconst a = 1;`);
    expect(t.error).toMatchObject({ type: "SyntaxError", line: 1 });
    expect(t.error?.message).toContain("import and export");
    expect((await traceJavaScript(`export const a = 1;`)).error?.message).toContain("import and export");
  });
});
