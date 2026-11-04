/**
 * Graph clusters in real browsers (scene/graphClusters.ts): a graph of 100
 * node objects in four friend groups is drawn as four clusters; clicking
 * one shows its nodes, stepping keeps it open, and Reset layout clusters
 * it again. In both renderers (and on WebGL: e2e/renderer.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { rendererFor } from "./renderer";

const GROUPS = `class Person {
  constructor(id) { this.id = id; this.friends = []; }
}
// Four groups of 25 (a list holds at most 60 items in a step: each group is in a list of its own).
const groups = [];
for (let g = 0; g < 4; g++) {
  const group = [];
  for (let i = 0; i < 25; i++) group.push(new Person(g * 25 + i));
  for (const p of group)
    for (let k = 1; k <= 3; k++) {
      const q = group[(p.id % 25 + k) % 25];
      if (!p.friends.includes(q)) { p.friends.push(q); q.friends.push(p); }
    }
  groups.push(group);
}
let done = 1;
let still = 2;
`;

async function open(page: Page, renderer: "svg" | "canvas") {
  await page.addInitScript(
    ([code, r]) => {
      if (sessionStorage.getItem("set")) return;
      sessionStorage.setItem("set", "1");
      localStorage.clear();
      localStorage.setItem("pr0l1ne:code:javascript", code);
      localStorage.setItem("pr0l1ne:renderer", r);
    },
    [GROUPS, rendererFor(renderer)],
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#step-label").click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  // Auto-fit zooms, then the step is laid out for that zoom once it settles.
  await page.waitForTimeout(800);
}

const reset = (page: Page) => page.locator("#memory .viewport-controls button", { hasText: "Reset layout" });

test("svg: a big graph is drawn as clusters; clicking one shows its nodes; Reset layout clusters it again", async ({
  page,
}) => {
  await open(page, "svg");
  const memory = page.locator("#memory");
  const clusters = memory.locator(".viewport-layer .graph-cluster");
  await expect(clusters).toHaveCount(4);
  await expect(clusters.first().locator(".node-text")).toHaveText("25 nodes");
  await expect(memory.locator(".viewport-layer .box-title", { hasText: "100 nodes in 4 clusters" })).toHaveCount(1);
  await expect(reset(page)).toBeHidden();

  const box = (await clusters.first().locator(".node-body").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(clusters).toHaveCount(3);
  await expect(memory.locator(".viewport-layer .graph-node:not(.graph-cluster)")).toHaveCount(25);
  await expect(reset(page)).toBeVisible();

  // Stepping keeps it open.
  await page.locator("#step-label").click();
  await page.keyboard.press("ArrowRight");
  await expect(clusters).toHaveCount(3);

  await reset(page).click();
  await expect(clusters).toHaveCount(4);
  await expect(reset(page)).toBeHidden();
});

test("canvas: clicking a cluster opens it too", async ({ browser }) => {
  // Both renderers draw the same layout, fitted the same: where the cluster is, measured in SVG.
  const svgPage = await browser.newPage();
  await open(svgPage, "svg");
  const box = (await svgPage.locator("#memory .viewport-layer .graph-cluster .node-body").first().boundingBox())!;
  await svgPage.close();

  const page = await browser.newPage();
  await open(page, "canvas");
  await expect(reset(page)).toBeHidden();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // Opened: Reset layout is offered, and the box's title still counts the whole graph.
  await expect(reset(page)).toBeVisible();
  await page.close();
});
