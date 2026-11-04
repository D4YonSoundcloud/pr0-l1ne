/**
 * A run's progress and Stop in a real browser (app/runProgress.ts,
 * trace/stream.ts): a program that runs until its time limit shows the
 * progress line and the card over the canvas, with the last drawing dimmed;
 * Stop ends it at once and draws the steps recorded up to then.
 */
import { expect, test } from "@playwright/test";

// Recording slowly (a step every millisecond or so), so the run lasts its whole time limit.
const SLOW = `let rounds = 0;
while (true) {
  const until = Date.now() + 1;
  while (Date.now() < until) {}
  rounds++;
}
`;

test("a long run shows its progress, and Stop keeps what was recorded", async ({ page }) => {
  await page.addInitScript((code) => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
    localStorage.setItem("pr0l1ne:code:javascript", code);
  }, SLOW);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  // Live runs it first, for its shorter time limit, and draws that.
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
  await expect(page.locator("#run-progress")).toBeHidden();

  await page.locator("#run").click();
  const card = page.locator("#run-card");
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#run-progress .run-progress-text")).toContainText("Running ·");
  await expect(page.locator("#status")).toBeHidden(); // the line takes its place
  await expect(card.locator('[data-stage="run"]')).toHaveClass(/is-current/);
  await expect(card.locator(".run-card-left")).toContainText("At most");
  await expect(page.locator("#canvas")).toHaveClass(/is-running/);

  // Wait for a piece of the trace to have arrived (a second or so in), then stop.
  await page.waitForTimeout(2_000);
  const started = Date.now();
  await card.getByRole("button", { name: "Stop and show what's recorded" }).click();
  await expect(page.locator(".banner")).toContainText("You stopped the run", { timeout: 5_000 });
  expect(Date.now() - started).toBeLessThan(4_000); // well before its 6 second limit
  await expect(card).toBeHidden();
  await expect(page.locator("#run-progress")).toBeHidden();
  await expect(page.locator("#canvas")).not.toHaveClass(/is-running/);
  await expect(page.locator("#step-label")).toContainText(" of ");

  // And the next run works (a fresh worker).
  await page.locator("#run").click();
  await expect(card).toBeVisible({ timeout: 5_000 });
  await page.locator("#run-progress .run-stop").click();
  await expect(card).toBeHidden({ timeout: 5_000 });
});
