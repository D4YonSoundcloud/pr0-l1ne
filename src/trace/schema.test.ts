import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script, no type declarations
import { generateSchemaText, SCHEMA_FILE } from "../../scripts/schema.mjs";
import { traceJavaScript } from "../js/trace";
import { fieldPath, traceProblems } from "./validate";

describe("the trace schema", () => {
  it("is up to date with src/trace/types.ts (run `npm run schema` if not)", () => {
    expect(readFileSync(SCHEMA_FILE, "utf8")).toBe(generateSchemaText());
  }, 30_000);

  it("accepts a real trace", async () => {
    const trace = await traceJavaScript("const xs = [1, 2];\nfor (const x of xs) console.log(x);\n");
    expect(traceProblems(trace)).toEqual([]);
  });

  it("names the field that's wrong", async () => {
    const trace = await traceJavaScript("const xs = [1, 2];\n");
    const broken = structuredClone(trace) as unknown as { steps: { line: unknown }[]; truncated?: unknown };
    broken.steps[1].line = "two";
    delete broken.truncated;
    const problems = traceProblems(broken);
    expect(problems).toContain('the trace: needs "truncated"');
    expect(problems).toContain("steps[1].line: should be number");
  });

  it("explains a broken heap object as the kind it says it is", async () => {
    const trace = (await traceJavaScript("const xs = [1, 2];\n")) as unknown as {
      steps: { heap: Record<string, Record<string, unknown>> }[];
    };
    const last = trace.steps[trace.steps.length - 1];
    const id = Object.keys(last.heap)[0];
    delete last.heap[id].items;
    expect(traceProblems(trace)).toEqual([`steps[${trace.steps.length - 1}].heap.${id}: needs "items"`]);
  });

  it("says when an object's kind isn't one it knows", async () => {
    const trace = (await traceJavaScript("const xs = [1, 2];\n")) as unknown as {
      steps: { heap: Record<string, Record<string, unknown>> }[];
    };
    const last = trace.steps[trace.steps.length - 1];
    const id = Object.keys(last.heap)[0];
    last.heap[id].kind = "lisst";
    expect(traceProblems(trace)).toEqual([
      `steps[${trace.steps.length - 1}].heap.${id}: isn't any kind the trace format knows (check its "kind")`,
    ]);
  });

  it("flags fields that aren't part of the format", async () => {
    const trace = (await traceJavaScript("let a = 1;\n")) as unknown as Record<string, unknown>;
    expect(traceProblems({ ...trace, surprise: 1 })).toEqual([
      'the trace: has "surprise", which isn\'t part of the trace format',
    ]);
  });

  it("writes paths the way you'd type them", () => {
    expect(fieldPath("")).toBe("the trace");
    expect(fieldPath("/steps/3/heap/o4/items/0")).toBe("steps[3].heap.o4.items[0]");
  });
});
