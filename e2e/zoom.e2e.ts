/**
 * Zooming far out, in real browsers: the memory window zooms down to 1%,
 * drawing less at each level of detail (render/lod.ts), keeps the names of
 * the call stack and the big structures readable (landmarks), and
 * double-clicking a box too small to read zooms in on it. Dragging a
 * divider doesn't redraw the diagram on every move (app/resizeRedraw.ts).
 */
import { expect, type Page, test } from "@playwright/test";

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
    [CODE, renderer],
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
    if (renderer === "svg") expect(await memory.locator(".viewport-layer svg text").count()).toBeGreaterThan(0);
  });
}

test("double-clicking a box too small to read zooms in on it", async ({ page }) => {
  await open(page, "svg");
  const memory = page.locator("#memory");
  await zoomOut(page, 13);
  await expect(memory).toHaveAttribute("data-lod", "3");
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
