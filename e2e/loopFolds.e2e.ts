/**
 * Folds in the loop history, in real browsers (scene/loopSummaries.ts):
 * zoomed out, a long history folds the passes far from the running one
 * into a band; clicking it shows them, and Fold again folds them again.
 * Zoomed back in, where the budget allows them all, they're all drawn. In
 * both renderers.
 */
import { expect, type Page, test } from "@playwright/test";
import { rendererFor } from "./renderer";

// 41 rows of a 30 × 30 grid: under the budget at full detail, over it from blocks (21%) on.
const CODE = `const g = [];
for (let i = 0; i < 30; i++) g.push(new Array(30).fill(0));
for (let k = 0; k < 40; k++) {
  g[k % 30][k % 7] = k;
}
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
      localStorage.setItem("pr0l1ne:loop-mode", "stacked");
    },
    [CODE, rendererFor(renderer)],
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#step-label").click();
  await page.keyboard.press("End");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft"); // in the second loop's last pass
  const loop = page.locator("#loop");
  // That step drawn (it brings the running row into view) before zooming, so both pages start alike.
  await expect(loop).toHaveAttribute("data-drawing", "done", { timeout: 10_000 });
  await loop.focus();
  await page.keyboard.press("0"); // 100%, Auto-fit off
  for (let i = 0; i < 7; i++) await page.keyboard.press("-"); // 21%: blocks
  await expect(loop).toHaveAttribute("data-lod", "2");
  // The step is folded for that zoom once it settles: laid out again in the layout worker, then drawn.
  await expect(loop).toHaveAttribute("data-built-lod", "2", { timeout: 10_000 });
  await page.waitForTimeout(300);
  await expect(loop).toHaveAttribute("data-drawing", "done", { timeout: 10_000 });
}

/**
 * Scroll the loop window until the fold's band is in it (the window keeps
 * the running row, at the bottom, in view). Returns where it is, and the
 * scrolls it took, to scroll another page the same way.
 */
async function scrollToBand(page: Page, selector: string) {
  const loop = (await page.locator("#loop").boundingBox())!;
  await page.mouse.move(loop.x + loop.width / 2, loop.y + loop.height / 2);
  const scrolls: number[] = [];
  for (let i = 0; i < 300; i++) {
    const box = await page.locator(selector).boundingBox();
    if (box && box.y > loop.y + 40 && box.y + box.height < loop.y + loop.height - 40) return { box, scrolls };
    const dy = box && box.y > loop.y + loop.height / 2 ? 80 : -80;
    scrolls.push(dy);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(10);
  }
  throw new Error("the band never came into view");
}

async function scrollBy(page: Page, scrolls: number[]) {
  const loop = (await page.locator("#loop").boundingBox())!;
  await page.mouse.move(loop.x + loop.width / 2, loop.y + loop.height / 2);
  for (const dy of scrolls) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  // The rows now in view, laid out in the layout worker, drawn.
  await expect(page.locator("#loop")).toHaveAttribute("data-drawing", "done", { timeout: 10_000 });
}

/** Where the band is on a canvas, near `y`: the point whose tooltip names it. */
async function bandByTip(page: Page, x: number, y: number): Promise<number> {
  const tip = page.locator("#loop .viewport-tip");
  for (let d = 0; d <= 80; d += 2) {
    for (const at of d ? [y - d, y + d] : [y]) {
      await page.mouse.move(x, at);
      if (/passes folded/.test((await tip.textContent().catch(() => "")) ?? "")) return at;
    }
  }
  throw new Error("no band near there");
}

const foldAgain = (page: Page) => page.locator("#loop .viewport-controls button", { hasText: "Fold again" });

test("svg: zoomed out, far passes fold; clicking the band shows them; Fold again folds them; zoomed in, all are drawn", async ({
  page,
}) => {
  await open(page, "svg");
  const loop = page.locator("#loop");
  const band = loop.locator(".viewport-layer .fold-band");
  await expect(band).toHaveCount(1);
  await expect(band).toHaveAttribute("data-title", /passes folded/);
  await expect(foldAgain(page)).toBeHidden();

  const { box } = await scrollToBand(page, "#loop .viewport-layer .fold-band .fold-hit");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(band).toHaveCount(0);
  await expect(foldAgain(page)).toBeVisible();

  await foldAgain(page).click();
  await expect(band).toHaveCount(1);
  await expect(foldAgain(page)).toBeHidden();

  await loop.focus();
  await page.keyboard.press("0"); // full detail: the budget takes every row
  await expect.poll(() => band.count()).toBe(0);
});

test("canvas: clicking a fold opens it too", async ({ browser }) => {
  // Both renderers draw the same layout at the same zoom: where the band is, measured in SVG.
  const svgPage = await browser.newPage();
  await open(svgPage, "svg");
  const { box, scrolls } = await scrollToBand(svgPage, "#loop .viewport-layer .fold-band .fold-hit");
  await svgPage.close();

  const page = await browser.newPage();
  await open(page, "canvas");
  await expect(foldAgain(page)).toBeHidden();
  await scrollBy(page, scrolls);
  // Scrolling lands within a few pixels of where it did in SVG: find the band by its tooltip, down the same line.
  const y = await bandByTip(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, y);
  await expect(foldAgain(page)).toBeVisible();
  await page.close();
});
