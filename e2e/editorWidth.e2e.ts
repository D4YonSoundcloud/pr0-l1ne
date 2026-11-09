/**
 * The code window, made narrow (its divider dragged): the editor, its
 * header and the panel under it stay inside the window, never over the
 * windows beside it; the header's switches lose their words, and the find
 * box gets a row of its own.
 */
import { expect, test } from "@playwright/test";

test("a narrow code window keeps the editor, its header and the panel under it inside it", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 820 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  for (const width of [420, 260, 190]) {
    const d = (await page.locator(".workspace > .divider").first().boundingBox())!;
    await page.mouse.move(d.x + d.width / 2, d.y + 300);
    await page.mouse.down();
    await page.mouse.move(width, d.y + 300, { steps: 5 });
    await page.mouse.up();
    const pane = (await page.locator("#editor-pane").boundingBox())!;
    expect(Math.abs(pane.width - width)).toBeLessThan(12);
    // Everything the window draws ends at its right edge (Monaco's own inner layers clip themselves).
    const spill = await page.evaluate(() => {
      const right = document.querySelector("#editor-pane")!.getBoundingClientRect().right + 1;
      const parts = [
        "#editor .monaco-editor",
        ".editor-head",
        ".editor-head > *",
        ".console",
        ".console-tabs",
        ".find",
        ".find > *",
        "#output",
      ];
      return parts.flatMap((sel) =>
        [...document.querySelectorAll<HTMLElement>(sel)]
          .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().right > right)
          .map((el) => `${sel} ends at ${Math.round(el.getBoundingClientRect().right)}, past ${Math.round(right)}`),
      );
    });
    expect(spill, `at ${width}px`).toEqual([]);
  }
  // Narrow: the switches are icons (their names are still their labels), the find box under the tabs.
  await expect(page.locator("#run-to-toggle .pane-toggle-label")).toBeHidden();
  await expect(page.locator("#run-to-toggle")).toHaveAccessibleName(/Run to line/);
  const tabs = (await page.locator(".console-tabs").boundingBox())!;
  const find = (await page.locator("#find").boundingBox())!;
  expect(find.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 2);
});
