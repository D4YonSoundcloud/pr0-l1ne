import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { shapeOf, shapePrim } from "./shape";

describe("trace shapes", () => {
  it("spell primitives the same way for both languages", () => {
    expect([shapePrim("int", "3"), shapePrim("number", "3")]).toEqual(["3", "3"]);
    expect([shapePrim("bool", "True"), shapePrim("boolean", "true")]).toEqual(["true", "true"]);
    expect([shapePrim("none", "None"), shapePrim("null", "null"), shapePrim("undefined", "undefined")]).toEqual([
      "null",
      "null",
      "null",
    ]);
    expect([shapePrim("str", "'it\\'s'"), shapePrim("string", '"it\'s"')]).toEqual(['"it\'s"', '"it\'s"']);
  });

  it("show a second name for an object as a reference, not a copy", async () => {
    const shape = shapeOf(await traceJavaScript("const a = [1];\nconst b = a;\nconst c = [1];\n"));
    expect(shape.globals).toEqual({ a: { list: ["1"] }, b: { same: 0 }, c: { list: ["1"] } });
  });

  it("mark cycles", async () => {
    const shape = shapeOf(await traceJavaScript("const a = { next: null };\na.next = a;\n"));
    expect(shape.globals.a).toEqual({ dict: [['"next"', { same: 0 }]] });
  });

  it("count loop passes and list the recorded ones when a loop was sampled", async () => {
    const short = shapeOf(await traceJavaScript("for (let i = 0; i < 3; i++) {}\n"));
    expect(short.loops).toEqual([{ kind: "for", runs: 1, passes: [3] }]);
    const long = shapeOf(await traceJavaScript("let t = 0;\nfor (let i = 0; i < 5000; i++) t += i;\n", 20_000));
    expect(long.loops[0].passes).toEqual([5000]);
    expect(long.loops[0].recorded?.[0]).toEqual(expect.arrayContaining([0, 1, 10, 100, 1000, 5000]));
  });

  it("leave out functions, classes and ignored names", async () => {
    const shape = shapeOf(await traceJavaScript("function f() {}\nclass C {}\nconst x = 1;\nconst y = 2;\n"), {
      ignore: ["y"],
    });
    expect(shape.globals).toEqual({ x: "1" });
  });
});
