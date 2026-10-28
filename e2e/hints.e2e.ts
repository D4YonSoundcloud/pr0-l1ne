import { expect, test } from "@playwright/test";

/**
 * Help writing hints in the editor (hintEditor.ts): the lightbulb's window
 * hint goes above its loop and draws the window, and typing viz: opens the
 * list of hints.
 */
const code = `function longest(s) {
  const seen = new Set();
  let left = 0, best = 0;
  for (let right = 0; right < s.length; right++) {
    while (seen.has(s[right])) {
      seen.delete(s[left]);
      left++;
    }
    seen.add(s[right]);
    best = Math.max(best, right - left + 1);
  }
  return best;
}
console.log(longest("abcabcbb"));
`;

test("the lightbulb adds a sliding window hint above its loop, and the window is drawn", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await page.evaluate((c) => localStorage.setItem("pr0l1ne:code:javascript", c), code);
  await page.reload();
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });

  // The loop's first line, then the lightbulb's actions.
  await page.locator("#editor .view-lines").click();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+.");
  const action = page.locator(".action-widget").getByText("Show left to right as a sliding window over s");
  await expect(action).toBeVisible();
  await action.click();
  // On its own line above the loop, indented like it.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("pr0l1ne:code:javascript")))
    .toContain("  // viz: window s: [left, right]\n  for (let right = 0;");

  // Somewhere in the loop: the string as letters, with the window over them.
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#scrubber").fill("30");
  await expect(page.locator("#memory .window-band").first()).toBeAttached();
  await expect(page.locator("#loop .window-band").first()).toBeAttached();
});

test("typing viz: in a comment lists the hints", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await page.evaluate((c) => localStorage.setItem("pr0l1ne:code:javascript", c), code);
  await page.reload();
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#editor .view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// viz:");
  const suggest = page.locator(".suggest-widget");
  await expect(suggest).toBeVisible();
  await expect(suggest).toContainText("window");
  await expect(suggest).toContainText("pointers");
});

const insertion = `const nums = [5, 2, 4, 6, 1, 3];
let total = 0;
// viz: region nums: [0, i) "sorted"
// viz: compare nums: j - 1, j
// viz: watch i - j
// viz: check total == 1
for (let i = 1; i < nums.length; i++) {
  let j = i;
  while (j > 0 && nums[j - 1] > nums[j]) {
    [nums[j - 1], nums[j]] = [nums[j], nums[j - 1]];
    j--;
  }
  total += 1;
}
`;

test("region, compare, watch and check are drawn", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await page.evaluate((c) => localStorage.setItem("pr0l1ne:code:javascript", c), insertion);
  await page.reload();
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await page.locator("#scrubber").fill("40");
  await expect(page.locator("#memory .region-band").first()).toBeAttached();
  await expect(page.locator("#memory .region-label").first()).toBeAttached();
  await expect(page.locator("#memory .compare-mark")).toHaveCount(2);
  await expect(page.locator("#loop .watch").first()).toBeAttached();
  // total is 1 only after the first pass: other rows fail.
  await expect(page.locator("#loop .loop-row.is-failing").first()).toBeAttached();
  await expect(page.locator("#loop .check-failed").first()).toHaveText("✗ total == 1");
});

test("the Style panel's arrow colors: a set to start from, and one color for all", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  const cssVar = (name: string) =>
    page.evaluate((n) => document.getElementById("canvas")!.style.getPropertyValue(n), name);
  await page.locator("#style").click();
  await page.locator("#style-panel summary", { hasText: "Arrows" }).click();
  await page
    .locator("#style-panel select", { has: page.locator("option", { hasText: "Neon" }) })
    .selectOption({ label: "Neon (dark canvases)" });
  await expect.poll(() => cssVar("--arrow-cycle")).toBe("#ffb703");
  await expect.poll(() => cssVar("--arrow-next")).toBe("#f72585");
  await page.locator("#style-panel .segment", { hasText: "One color" }).click();
  await expect.poll(() => cssVar("--arrow-next")).toBe("#4cc9f0");
  await expect.poll(() => cssVar("--arrow-cycle")).toBe("#4cc9f0");
});
