import { describe, expect, it } from "vitest";
import { evaluate, evaluateText, namesIn, parseExpr, showVal, type Val } from "./expr";
import type { HeapObject, Value } from "./types";

const vars: Record<string, Val> = { a: 7, b: 2, s: "abca", nums: [3, 1, 4, 1, 5], d: { dict: [["x", 1]] }, t: true };
const run = (text: string, language: "python" | "javascript" = "python") =>
  evaluate(
    parseExpr(text),
    (name) => {
      if (!(name in vars)) throw new Error(`${name} isn't set`);
      return vars[name];
    },
    language,
  );

describe("expressions in hints", () => {
  it("does arithmetic, with Python's and JavaScript's spellings", () => {
    expect(run("a - b + 1")).toBe(6);
    expect(run("a * b ** 2")).toBe(28);
    expect(run("a // b")).toBe(3);
    expect(run("a / b")).toBe(3.5);
    expect(run("-a % 3", "python")).toBe(2);
    expect(run("-a % 3", "javascript")).toBe(-1);
    expect(run("(a + b) * 2")).toBe(18);
  });

  it("compares, and combines with and/or/not or &&/||/!", () => {
    expect(run("a > b and b > 0")).toBe(true);
    expect(run("a > b && b < 0")).toBe(false);
    expect(run("not t || a === 7")).toBe(true);
    expect(run("!(a == 7)")).toBe(false);
    expect(run("a != b")).toBe(true);
    expect(run('"a" in s')).toBe(true);
    expect(run("9 not in nums")).toBe(true);
    expect(run('"x" in d')).toBe(true);
  });

  it("reads lists, strings and dicts: indexes, slices, length, and a few functions", () => {
    expect(run("nums[2]")).toBe(4);
    expect(run("nums[-1]", "python")).toBe(5);
    expect(run("nums[1:3]")).toEqual([1, 4]);
    expect(run("s[1:]")).toBe("bca");
    expect(run("sum(nums[0:3])")).toBe(8);
    expect(run("len(s) + nums.length")).toBe(9);
    expect(run("max(nums) - min(a, b)")).toBe(3);
    expect(run("abs(b - a)")).toBe(5);
    expect(run("round(a / 3, 2)")).toBe(2.33);
    expect(run('d["x"]')).toBe(1);
    expect(run("nums[0:2] == [3, 1]")).toBe(true);
  });

  it("says when it can't work something out", () => {
    expect(() => run("nums[9]")).toThrow(/out of range/);
    expect(() => run("missing + 1")).toThrow(/isn't set/);
    expect(() => run("s - 1")).toThrow(/not a number/);
    expect(() => parseExpr("a +")).toThrow();
    expect(() => parseExpr("eval(a)")).toThrow(/isn't a function/);
    expect(() => parseExpr("a b")).toThrow(/unexpected/);
  });

  it("lists the names an expression reads", () => {
    expect(namesIn(parseExpr("total == sum(nums[left:right + 1])"))).toEqual(["total", "nums", "left", "right"]);
  });

  it("shows values as the program's language would", () => {
    expect(showVal(true, "python")).toBe("True");
    expect(showVal(true, "javascript")).toBe("true");
    expect(showVal(null, "python")).toBe("None");
    expect(showVal("hi", "python")).toBe("'hi'");
    expect(showVal(1 / 3)).toBe("0.333333");
    expect(showVal([1, "a"], "javascript")).toBe('[1, "a"]');
  });

  it("works with a step's variables and heap", () => {
    const heap: Record<string, HeapObject> = {
      o1: {
        kind: "list",
        id: "o1",
        typeName: "list",
        items: [
          { kind: "prim", type: "int", repr: "2" },
          { kind: "prim", type: "int", repr: "5" },
        ],
        length: 2,
      },
      o2: { kind: "list", id: "o2", typeName: "list", items: [], length: 400 },
    };
    const locals = new Map<string, Value>([
      ["nums", { kind: "ref", id: "o1" }],
      ["part", { kind: "ref", id: "o2" }],
      ["i", { kind: "prim", type: "int", repr: "1" }],
      ["flag", { kind: "prim", type: "bool", repr: "True" }],
    ]);
    expect(evaluateText("nums[i] + sum(nums)", locals, heap)).toBe(12);
    expect(evaluateText("flag and i == 1", locals, heap)).toBe(true);
    // Only part of a long list was recorded: can't sum it.
    expect(evaluateText("sum(part)", locals, heap)).toBeUndefined();
    expect(evaluateText("nope", locals, heap)).toBeUndefined();
  });
});
