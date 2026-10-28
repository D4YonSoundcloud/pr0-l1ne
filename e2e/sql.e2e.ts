/**
 * SQL in real browsers: Postgres (PGlite) starts in the runner, a query is
 * stepped through clause by clause, and the page shows what a query has
 * (tables and its steps) rather than what a program has.
 */
import { expect, type Page, test } from "@playwright/test";

/**
 * Show a window at 100%: zoomed out (Auto-fit fits a long statement's
 * stages small), text is left out of the drawing (render/lod.ts).
 */
async function fullSize(page: Page, window: string) {
  await page.locator(window).focus();
  await page.keyboard.press("0");
}

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

test("a join draws a line between each pair of rows it matches", async ({ page }) => {
  await open(
    page,
    "-- viz: database shop\nSELECT c.name, o.id\nFROM customers AS c\nLEFT JOIN orders AS o ON o.customer_id = c.id;\n",
  );
  const label = page.locator("#step-label");
  await expect(label).toContainText("of 4", { timeout: 90_000 });
  await page.locator("#first").click();
  await page.locator("#next").click();
  await page.locator("#next").click();
  await expect(label).toContainText("LEFT JOIN orders AS o");
  await expect(page.locator("#memory .sql-link")).toHaveCount(14);
  await expect(page.locator("#memory")).toContainText("1 of customers AS c matches nothing: kept, with NULLs");
});

test("GROUP BY gathers rows into groups, and each group becomes one row", async ({ page }) => {
  await open(
    page,
    "-- viz: database shop\nSELECT category, count(*) AS products\nFROM products\nGROUP BY category\nHAVING count(*) > 2;\n",
  );
  const label = page.locator("#step-label");
  await expect(label).toContainText("of 6", { timeout: 90_000 });
  await page.locator("#first").click();
  await page.locator("#next").click();
  await page.locator("#next").click();
  await expect(label).toContainText("GROUP BY category");
  await expect(page.locator("#memory .sql-group-label")).toHaveCount(4);
  await page.locator("#next").click();
  await expect(page.locator("#memory")).toContainText("#1, #2, #7, #11");
  await page.locator("#next").click();
  await expect(page.locator("#memory")).toContainText("kept 3 of 4 groups");
});

test("the GROUP BY error is stepped through to the group that breaks the rule", async ({ page }) => {
  await open(page, "-- viz: database shop\nSELECT category, name\nFROM products\nGROUP BY category;\n");
  await expect(page.locator("#banner")).toContainText("must appear in the GROUP BY clause", { timeout: 90_000 });
  await expect(page.locator("#step-label")).toContainText("GROUP BY category");
  await expect(page.locator("#memory")).toContainText("products.name has 4 different values");
});

test("subqueries and UNION are stepped through as parts of the statement", async ({ page }) => {
  await open(
    page,
    "-- viz: database shop\nSELECT name FROM products\nWHERE price > (SELECT avg(price) FROM products)\nUNION\nSELECT name FROM customers;\n",
  );
  await expect(page.locator("#step-label")).toContainText("of ", { timeout: 90_000 });
  await fullSize(page, "#loop");
  await expect(page.locator("#loop .sql-part-label")).toHaveText([
    "UNION: the first query › Subquery 1",
    "UNION: the first query",
    "UNION: the second query",
  ]);
  await expect(page.locator("#step-label")).toContainText("UNION");
  await expect(page.locator("#memory .sql-table")).toHaveCount(3);
});

test("window functions and WITH RECURSIVE have steps of their own", async ({ page }) => {
  await open(
    page,
    "WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3)\nSELECT i, sum(i) OVER (ORDER BY i) AS total FROM n;\n",
  );
  await expect(page.locator("#step-label")).toContainText("of ", { timeout: 90_000 });
  await fullSize(page, "#loop");
  await expect(page.locator("#loop .sql-stage-keyword")).toHaveText([
    "SELECT",
    "PASS 1",
    "PASS 2",
    "PASS 3",
    "ALL",
    "FROM",
    "WINDOW",
    "SELECT",
  ]);
  await expect(page.locator("#output")).toContainText("(3 rows)");
});

test("Import CSV adds a table to the program, ready to run", async ({ page }) => {
  await open(page, "SELECT 1;\n");
  await expect(page.locator("#step-label")).toContainText("of ", { timeout: 90_000 });
  await expect(page.locator("#import-csv")).toBeVisible();
  await page.locator("#csv-file").setInputFiles({
    name: "pets.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("name,age\nRex,3\nTom,5\n"),
  });
  await expect(page.locator("#banner")).toContainText("Added the table pets from pets.csv: 2 rows");
  await page.locator("#run").click();
  await expect(page.locator("#output")).toContainText("INSERT 0 2");
  // Not for a program's languages.
  await page.locator("#language").selectOption("python");
  await expect(page.locator("#import-csv")).toBeHidden();
});
