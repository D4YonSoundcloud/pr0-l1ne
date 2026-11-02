/**
 * WebGL in a real browser (render/canvas/canvasRenderers.ts, backend
 * "webgl"): it draws the same picture as Canvas 2D, step by step, on every
 * example (within what anti-aliasing changes); a lost context comes back
 * and draws the same again; and with no WebGL, it draws with Canvas 2D.
 *
 * Steps compared: a handful spread through each example. With
 * WEBGL_EVERY_STEP=1, every step of every example (slow: minutes):
 *
 *   WEBGL_EVERY_STEP=1 npx playwright test e2e/webgl.e2e.ts --project=chromium
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { pixelDifference } from "./pixels";

const EVERY_STEP = !!process.env.WEBGL_EVERY_STEP;
/** A pixel differs when a channel is this far off (anti-aliased edges and text differ a little between backends). */
const CHANNEL = 48;
/** At most this share of a window's pixels may differ. */
const MOST_DIFFERENT = 0.02;

test.skip(({ browserName }) => browserName !== "chromium", "WebGL is checked in Chromium");

async function open(browser: Browser, renderer: "canvas" | "webgl", init?: () => void): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript((r) => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
    localStorage.setItem("pr0l1ne:renderer", r);
    localStorage.setItem("pr0l1ne:loop-mode", "stacked");
  }, renderer);
  if (init) await page.addInitScript(init);
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await expect(page.locator("#memory")).toHaveAttribute("data-backend", /./);
  return page;
}

/** Open an example (by its place in the list) and wait for it to have run. */
async function openExample(page: Page, index: number): Promise<number> {
  // The new run is seen arriving when the step label changes (no two examples in a row read the same).
  const label = page.locator("#step-label");
  const before = await label.textContent();
  await page.locator("#programs").selectOption({ value: `example:${index}` });
  // The first example may be the program already open: then nothing changes.
  await expect(label)
    .not.toHaveText(before ?? "", { timeout: 8_000 })
    .catch(() => {});
  await expect(label).toContainText(" of ");
  await page.waitForTimeout(300);
  return Number(await page.locator("#scrubber").getAttribute("max"));
}

async function goTo(page: Page, step: number): Promise<void> {
  await page.locator("#scrubber").evaluate((el, n) => {
    const input = el as HTMLInputElement;
    input.value = String(n);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, step);
}

/** Both windows' canvases, once drawn and settled (text is drawn sharp after a pause). */
async function shots(page: Page): Promise<Buffer[]> {
  await page.waitForTimeout(350);
  return Promise.all(["#memory", "#loop"].map((w) => page.locator(`${w} canvas.viewport-canvas`).screenshot()));
}

/** The share of pixels that differ between two screenshots. */
async function difference(page: Page, a: Buffer, b: Buffer): Promise<number> {
  const { differ, total } = await pixelDifference(page, a, b, CHANNEL);
  return differ / total;
}

test("WebGL draws what Canvas 2D draws, step by step, on every example", async ({ browser }) => {
  test.setTimeout(EVERY_STEP ? 3_600_000 : 600_000);
  const canvas = await open(browser, "canvas");
  const webgl = await open(browser, "webgl");
  await expect(webgl.locator("#memory")).toHaveAttribute("data-backend", "webgl");
  const examples = await canvas.locator('#programs option[value^="example:"]').count();
  expect(examples).toBeGreaterThan(5);
  let compared = 0;
  let worst = { share: 0, where: "" };
  for (let e = 0; e < examples; e++) {
    const last = await openExample(canvas, e);
    expect(await openExample(webgl, e)).toBe(last);
    const steps = EVERY_STEP ? [...Array(last + 1).keys()] : [0, 1, 2, 3, 4].map((k) => Math.round((k * last) / 4));
    for (const step of new Set(steps)) {
      await Promise.all([goTo(canvas, step), goTo(webgl, step)]);
      const [a, b] = await Promise.all([shots(canvas), shots(webgl)]);
      for (let w = 0; w < 2; w++) {
        const share = await difference(canvas, a[w], b[w]);
        const where = `example ${e}, step ${step}, ${w ? "loop" : "memory"}`;
        if (share > worst.share) worst = { share, where };
        expect(share, where).toBeLessThan(MOST_DIFFERENT);
        compared++;
      }
    }
  }
  console.log(`compared ${compared} windows; most different: ${(worst.share * 100).toFixed(2)}% (${worst.where})`);
  await canvas.close();
  await webgl.close();
});

test("WebGL: a lost context comes back, and draws the same again", async ({ browser }) => {
  const page = await open(browser, "webgl");
  await page.locator("#step-label").click();
  await page.keyboard.press("End");
  const [before] = await shots(page);
  await page.evaluate(async () => {
    const canvas = document.querySelector<HTMLCanvasElement>("#memory canvas.viewport-canvas")!;
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl"))!;
    const lose = gl.getExtension("WEBGL_lose_context")!;
    lose.loseContext();
    await new Promise((r) => setTimeout(r, 200));
    lose.restoreContext();
  });
  await expect.poll(async () => difference(page, before, (await shots(page))[0])).toBeLessThan(MOST_DIFFERENT);
  await page.close();
});

test("WebGL: with no WebGL in the browser, it draws with Canvas 2D", async ({ browser }) => {
  const page = await open(browser, "webgl", () => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (type.startsWith("webgl") || type === "experimental-webgl") return null;
      return (real as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof real;
  });
  await expect(page.locator("#memory")).toHaveAttribute("data-backend", "canvas");
  await page.locator("#step-label").click();
  await page.keyboard.press("End");
  const [shot] = await shots(page);
  expect(shot.length).toBeGreaterThan(2000); // drawn on, not blank
  await page.close();
});
