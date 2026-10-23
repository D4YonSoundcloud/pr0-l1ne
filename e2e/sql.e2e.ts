/**
 * SQL in real browsers: Postgres (PGlite) starts in the runner, a query is
 * stepped through clause by clause, and the page shows what a query has
 * (tables and its steps) rather than what a program has.
 */
import { expect, type Page, test } from "@playwright/test";

async function open(page: Page, code: string) {
  await page.addInitScript((code) => {
    localStorage.clear();
    localStorage.setItem("pr0l1ne:settings-version", "1");
    localStorage.setItem("pr0l1ne:language", "sql");
    localStorage.setItem("pr0l1ne:code:sql", code);
  }, code);
  await page.goto("/");
}

const QUERY = `-- viz: database shop
SELECT name, price
FROM products
WHERE price < 10
ORDER BY price DESC
LIMIT 3;
`;

test("a query is stepped through clause by clause", async ({ page }) => {
  await open(page, QUERY);
  const label = page.locator("#step-label");
  await expect(label).toContainText("of 6", { timeout: 90_000 });
  await expect(page.locator("#status")).toContainText("PostgreSQL");
  // It opens on the last step: LIMIT, and the result in the output.
  await expect(label).toContainText("LIMIT 3");
  await expect(page.locator("#output")).toContainText("(3 rows)");
  // Back to WHERE: every row, and which it keeps.
  await page.locator("#first").click();
  await page.locator("#next").click();
  await page.locator("#next").click();
  await expect(label).toContainText("WHERE price < 10");
  await expect(page.locator("#memory")).toContainText("kept 6 of 12 rows");
  await expect(page.locator("#loop")).toContainText("ORDER BY");
});

test("the page shows a query's windows, and a program's again after", async ({ page }) => {
  await open(page, QUERY);
  await expect(page.locator("#step-label")).toContainText("of 6", { timeout: 90_000 });
  await expect(page.locator("#memory-title")).toHaveText("Tables");
  await expect(page.locator("#loop-title")).toHaveText("Query steps");
  await expect(page.locator("#measure")).toBeHidden();
  await expect(page.locator("#complexity")).toBeHidden();
  await page.locator("#language").selectOption("javascript");
  await expect(page.locator("#memory-title")).toHaveText("Memory");
  await expect(page.locator("#measure")).toBeVisible();
});

test("an error is explained, on its line", async ({ page }) => {
  await open(page, "-- viz: database shop\nSELECT name\nFROM products\nWHERE prise > 10;\n");
  await expect(page.locator("#banner")).toContainText('column "prise" does not exist', { timeout: 90_000 });
  await expect(page.locator("#banner")).toContainText("on line 4");
  await expect(page.locator("#banner")).toContainText('"price"');
});
