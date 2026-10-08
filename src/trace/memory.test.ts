import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { formatBytes, ownAndTotal, stepSizes } from "./memory";
import type { Trace } from "./types";

function py(code: string): Trace | null {
  try {
    const json = execFileSync("python3", ["-c", "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read(), 3000))"],
      { input: code, encoding: "utf8" });
    return JSON.parse(json) as Trace;
  } catch {
    return null;
  }
}

const last = (t: Trace) => t.steps[t.steps.length - 1];
const idOf = (t: Trace, name: string) => {
  const v = last(t).stack[0].locals.find(([n]) => n === name)![1];
  return v.kind === "ref" ? v.id : "";
};

describe("textbook model", () => {
  it("is 8 bytes a slot, numbers in the slot, one byte a character", async () => {
    const t = await traceJavaScript(`const nums = [1, 2, 3, 4];\nconst words = ["hi", "there"];\nconst map = new Map([["a", 1]]);\nconst point = { x: 1, y: 2 };`);
    const s = stepSizes(last(t), "textbook");
    expect(s.own(idOf(t, "nums"))).toBe(32);
    expect(s.total(idOf(t, "nums"))).toBe(32);
    expect(s.own(idOf(t, "words"))).toBe(16);
    expect(s.total(idOf(t, "words"))).toBe(16 + 2 + 5);
    expect(s.own(idOf(t, "map"))).toBe(16);
    // A plain object is drawn as a dict, so it's counted like a hash map too.
    expect(s.own(idOf(t, "point"))).toBe(32);
  });

  it("counts a shared object once in a total", async () => {
    const t = await traceJavaScript(`const row = [1, 2];\nconst grid = [row, row];`);
    const s = stepSizes(last(t), "textbook");
    expect(s.total(idOf(t, "grid"))).toBe(16 + 16);
  });

  it("knows a typed array's element size", async () => {
    const t = await traceJavaScript(`const bytes = new Uint8Array(10);\nconst floats = new Float64Array(3);`);
    const s = stepSizes(last(t), "textbook");
    expect(s.own(idOf(t, "bytes"))).toBe(10);
    expect(s.own(idOf(t, "floats"))).toBe(24);
  });

  it("follows linked nodes into a total", async () => {
    const t = await traceJavaScript(`class Node { constructor(v, next = null) { this.v = v; this.next = next; } }\nconst head = new Node(1, new Node(2, new Node(3)));`);
    const s = stepSizes(last(t), "textbook");
    expect(s.own(idOf(t, "head"))).toBe(16);
    expect(s.total(idOf(t, "head"))).toBe(48);
  });
});

describe("V8 estimate", () => {
  it("stores small integers in 4-byte slots and boxes other numbers", async () => {
    const t = await traceJavaScript(`const ints = [1, 2, 3];\nconst doubles = [1.5, 2.5];\nconst mixed = [1.5, "a"];`);
    const s = stepSizes(last(t), "v8");
    expect(s.approximate).toBe(true);
    expect(s.own(idOf(t, "ints"))).toBe(16 + 8 + 12);
    expect(s.own(idOf(t, "doubles"))).toBe(16 + 8 + 16); // unboxed doubles
    expect(s.total(idOf(t, "mixed"))).toBe(16 + 8 + 8 + 12 + 16); // a HeapNumber and a string
  });

  it("uses the real length of a shortened string", async () => {
    const t = await traceJavaScript(`const long = ["x".repeat(500)];`);
    const s = stepSizes(last(t), "v8");
    expect(s.total(idOf(t, "long"))).toBe(16 + 8 + 4 + 512);
  });
});

describe("Python model", () => {
  it("uses the sizes a 64-bit CPython reports", () => {
    const t = py(`nums = [1, 2, 3]\nword = "hello"\npairs = {"a": 1}\n`);
    if (!t) return;
    const s = stepSizes(last(t), "python");
    const nums = idOf(t, "nums");
    expect(s.own(nums)).toBe(88);
    expect(s.total(nums)).toBe(88 + 3 * 28); // three int objects
    expect(s.cell({ kind: "prim", type: "int", repr: "7" })).toBe(8 + 28); // pointer + int
    expect(s.capacity(nums)).toBe(4);
    expect(s.total(idOf(t, "pairs"))).toBe(184 + 42 + 28);
    expect(s.program).toBeGreaterThan(88 + 184);
  });
});

describe("formatting", () => {
  it("reads like a person would write it", () => {
    expect(formatBytes(36)).toBe("36 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(64, true)).toBe("≈ 64 B");
  });

  it("shows own and total together, or just own when there's nothing more", async () => {
    const t = await traceJavaScript(`const words = ["hi"];\nconst nums = [1];`);
    const s = stepSizes(last(t), "textbook");
    expect(ownAndTotal(s, idOf(t, "words"))).toBe("8 B · total 10 B");
    expect(ownAndTotal(s, idOf(t, "nums"))).toBe("8 B");
  });
});
