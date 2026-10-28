import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import type { Trace } from "../trace/types";
import { type ArrowColorMode, type ArrowStart, arrowColoring } from "./arrowColors";

const code = `class Node { constructor(v, next = null) { this.v = v; this.next = next; } }
let a = new Node(1, new Node(2));
let b = new Node(3);
let c = b;
c = null;`;

const start = (over: Partial<ArrowStart>): ArrowStart => ({
  variable: null,
  owner: null,
  depth: 0,
  target: "",
  changed: false,
  kind: "ref",
  ...over,
});
const refOf = (t: Trace, i: number, name: string) => {
  const v = t.steps[i].stack[0].locals.find(([n]) => n === name)?.[1];
  return v?.kind === "ref" ? v.id : "";
};

describe("arrow colors that follow the program", () => {
  it("by variable: one color each for the run, shared by everything it reaches", async () => {
    const t = await traceJavaScript(code);
    const i = t.steps.length - 2; // c still points at b's node
    const color = (mode: ArrowColorMode) => arrowColoring(t, i, mode);
    const coloring = color("variable");
    const node1 = refOf(t, i, "a");
    const step = t.steps[i];
    const node1Obj = step.heap[node1];
    const next = node1Obj.kind === "object" ? node1Obj.fields.find(([n]) => n === "next")![1] : null;
    const fromA = coloring.paint(start({ variable: { func: "Global", name: "a" }, target: node1 }));
    const fromNode1 = coloring.paint(start({ owner: node1, target: next?.kind === "ref" ? next.id : "", depth: 1 }));
    const fromB = coloring.paint(start({ variable: { func: "Global", name: "b" }, target: refOf(t, i, "b") }));
    expect(fromA.group).toBeDefined();
    expect(fromNode1.group).toBe(fromA.group);
    expect(fromB.group).not.toBe(fromA.group);
    // The same colors on another step.
    const later = arrowColoring(t, t.steps.length - 1, "variable");
    expect(later.paint(start({ variable: { func: "Global", name: "b" }, target: refOf(t, i, "b") })).group).toBe(
      fromB.group,
    );
    expect(coloring.legend().map((e) => e.label)).toEqual(["a", "b"]);
    expect(coloring.paint(start({ variable: { func: "Global", name: "nope" } }))).toEqual({ plain: true });
  });

  it("same object: variables pointing at one object share a color, the rest fade", async () => {
    const t = await traceJavaScript(code);
    const i = t.steps.findIndex((s) => s.stack[0].locals.some(([n, v]) => n === "c" && v.kind === "ref"));
    const coloring = arrowColoring(t, i, "alias");
    const node = refOf(t, i, "b");
    const b = coloring.paint(start({ variable: { func: "Global", name: "b" }, target: node }));
    const c = coloring.paint(start({ variable: { func: "Global", name: "c" }, target: node }));
    expect(b).toEqual(c);
    expect(b.bright).toBe(true);
    expect(coloring.paint(start({ variable: { func: "Global", name: "a" }, target: refOf(t, i, "a") }))).toEqual({
      faded: true,
      plain: true,
    });
    expect(coloring.legend()[0].label).toBe("b, c → one Node");
    const none = arrowColoring(t, t.steps.length - 1, "alias");
    none.paint(start({ target: refOf(t, t.steps.length - 1, "a") }));
    expect(none.legend()[0].label).toBe("no two variables point at one object now");
  });

  it("by distance and by change", async () => {
    const t = await traceJavaScript(code);
    const distance = arrowColoring(t, 3, "distance");
    expect(distance.paint(start({ depth: 0 })).dist).toBe(0);
    expect(distance.paint(start({ depth: 9 })).dist).toBe(5);
    expect(distance.legend().map((e) => e.label)).toEqual(["from a variable", "5 or more steps away"]);
    const change = arrowColoring(t, 3, "change");
    expect(change.paint(start({ changed: true }))).toEqual({ bright: true });
    expect(change.paint(start({ changed: false }))).toEqual({ faded: true });
    expect(arrowColoring(t, 3, "kind").paint(start({}))).toEqual({});
    expect(arrowColoring(t, 3, "kind").legend()).toEqual([]);
  });
});
