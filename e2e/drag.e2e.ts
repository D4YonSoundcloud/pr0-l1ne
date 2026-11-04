/**
 * Dragging a box (render/memory.ts nudgeBox): the layout is done in the
 * layout worker, so while the pointer moves the box is moved on the page
 * at once, and the worker's layout (with its arrows) follows. It must stay
 * where it was dropped, and Reset layout put it back.
 */
import { expect, test } from "@playwright/test";

const CODE = "const nums = [3, 1, 2];\nconst copy = nums;\nlet total = 0;\n";

test("a dragged box follows the pointer at once, stays where it's dropped, and Reset layout puts it back", async ({
  page,
}) => {
  await page.addInitScript((code) => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
    localStorage.setItem("pr0l1ne:code:javascript", code);
  }, CODE);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#mode-arrows").click();
  const frame = page.locator('#memory .node[data-node-key^="frame:"]').first();
  await expect(frame).toBeVisible();
  await page.waitForTimeout(500);
  const start = (await frame.boundingBox())!;
  const laidX = Number(await frame.getAttribute("data-x"));

  await page.mouse.move(start.x + 20, start.y + 8);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(start.x + 20 + i * 15, start.y + 8 + i * 10);
  // Still held: the box has moved with the pointer already.
  await expect.poll(async () => (await frame.boundingBox())!.x - start.x).toBeGreaterThan(100);
  await page.mouse.up();

  // The layout for where it was dropped: laid out there, and kept there as you step.
  await expect.poll(async () => Number(await frame.getAttribute("data-x")) - laidX).toBeGreaterThan(80);
  await expect(page.locator("#memory .viewport-controls button", { hasText: "Reset layout" })).toBeVisible();
  await page.locator("#step-label").click();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await frame.getAttribute("data-x")) - laidX).toBeGreaterThan(80);

  await page.locator("#memory .viewport-controls button", { hasText: "Reset layout" }).click();
  await expect.poll(async () => Number(await frame.getAttribute("data-x"))).toBe(laidX);
});
