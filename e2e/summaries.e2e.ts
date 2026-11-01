/**
 * Summaries in real browsers (scene/summaries.ts): a long list is drawn as
 * its first and last nodes and a summary between; clicking the summary
 * shows every node, and Reset layout summarizes it again. In both renderers.
 */
import { expect, type Page, test } from "@playwright/test";

const LIST = `class Node { constructor(val, next) { this.val = val; this.next = next; } }
let head = null;
for (let i = 150; i > 0; i--) head = new Node(i, head);
let done = 1;
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
    [LIST, renderer],
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#step-label").click();
  await page.keyboard.press("End");
  // Arrows mode: each node a box.
  await page.locator("#mode-arrows").click();
  // Auto-fit zooms out, then the step is laid out for that zoom once it settles.
  await page.waitForTimeout(800);
}

const reset = (page: Page) => page.locator("#memory .viewport-controls button", { hasText: "Reset layout" });

test("svg: a long list is summarized; clicking the summary shows every node; Reset layout folds it again", async ({
  page,
}) => {
  await open(page, "svg");
  const memory = page.locator("#memory");
  const summary = memory.locator(".viewport-layer .node.is-summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveAttribute("data-title", /more Node/);
  const nodes = memory.locator('.viewport-layer .node[data-node-key^="obj:"]');
  const before = await nodes.count();
  expect(before).toBeLessThan(80);
  await expect(reset(page)).toBeHidden();

  const box = (await summary.locator(".node-hit").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(summary).toHaveCount(0);
  await expect.poll(() => nodes.count()).toBeGreaterThanOrEqual(150);
  await expect(reset(page)).toBeVisible();

  // Stepping keeps it open.
  await page.locator("#step-label").click();
  await page.keyboard.press("ArrowLeft");
  await expect(summary).toHaveCount(0);

  await reset(page).click();
  await expect(summary).toHaveCount(1);
  await expect(reset(page)).toBeHidden();
});

test("canvas: clicking a summary opens it too", async ({ browser }) => {
  // Both renderers draw the same layout, fitted the same: where the summary is, measured in SVG.
  const svgPage = await browser.newPage();
  await open(svgPage, "svg");
  const box = (await svgPage.locator("#memory .viewport-layer .node.is-summary .node-hit").boundingBox())!;
  await svgPage.close();

  const page = await browser.newPage();
  await open(page, "canvas");
  await expect(reset(page)).toBeHidden();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#memory .viewport-tip")).toContainText("more Node");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(reset(page)).toBeVisible();
  await page.close();
});

test("zoomed out by hand, long runs are summarized sooner; zoomed back in, they're drawn again", async ({ page }) => {
  await open(page, "svg");
  const memory = page.locator("#memory");
  const nodes = memory.locator('.viewport-layer .node[data-node-key^="obj:"]');
  await memory.focus();
  await page.keyboard.press("0"); // 100%, Auto-fit off: full detail
  await page.waitForTimeout(500);
  const full = await nodes.count();
  for (let i = 0; i < 14; i++) await page.keyboard.press("-"); // 4.4%: outline
  await expect(memory).toHaveAttribute("data-lod", "3");
  await expect.poll(() => nodes.count()).toBeLessThan(full / 2);
  await page.keyboard.press("0");
  await expect.poll(() => nodes.count()).toBe(full);
});
