// @vitest-environment jsdom
/**
 * The SVG memory renderer, drawing scenes (scene/memoryScene.ts): where the
 * scene's boxes go and what marks they get. What a scene holds is tested in
 * src/scene/; that every example's drawing matches its scene is in
 * layout.test.ts.
 */
import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { memoryScene, nodeKey } from "../scene/memoryScene";
import { diffSteps } from "../trace/diff";
import type { Trace } from "../trace/types";
import { renderMemory } from "./memory";

const sceneAt = (t: Trace, i: number, options = {}) =>
  memoryScene(t, i, diffSteps(t.steps[i - 1], t.steps[i]), options);
const keysOf = (svg: SVGSVGElement) => [...svg.querySelectorAll<SVGGElement>(".node")].map((g) => g.dataset.nodeKey);

describe("renderMemory", () => {
  it("draws a box per frame and object, and an arrow per link", async () => {
    const t = await traceJavaScript("const a = [1, 2];\nconst b = { list: a };\n");
    const scene = sceneAt(t, t.steps.length - 1);
    const svg = renderMemory(scene);
    expect(keysOf(svg).sort()).toEqual([...scene.frames.map((f) => f.key), ...scene.objects.map((o) => o.key)].sort());
    expect(svg.querySelectorAll(".ref-arrow")).toHaveLength(scene.links.length);
    expect(Number(svg.getAttribute("width"))).toBeGreaterThan(0);
  });

  it("puts a dragged box where the person left it, on top, and the one being dragged above all", async () => {
    const t = await traceJavaScript("const a = [1];\nconst b = [2];\n");
    const scene = sceneAt(t, t.steps.length - 1);
    const [first, second] = scene.objects.map((o) => o.key);
    const svg = renderMemory(scene, {
      positions: new Map([
        [first, { x: 500, y: 400 }],
        [second, { x: 520, y: 420 }],
      ]),
      raise: first,
    });
    const node = (key: string) => svg.querySelector<SVGGElement>(`.node[data-node-key="${key}"]`)!;
    expect([node(first).dataset.x, node(first).dataset.y]).toEqual(["500", "400"]);
    expect(node(first).classList.contains("is-moved")).toBe(true);
    expect(keysOf(svg).at(-1)).toBe(first); // raised over the other moved box
    expect(keysOf(svg).at(-2)).toBe(second);
  });

  it("shows what a step printed, and dims the rest as the scene says", async () => {
    const t = await traceJavaScript("const a = [1];\nconsole.log(a);\nlet b = 2;\n");
    const i = t.steps.findIndex((s) => s.output);
    const svg = renderMemory(sceneAt(t, i, { dimForOutput: true }));
    const card = svg.querySelector(`.node[data-node-key="${nodeKey.output}"]`)!;
    expect(card.classList.contains("is-output")).toBe(true);
    expect(svg.querySelector(".node.is-printed")).not.toBeNull();
    expect([...svg.classList]).toEqual(expect.arrayContaining(["has-output", "output-in"]));
    expect(svg.querySelectorAll(".print-arrow")).toHaveLength(1);
    const after = renderMemory(sceneAt(t, i + 1, { dimForOutput: true }));
    expect(after.classList.contains("output-out")).toBe(true);
    expect(after.querySelector(`.node[data-node-key="${nodeKey.output}"]`)).toBeNull();
  });

  it("draws a graph as one box", async () => {
    const t = await traceJavaScript('const g = { a: ["b"], b: ["c"], c: ["a"] };\n');
    const svg = renderMemory(sceneAt(t, t.steps.length - 1));
    expect(svg.querySelectorAll(".graph-box")).toHaveLength(1);
  });
});
