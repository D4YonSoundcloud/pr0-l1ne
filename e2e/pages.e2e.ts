/**
 * Each language's page and the window layout, in real browsers: pr0l1ne.com
 * opens the language used last at its own address (src/site/pages.ts,
 * app/routing.ts), each page is served with its own title and description,
 * and the windows go side by side, fold to bars and open again
 * (app/layout.ts).
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
  });
});

test("each language's page is served with its own title, description and address", async ({ request }) => {
  for (const [path, title] of [
    ["/python", "Python Visualizer"],
    ["/sql", "SQL Visualizer"],
    ["/typescript", "TypeScript Visualizer"],
  ]) {
    const html = await (await request.get(path)).text();
    expect(html).toContain(`<title>${title}`);
    expect(html).toContain(`<link rel="canonical" href="https://pr0l1ne.com${path}" />`);
    expect(html).toContain("Free, no sign-up, runs in your own browser.");
  }
  expect(await (await request.get("/sitemap.xml")).text()).toContain("<loc>https://pr0l1ne.com/sql</loc>");
});

test("the home page opens the language used last, at its own address; Back switches back", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/javascript$/);
  await page.locator("#language").selectOption("typescript");
  await expect(page).toHaveURL(/\/typescript$/);
  await expect(page).toHaveTitle(/^TypeScript Visualizer/);
  await page.goBack();
  await expect(page.locator("#language")).toHaveValue("javascript");
  await page.goto("/");
  await expect(page).toHaveURL(/\/javascript$/);
  await page.goto("/typescript");
  await page.goto("/");
  await expect(page).toHaveURL(/\/typescript$/);
});

test("the windows go side by side, and fold to bars that open them again", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;

  await page.locator("#layout-mode").click();
  const [memory, loop] = [await box("#memory-section"), await box("#loop-section")];
  expect(Math.round(memory.y)).toBe(Math.round(loop.y)); // side by side
  expect(loop.x).toBeGreaterThan(memory.x + memory.width - 1);

  await page.locator('#memory-section [data-action="maximize"]').click();
  await expect(page.locator("#editor-pane")).toHaveClass(/is-collapsed/);
  await expect(page.locator("#loop-section")).toHaveClass(/is-collapsed/);
  expect((await box("#memory-section")).width).toBeGreaterThan(1200);
  expect((await box("#editor-pane")).width).toBeLessThan(40);

  await page.locator("#editor-pane .window-bar").click();
  await expect(page.locator("#editor-pane")).not.toHaveClass(/is-collapsed/);
  await expect(page.locator("#editor .view-lines")).toBeVisible();

  // Remembered on the next visit.
  await page.reload();
  await expect(page.locator("#loop-section")).toHaveClass(/is-collapsed/);
  await expect(page.locator("#layout-mode")).toHaveAttribute("aria-pressed", "true");
});
