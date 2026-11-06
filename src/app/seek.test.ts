/**
 * Run to a line (seek.ts): the next step at a line, or the one before,
 * from where you are; never before the timeline's first step; SQL by its
 * clauses' lines; and how many steps are at each line.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import type { TraceInfo } from "../trace/summary";
import { summarize } from "../trace/summary";
import { lineAt, stepAtLine, stepsPerLine } from "./seek";

const CODE = `let total = 0;
for (let i = 0; i < 3; i++) {
  total += i;
}
console.log(total);
`;

async function info(code: string): Promise<TraceInfo> {
  const trace = await traceJavaScript(code);
  return summarize(trace, trace);
}

describe("run to a line", () => {
  it("goes to the next step at the line, then the next, and back again", async () => {
    const t = await info(CODE);
    const at3 = [...Array(t.steps).keys()].filter((i) => lineAt(t, i) === 3);
    expect(at3).toHaveLength(3); // once a pass
    expect(stepAtLine(t, 3, 0, false)).toBe(at3[0]);
    expect(stepAtLine(t, 3, at3[0], false)).toBe(at3[1]);
    expect(stepAtLine(t, 3, at3[2], false)).toBeNull(); // no pass after the last
    expect(stepAtLine(t, 3, at3[2], true)).toBe(at3[1]);
    expect(stepAtLine(t, 3, at3[0], true)).toBeNull();
    expect(stepAtLine(t, 4, 0, false)).toBeNull(); // the closing brace never runs
  });

  it("never goes before the timeline's first step", async () => {
    const t = await info(CODE);
    expect(lineAt(t, 0)).toBeNull(); // "called Global": at no line
    expect(stepAtLine(t, 1, 5, true, 2)).toBeNull(); // line 1 is next only at step 1
    expect(stepAtLine(t, 1, 5, true)).toBe(1);
  });

  it("counts the steps at each line, from the first step shown", async () => {
    const t = await info(CODE);
    const counts = stepsPerLine(t, 2);
    expect(counts.get(3)).toBe(3);
    expect(counts.get(5)).toBe(1);
    expect(counts.has(4)).toBe(false);
    expect(counts.has(1)).toBe(false); // only before the first step shown
  });

  it("goes by the clause's line for SQL", () => {
    const t = {
      steps: 3,
      lines: [1, 1, 1],
      events: ["line", "line", "line"],
      stages: [
        { clause: "FROM pets", line: 2 },
        { clause: "WHERE age > 3", line: 3 },
        { clause: "SELECT name", line: 1 },
      ],
    } as unknown as TraceInfo;
    expect(stepAtLine(t, 3, 0, false)).toBe(1);
    expect(stepAtLine(t, 1, 0, false)).toBe(2);
    expect(stepAtLine(t, 2, 2, true)).toBe(0);
  });
});
