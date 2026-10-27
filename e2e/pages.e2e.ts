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

test("a window dragged by its header moves where the preview shows, and stays there", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const grip = await box("#memory-section .window-grip");
  const code = await box("#editor-pane");

  // Memory to the left of the code.
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 40, grip.y + 40, { steps: 4 });
  await page.mouse.move(code.x + code.width * 0.12, code.y + code.height / 2, { steps: 10 });
  const preview = page.locator(".dock-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveText("left of Code");
  await expect(preview).toHaveClass(/is-target/);
  await page.waitForTimeout(300); // it glides there
  const shown = (await preview.boundingBox())!;
  await page.mouse.up();
  await expect(preview).toBeHidden();

  await page.waitForTimeout(400); // the windows glide too
  const [memory, editor, loop] = [await box("#memory-section"), await box("#editor-pane"), await box("#loop-section")];
  expect(memory.x).toBeLessThan(editor.x);
  expect(editor.x).toBeLessThan(loop.x);
  // Where the preview said, give or take the dividers.
  expect(Math.abs(memory.x - shown.x)).toBeLessThan(8);
  expect(Math.abs(memory.width - shown.width)).toBeLessThan(8);

  // Remembered on the next visit, and the code still works.
  await page.reload();
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  expect((await box("#memory-section")).x).toBeLessThan((await box("#editor-pane")).x);
  await expect(page.locator("#editor .view-lines")).toBeVisible();
});

test("window headers stay one row, and the zoom controls fold away and stay folded", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  const heights = async () =>
    Promise.all(
      ["#memory-section", "#loop-section"].map(
        // Rounded: Firefox reports sub-pixel heights (38.0000076) that differ
        // between layouts by a few millionths of a pixel.
        async (s) => Math.round((await page.locator(`${s} .section-head`).boundingBox())!.height),
      ),
    );
  const before = await heights();
  await page.locator("#layout-mode").click();
  expect(await heights()).toEqual(before);
  expect(before[0]).toBeLessThan(45);

  await page.locator("#memory .controls-toggle").click();
  await expect(page.locator("#memory .viewport-controls")).toHaveClass(/is-collapsed/);
  await page.reload();
  await expect(page.locator("#memory .viewport-controls")).toHaveClass(/is-collapsed/);
  await expect(page.locator("#loop .viewport-controls")).not.toHaveClass(/is-collapsed/);
});

test("the Layout panel respaces the memory view as a slider moves, and remembers it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  // An example with objects in columns, for the column gap to widen.
  const example = page.locator("#programs option", { hasText: "route planner" });
  await page.locator("#programs").selectOption({ label: (await example.textContent())! });
  await page.locator("#mode-arrows").click();
  await expect(page.locator("#memory .node").nth(4)).toBeAttached({ timeout: 30_000 });
  const width = async () => Number(await page.locator("#memory svg.memory, #memory svg").first().getAttribute("width"));
  const before = await width();

  await page.locator("#layout-settings").click();
  await expect(page.locator("#layout-panel")).toBeVisible();
  const columnGap = page.locator('#layout-panel input[type=number][data-key="columnGap"]');
  await columnGap.fill("180");
  await expect.poll(width).toBeGreaterThan(before + 100);
  await expect(page.locator('#layout-panel [data-testid="layout-menu"]')).toHaveValue("custom");

  // Saved under a name, and still there (and in use) after a reload.
  await page.locator('#layout-panel input[type="text"]').fill("Wide");
  await page.locator("#layout-panel").getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(400); // the spacing is saved once changes pause
  await page.reload();
  await expect(page.locator("#memory .node").nth(4)).toBeAttached({ timeout: 30_000 });
  await expect.poll(width).toBeGreaterThan(before + 100);
  await page.locator("#layout-settings").click();
  await expect(page.locator('#layout-panel [data-testid="layout-menu"]')).toHaveValue("saved:Wide");

  await page.locator("#layout-panel").getByRole("button", { name: "Reset all" }).click();
  await expect.poll(width).toBe(before);
});
