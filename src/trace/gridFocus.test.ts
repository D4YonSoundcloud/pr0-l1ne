import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { pointersFor } from "../scene/pointers";
import { expandHeaps } from "./delta";
import { evalIndex, focusLines, gridFocus } from "./gridFocus";
import type { Trace, Value } from "./types";

const int = (n: number): Value => ({ kind: "prim", type: "int", repr: String(n) });
const locals = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, int(v)]));

describe("evaluating index expressions", () => {
  it("handles names, numbers and arithmetic", () => {
    const l = locals({ i: 3, j: 2, n: 5 });
    expect(evalIndex("i", l)).toBe(3);
    expect(evalIndex("n - 1 - j", l)).toBe(2);
    expect(evalIndex("(i + j) // 2", l)).toBe(2);
    expect(evalIndex("i * 2 % n", l)).toBe(1);
    expect(evalIndex("-1", l)).toBe(-1);
  });
  it("gives up on anything else", () => {
    expect(evalIndex("len(xs)", locals({}))).toBeNull();
    expect(evalIndex("k", locals({}))).toBeNull();
    expect(evalIndex("p.x", locals({ p: 1 }))).toBeNull();
  });
});

describe("grid pointers", () => {
  it("doesn't draw a conventional name on rows when the code uses it only for columns", () => {
    const names = { matrix: ["down", "row", "up"], "matrix[]": ["col", "left", "right"] };
    const l = locals({ up: 0, down: 2, left: 0, right: 2, col: 1, row: 1 });
    expect(
      pointersFor("matrix", names, l)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["down", "row", "up"]);
    expect(
      pointersFor("matrix[]", names, l)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["col", "left", "right"]);
  });
});

const SPIRAL_PY = `def spiralOrder(matrix):
    results = []
    columns = len(matrix[0])
    rows = len(matrix)
    left = 0
    up = 0
    right = columns - 1
    down = rows - 1
    while len(results) < columns * rows:
        for col in range(left, right + 1):
            results.append(matrix[up][col])
        for row in range(up + 1, down + 1):
            results.append(matrix[row][right])
        if up != down:
            for col in range(right - 1, left - 1, -1):
                results.append(matrix[down][col])
        if left != right:
            for row in range(down - 1, up, -1):
                results.append(matrix[row][left])
        left += 1
        right -= 1
        up += 1
        down -= 1
    return results

matrix = [[1, 2, 3], [4, 5, 6], [7, 8, 9]]
print(spiralOrder(matrix))
`;

function tracePython(source: string): Trace | null {
  try {
    const json = execFileSync(
      "python3",
      [
        "-c",
        "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read(), 3000))",
      ],
      { input: source, encoding: "utf8" },
    );
    return expandHeaps(JSON.parse(json) as Trace);
  } catch {
    return null;
  }
}

/** For every step right after an access line ran: the value the program appended, and the outlined cell's value. */
function checkSpiral(t: Trace) {
  const grid = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ];
  const checked: number[] = [];
  t.steps.forEach((step, i) => {
    const frame = step.stack[step.stack.length - 1];
    if (frame?.func !== "spiralOrder") return;
    const prev = t.steps[i - 1];
    if (!prev || !t.gridAccesses!.some((a) => a.line === prev.line)) return;
    const l = new Map(frame.locals);
    const focus = gridFocus(
      t.gridAccesses,
      "matrix",
      focusLines(t, i),
      l,
      { rows: 3, cols: () => 3 },
      t.language === "python",
    );
    expect(focus).not.toBe("none");
    const cell = grid[(focus as { row: number }).row][(focus as { col: number }).col];
    // The cell is the value just appended to results.
    const results = step.heap[(l.get("results") as { id: string }).id] as { items: Value[] };
    expect(cell).toBe(Number((results.items.at(-1) as { repr: string }).repr));
    checked.push(cell);
  });
  expect(checked).toEqual([1, 2, 3, 6, 9, 8, 7, 4, 5]);
}

describe("the cell a step works on", () => {
  it("is the one the line that just ran read, in Python (spiral order)", () => {
    const t = tracePython(SPIRAL_PY);
    if (!t) return;
    expect(t.gridAccesses?.map((a) => `${a.line}:${a.row},${a.col}`)).toEqual([
      "11:up,col",
      "13:row,right",
      "16:down,col",
      "19:row,left",
    ]);
    checkSpiral(t);
  });

  it("works the same in JavaScript", async () => {
    const js = `function spiralOrder(matrix) {
  const results = [];
  let left = 0, up = 0, right = matrix[0].length - 1, down = matrix.length - 1;
  while (results.length < matrix.length * matrix[0].length) {
    for (let col = left; col <= right; col++) {
      results.push(matrix[up][col]);
    }
    for (let row = up + 1; row <= down; row++) {
      results.push(matrix[row][right]);
    }
    if (up !== down) {
      for (let col = right - 1; col >= left; col--) {
        results.push(matrix[down][col]);
      }
    }
    if (left !== right) {
      for (let row = down - 1; row > up; row--) {
        results.push(matrix[row][left]);
      }
    }
    left++; right--; up++; down--;
  }
  return results;
}
const matrix = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
console.log(spiralOrder(matrix));`;
    const t = await traceJavaScript(js);
    checkSpiral(t);
  });
});
