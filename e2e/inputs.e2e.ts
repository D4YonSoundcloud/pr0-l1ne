/**
 * Inputs you can switch between, in a real browser (app/inputController.ts,
 * trace/inputs.ts): the Input button shows for a `viz: input`; a variant
 * runs the program with that value swapped in, the code in the editor as
 * it was, a note beside the line; Live keeps it as the code's edited; a
 * value over several lines keeps the line numbers; and a hint it can't use
 * says why.
 */
import { expect, type Page, test } from "@playwright/test";

async function open(page: Page, language: "python" | "javascript", code: string) {
  await page.addInitScript(
    ([lang, text]) => {
      if (sessionStorage.getItem("set")) return;
      sessionStorage.setItem("set", "1");
      localStorage.clear();
      localStorage.setItem(`pr0l1ne:code:${lang}`, text);
    },
    [language, code],
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/${language}`);
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 90_000 });
}

const line = (page: Page, n: number) => page.locator(".monaco-editor .view-line").nth(n - 1);
const output = (page: Page) => page.locator("#output");
const button = (page: Page) => page.locator("#input-button");

async function choose(page: Page, label: string) {
  if (await page.locator("#input-menu").isHidden()) await button(page).click();
  await page
    .locator("#input-menu label")
    .filter({ hasText: new RegExp(`^${label}`) })
    .first()
    .click();
}

test("a variant runs the program with that value; the editor's code stays; Live keeps it as the code's edited", async ({
  page,
}) => {
  await open(
    page,
    "python",
    `# viz: input
nums = [5, 3, 8, 1]
print(nums[0], len(nums))
`,
  );
  await expect(output(page)).toHaveText("5 4");
  await expect(button(page)).toBeVisible();
  await expect(button(page)).toHaveText("Input");

  await choose(page, "Sorted");
  await expect(output(page)).toHaveText("1 4");
  await expect(button(page)).toHaveText("Input: Sorted");
  await expect(line(page, 2)).toHaveText("nums = [5, 3, 8, 1]"); // the code isn't changed
  await expect(page.locator(".monaco-editor .input-note")).toHaveCount(1);

  await choose(page, "Reversed");
  await expect(output(page)).toHaveText("8 4");
  // An edge case: no items at all, and the program's own error says so.
  await choose(page, "Empty");
  await expect(page.locator("#banner")).toContainText("IndexError");

  // Back to sorted, then the code's edited (Live): the variants are of the value written now.
  await choose(page, "Sorted");
  await expect(output(page)).toHaveText("1 4");
  await page.keyboard.press("Escape");
  await expect(page.locator("#input-menu")).toBeHidden();
  await line(page, 2).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type(", 0");
  await expect(output(page)).toHaveText("0 5", { timeout: 15_000 });

  // All as written.
  await button(page).click();
  await page.locator("#input-reset").click();
  await expect(output(page)).toHaveText("5 5");
  await expect(button(page)).toHaveText("Input");
  await expect(page.locator(".monaco-editor .input-note")).toHaveCount(0);
});

test("a value over several lines keeps its lines: the program's line numbers still match", async ({ page }) => {
  await open(
    page,
    "javascript",
    `// viz: input
const grid = [
  [1, 2],
  [3, 4],
];
const rows = grid.length;
console.log(rows);
`,
  );
  await expect(output(page)).toHaveText("2");
  await choose(page, "One item");
  await expect(output(page)).toHaveText("1");
  await page.locator("#prev").click(); // from the end
  await expect(page.locator("#step-label")).toHaveText(/Ran line 6, next is line 7$/);
});

test("random: the values shown, until ↻ rolls new ones", async ({ page }) => {
  await open(page, "javascript", `// viz: input\nconst nums = [5, 3, 8, 1, 9, 2];\nconsole.log(nums.join(" "));\n`);
  await button(page).click();
  const shown = await page.locator('label[for="input-nums-random"] .input-option-value').textContent();
  await choose(page, "Random");
  const printed = JSON.parse(shown!).join(" ");
  await expect(output(page)).toHaveText(printed);
  await page.locator("#input-nums-again").click();
  await expect(output(page)).not.toHaveText(printed);
});

test("a hint it can't use says why, in the editor and the banner", async ({ page }) => {
  await open(
    page,
    "javascript",
    `// viz: input\nconst nums = Array.from({ length: 4 }, (_, i) => i);\nconsole.log(nums);\n`,
  );
  await expect(page.locator("#banner")).toContainText('nums: "input" works on a value written out');
  await expect(button(page)).toBeHidden();
});
