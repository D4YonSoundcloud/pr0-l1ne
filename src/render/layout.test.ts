// @vitest-environment jsdom
/**
 * Renders every example program at every step and checks the memory view's
 * layout: no box ever overlaps another, and no arrow passes through a box
 * it doesn't start or end at.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES, TYPESCRIPT_EXAMPLES, type Example } from "../examples";
import { traceJavaScript } from "../js/trace";
import { traceTypeScript } from "../js/typescript";
import { diffSteps } from "../trace/diff";
import type { Trace } from "../trace/types";
import { renderMemory, type MemoryMode, type Point } from "./memory";
import { crosses, overlaps, type Rect } from "./route";

function tracePython(source: string): Trace | null {
  try {
    const json = execFileSync("python3", ["-c",
      "import sys; sys.path.insert(0, 'src/worker'); from tracer import run_trace; print(run_trace(sys.stdin.read(), 3000))"],
    { input: source, encoding: "utf8" });
    return JSON.parse(json) as Trace;
  } catch {
    return null; // Python not installed: those cases are skipped
  }
}

interface Drawn {
  boxes: Map<string, Rect>;
  arrows: { from: string; to: string; points: Point[] }[];
}

/** Read box rectangles and arrow polylines back out of the rendered SVG. */
function read(svg: SVGSVGElement): Drawn {
  const boxes = new Map<string, Rect>();
  for (const g of svg.querySelectorAll<SVGGElement>(".node")) {
    const hit = g.querySelector(".node-hit")!;
    boxes.set(g.dataset.nodeKey!, {
      x: Number(g.dataset.x), y: Number(g.dataset.y),
      w: Number(hit.getAttribute("width")) - 4, h: Number(hit.getAttribute("height")) - 4,
    });
  }
  const arrows = [...svg.querySelectorAll<SVGPathElement>(".ref-arrow")].map((path) => {
    // M start, a Q per corner (its control point is the corner), L end.
    const d = path.getAttribute("d")!;
    const nums = (text: string) => text.split(/[ ,]+/).filter(Boolean).map(Number);
    const points: Point[] = [];
    const start = nums(d.match(/^M([^LQ]+)/)![1]);
    points.push({ x: start[0], y: start[1] });
    for (const m of d.matchAll(/Q([\d.-]+),([\d.-]+)/g)) points.push({ x: Number(m[1]), y: Number(m[2]) });
    const end = nums(d.match(/L([^LQ]+)$/)![1]);
    points.push({ x: end[0], y: end[1] });
    return { from: path.dataset.from!, to: path.dataset.to!, points };
  });
  return { boxes, arrows };
}

type Tracer = (code: string) => Trace | null | Promise<Trace | null>;
const programs: [string, Example, Tracer][] = [
  ...PYTHON_EXAMPLES.map((e) => ["python", e, tracePython] as [string, Example, Tracer]),
  ...JAVASCRIPT_EXAMPLES.map((e) => ["javascript", e, (c: string) => traceJavaScript(c, 3000)] as [string, Example, Tracer]),
  ...TYPESCRIPT_EXAMPLES.map((e) => ["typescript", e, (c: string) => traceTypeScript(c, 3000)] as [string, Example, Tracer]),
];

describe.each(programs)("%s: %s", (_language, example, trace) => {
  it.each<MemoryMode>(["arrows", "nested"])("%s mode: no overlapping boxes, no arrows through boxes", async (mode) => {
    const t = await trace(example.code);
    if (!t) return;
    expect(t.error).toBeNull();
    for (let i = 0; i < t.steps.length; i++) {
      const { boxes, arrows } = read(renderMemory(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { positions: new Map(), mode }));
      const list = [...boxes];
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          if (overlaps(list[a][1], list[b][1])) throw new Error(`step ${i + 1}: ${list[a][0]} overlaps ${list[b][0]}`);
        }
      }
      for (const arrow of arrows) {
        for (let k = 1; k < arrow.points.length; k++) {
          const [p, q] = [arrow.points[k - 1], arrow.points[k]];
          for (const [key, rect] of boxes) {
            if (key === arrow.from && k === 1) continue; // leaving its own box
            if (crosses(p, q, rect)) throw new Error(`step ${i + 1}: arrow ${arrow.from} -> ${arrow.to} crosses ${key}`);
          }
        }
      }
    }
  });
});

describe("dragged boxes", () => {
  it("never hide a box that's placed automatically", async () => {
    const code = JAVASCRIPT_EXAMPLES.find((e) => e.name === "Reverse a linked list")!.code;
    const t = await traceJavaScript(code, 3000);
    const last = t.steps.length - 1;
    const auto = read(renderMemory(t, last, diffSteps(t.steps[last - 1], t.steps[last])));
    // Drop the Global frame exactly on top of every other box in turn.
    for (const [key, rect] of auto.boxes) {
      if (key.startsWith("frame:")) continue;
      const positions = new Map([["frame:0:Global", { x: rect.x, y: rect.y }]]);
      for (let i = 0; i < t.steps.length; i++) {
        const { boxes } = read(renderMemory(t, i, diffSteps(t.steps[i - 1], t.steps[i]), { positions }));
        const moved = boxes.get("frame:0:Global")!;
        for (const [other, r] of boxes) {
          if (other !== "frame:0:Global" && overlaps(moved, r)) throw new Error(`step ${i + 1}: ${other} is under the dragged frame`);
        }
      }
    }
  });
});
