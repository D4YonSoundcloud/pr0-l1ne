/**
 * Zooming far out, in real browsers: the memory window zooms down to 1%,
 * drawing less at each level of detail (render/lod.ts), keeps the names of
 * the call stack and the big structures readable (landmarks), and
 * double-clicking a box too small to read zooms in on it. Dragging a
 * divider doesn't redraw the diagram on every move (app/resizeRedraw.ts).
 */
import { expect, type Page, test } from "@playwright/test";
import { inked } from "./pixels";
import { rendererFor } from "./renderer";

const CODE = `function build(n) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: i, name: "item " + i, next: null });
  for (let i = 0; i + 1 < n; i++) items[i].next = items[i + 1];
  return items;
}
const items = build(40);
let total = 0;
for (const item of items) total += item.id;
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
    [CODE, rendererFor(renderer)],
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript?perf");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
}

/** Zoom the memory window with its keys: "0" is 100%, each "-" a step out. */
async function zoomOut(page: Page, presses: number) {
  const memory = page.locator("#memory");
  await memory.focus();
  await page.keyboard.press("0");
  for (let i = 0; i < presses; i++) await page.keyboard.press("-");
}

const zoomLabel = (page: Page) => page.locator("#memory .zoom-label");

for (const renderer of ["svg", "canvas"] as const) {
  test(`${renderer}: the memory window zooms out to 1%, simpler at each level, with landmarks`, async ({ page }) => {
    await open(page, renderer);
    const memory = page.locator("#memory");
    await zoomOut(page, 0);
    await expect(memory).toHaveAttribute("data-lod", "0");
    await expect(zoomLabel(page)).toHaveText("100%");

    await zoomOut(page, 3); // 51%: reduced
    await expect(memory).toHaveAttribute("data-lod", "1");
    await zoomOut(page, 7); // 21%: blocks
    await expect(memory).toHaveAttribute("data-lod", "2");
    await zoomOut(page, 13); // 5.5%: outline, with landmarks
    await expect(memory).toHaveAttribute("data-lod", "3");
    await expect(memory.locator(".viewport-landmarks")).toBeVisible();
    await expect(memory.locator(".landmark").first()).toBeVisible();

    await zoomOut(page, 30); // as far as it goes
    await expect(zoomLabel(page)).toHaveText("1%");
    await expect(memory).toHaveAttribute("data-lod", "4");

    if (renderer === "svg") {
      // What a level hides isn't in the page at all.
      await expect(memory.locator(".viewport-layer svg text")).toHaveCount(0);
      await expect(memory.locator(".viewport-layer .node-outline").first()).toBeAttached();
    }

    // And back: everything again.
    await zoomOut(page, 0);
    await expect(memory).toHaveAttribute("data-lod", "0");
    await expect(memory.locator(".viewport-landmarks")).toBeHidden();
    // Built with less detail while zoomed out, the step is laid out again once the zoom settles.
    await expect(memory).toHaveAttribute("data-built-lod", "0");
    if (renderer === "svg")
      await expect.poll(() => memory.locator(".viewport-layer svg text").count()).toBeGreaterThan(0);
  });

  test(`${renderer}: zoomed out, a step is built without what the level hides; zoomed in, in full again`, async ({
    page,
  }) => {
    await open(page, renderer);
    const memory = page.locator("#memory");
    await zoomOut(page, 7); // 21%: blocks
    await expect(memory).toHaveAttribute("data-lod", "2");
    await page.keyboard.press("ArrowRight"); // a step drawn at blocks
    await expect(memory).toHaveAttribute("data-built-lod", "2");
    await zoomOut(page, 3); // 51%: reduced, more than it was built with
    await expect(memory).toHaveAttribute("data-built-lod", "1");
    await zoomOut(page, 0);
    await expect(memory).toHaveAttribute("data-built-lod", "0");
    if (renderer === "svg")
      await expect.poll(() => memory.locator(".viewport-layer svg text").count()).toBeGreaterThan(0);
  });
}

/** The most bends any arrow in the memory window has (a rounded corner is a Q in its path). */
const mostBends = (page: Page) =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll("#memory .viewport-layer .arrows > .ref-arrow")].map(
        (p) => (p.getAttribute("d") ?? "").split("Q").length - 1,
      ),
    ),
  );

test("zoomed out to outline, arrows are laid out straight or with one bend; zoomed back, routed again", async ({
  page,
}) => {
  await open(page, "svg");
  const memory = page.locator("#memory");
  await zoomOut(page, 0);
  await expect.poll(() => mostBends(page)).toBeGreaterThan(1);
  await zoomOut(page, 13); // 5.5%: outline
  await expect(memory).toHaveAttribute("data-lod", "3");
  await expect.poll(() => mostBends(page)).toBeLessThanOrEqual(1);
  await zoomOut(page, 0);
  await expect.poll(() => mostBends(page)).toBeGreaterThan(1);
});

test("canvas: back at a level after another, then a window resized, the level is still drawn", async ({ page }) => {
  await open(page, "canvas");
  const memory = page.locator("#memory");
  await zoomOut(page, 7); // 21%: blocks
  await expect(memory).toHaveAttribute("data-lod", "2");
  await page.waitForTimeout(400);
  const before = await inked(page, "#memory");
  expect(before).toBeGreaterThan(1000);
  await zoomOut(page, 0); // full
  await expect(memory).toHaveAttribute("data-lod", "0");
  await zoomOut(page, 7); // blocks again: the probe kept for it is used again
  await expect(memory).toHaveAttribute("data-lod", "2");
  // Resizing the windows changes the page's inline styles: the canvas reads its styles afresh.
  const divider = (await page.locator("#divider").boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 200);
  await page.mouse.down();
  await page.mouse.move(divider.x - 40, divider.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("ArrowLeft"); // a step drawn with them
  await page.waitForTimeout(600);
  await expect(memory).toHaveAttribute("data-lod", "2");
  expect(await inked(page, "#memory")).toBeGreaterThan(before / 3);
});

test("double-clicking a box too small to read zooms in on it", async ({ page }) => {
  await open(page, "svg");
  const memory = page.locator("#memory");
  await zoomOut(page, 13);
  await expect(memory).toHaveAttribute("data-lod", "3");
  // Laid out again for that level (simple arrows, built without text) before anything is measured or hovered.
  await expect(memory).toHaveAttribute("data-built-lod", "3");
  await page.waitForTimeout(800); // the zoom glides there: measure where it ends

  const box = (await memory.locator('.viewport-layer .node[data-node-key^="obj:"] .node-hit').first().boundingBox())!;
  await memory.hover({ position: { x: 1, y: 1 } });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(memory.locator(".viewport-tip")).toContainText("double-click to zoom in");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

  await expect.poll(async () => Number.parseFloat((await zoomLabel(page).textContent()) ?? "")).toBe(100); // one object fits at 100%
  await expect(memory).toHaveAttribute("data-lod", "0");
});

test("dragging the divider between the windows doesn't redraw the diagram on every move", async ({ page }) => {
  await open(page, "svg");
  await page.evaluate(() => (window as unknown as { __pr0l1nePerf: { reset(): void } }).__pr0l1nePerf.reset());
  const divider = (await page.locator("#canvas-divider").boundingBox())!;
  const x = divider.x + divider.width / 2;
  const y = divider.y + divider.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(x, y - i * 4);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const layouts = await page.evaluate(
    () =>
      (window as unknown as { __pr0l1nePerf: { summary(): Record<string, { n: number }> } }).__pr0l1nePerf.summary()[
        "memory.layout"
      ]?.n ?? 0,
  );
  // At most a redraw or two for the new shape, not one per move.
  expect(layouts).toBeLessThanOrEqual(2);
});

test("zoomed in on a long loop history, only the rows in view are drawn, and scrolling draws the others", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
    localStorage.setItem("pr0l1ne:code:javascript", "const a = [];\nfor (let i = 0; i < 80; i++) a.push(i % 7);\n");
    localStorage.setItem("pr0l1ne:renderer", "svg");
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#step-label").click();
  await page.keyboard.press("End"); // the last step: every pass in the history
  await page.locator("#loop-stacked").click(); // a row per pass
  const loop = page.locator("#loop");
  const rows = loop.locator(".viewport-layer .loop-row");
  // Auto-fit on: the whole history is in view, so every row is drawn.
  await expect.poll(() => rows.count()).toBeGreaterThan(50);
  await loop.focus();
  await page.keyboard.press("0"); // 100%, Auto-fit off: the top of the history
  await expect.poll(() => rows.count()).toBeLessThan(30);
  const first = await rows.first().getAttribute("data-top");
  // Scroll down to the bottom: the rows there are drawn.
  const box = (await loop.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 400);
  await expect
    .poll(async () => Number(await rows.last().getAttribute("data-top")))
    .toBeGreaterThan(Number(first) + 2000);
  await expect.poll(() => rows.count()).toBeLessThan(30);
});
