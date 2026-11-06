/**
 * Finding the moment, in a real browser: run to a line with ◀ and ▶ in the
 * editor's gutter (app/seekController.ts), and with Ctrl + F10 at the
 * cursor; the Changes tab under the code lists what changed at each step
 * (app/changesView.ts); the panel's height is dragged; find goes to where
 * a condition holds (app/findController.ts); and a value's history opens
 * from the drawing or the Changes list (app/historyController.ts).
 */
import { expect, type Page, test } from "@playwright/test";

const CODE = `const nums = [5, 3, 8];
let total = 0;
for (let i = 0; i < nums.length; i++) {
  total += nums[i];
  nums[i] = 0;
}

console.log(total);
`;

async function open(page: Page) {
  await page.addInitScript((code) => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
    localStorage.setItem("pr0l1ne:code:javascript", code);
  }, CODE);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/javascript");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 30_000 });
}

/** Where a line's ◀ and ▶ are: hovered first, so they show (editor.ts BACK_ARROW / NEXT_ARROW). */
async function arrows(page: Page, line: number) {
  const numbered = page.locator(".monaco-editor .line-numbers").filter({ hasText: new RegExp(`^${line}$`) });
  await numbered.waitFor();
  const number = await numbered.boundingBox();
  if (!number) throw new Error("no line number");
  const y = number.y + number.height / 2;
  await page.mouse.move(number.x + number.width / 2, y);
  const mark = page.locator(".monaco-editor .run-to");
  await expect(mark).toHaveCount(1);
  const box = await mark.boundingBox();
  if (!box) throw new Error("no arrows");
  return { back: { x: box.x + 11, y }, next: { x: box.x + 18, y }, mark };
}

async function press(page: Page, line: number, which: "back" | "next") {
  const at = (await arrows(page, line))[which];
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

const label = (page: Page) => page.locator("#step-label");

test("◀ and ▶ beside a hovered line run to it, forward and back; the switch hides them and narrows the gutter", async ({
  page,
}) => {
  await open(page);
  await page.locator("#first").click();
  // Only beside the line the pointer's over, and none for a line that never ran.
  await expect(page.locator(".monaco-editor .run-to")).toHaveCount(0);
  const { mark } = await arrows(page, 5);
  await expect(mark).toHaveClass(/has-next/);
  await expect(mark).not.toHaveClass(/has-back/);

  await press(page, 5, "next");
  await expect(label(page)).toHaveText(/^Step \d+ of \d+: Ran line 4, next is line 5$/);
  const first = await label(page).textContent();
  await press(page, 5, "next");
  await expect(label(page)).not.toHaveText(first!);
  await expect(label(page)).toHaveText(/next is line 5$/);
  await press(page, 5, "back");
  await expect(label(page)).toHaveText(first!);

  // A line that never ran: no arrows, and a click there says nothing.
  const blank = await page.locator(".monaco-editor .line-numbers").filter({ hasText: /^7$/ }).boundingBox();
  await page.mouse.move(blank!.x + blank!.width / 2, blank!.y + blank!.height / 2);
  await expect(page.locator(".monaco-editor .run-to")).toHaveCount(0);
  await page.mouse.click(blank!.x + blank!.width + 14, blank!.y + blank!.height / 2);
  await expect(page.locator(".monaco-editor-overlaymessage")).toHaveCount(0);
  await expect(label(page)).toHaveText(first!);

  // Off: no arrows, and a narrower gutter; remembered.
  const width = () => page.locator(".monaco-editor .margin").evaluate((el) => el.getBoundingClientRect().width);
  const wide = await width();
  await page.locator("#run-to-toggle").click();
  await expect(page.locator("#run-to-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(width).toBeLessThan(wide);
  const number = await page.locator(".monaco-editor .line-numbers").filter({ hasText: /^5$/ }).boundingBox();
  await page.mouse.move(number!.x + number!.width / 2, number!.y + number!.height / 2);
  await expect(page.locator(".monaco-editor .run-to")).toHaveCount(0);
  await page.reload();
  await expect(label(page)).toContainText(" of ", { timeout: 30_000 });
  await expect(page.locator("#run-to-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("Ctrl + F10 runs to the cursor's line, and says when a line never ran", async ({ page }) => {
  await open(page);
  await page.locator("#first").click();
  await page.locator(".monaco-editor .view-line").nth(7).click(); // line 8, console.log
  await page.keyboard.press("Control+F10");
  await expect(label(page)).toHaveText(/next is line 8$/);
  await page.locator(".monaco-editor .view-line").nth(6).click(); // line 7, blank
  await page.keyboard.press("Control+F10");
  await expect(page.locator(".monaco-editor-overlaymessage")).toContainText(
    "No recorded step is at line 7: it never ran.",
  );
});

test("the Changes tab lists what changed at each step", async ({ page }) => {
  await open(page);
  await page.locator("#first").click();
  await page.locator("#changes-tab").click();
  await expect(page.locator("#output")).toBeHidden();
  const changes = page.locator("#changes");
  await expect(changes).toHaveText("nums: [5, 3, 8] new");
  await press(page, 5, "next");
  await expect(changes).toHaveText(/^total: from 0 → to 5$/);
  await page.locator("#next").click();
  await expect(changes).toHaveText(/^nums\[0\]: from 5 → to 0$/);
  // Kept open after a reload.
  await page.reload();
  await expect(label(page)).toContainText(" of ", { timeout: 30_000 });
  await expect(page.locator("#changes-tab")).toHaveAttribute("aria-selected", "true");
  await page.locator("#output-tab").click();
  await expect(page.locator("#output")).toBeVisible();
});

test("the panel under the code is as tall as it's dragged, and stays so", async ({ page }) => {
  await open(page);
  const panel = page.locator(".console");
  const height = () => panel.evaluate((el) => el.getBoundingClientRect().height);
  const before = await height();
  const grip = await page.locator("#console-grip").boundingBox();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y - 120, { steps: 4 });
  await page.mouse.up();
  const after = await height();
  expect(after).toBeGreaterThan(before + 100);
  // Whatever it shows: the Changes tab doesn't change its size.
  await page.locator("#changes-tab").click();
  await page.locator("#first").click();
  await page.locator("#next").click();
  expect(Math.abs((await height()) - after)).toBeLessThan(2);
  await page.reload();
  await expect(label(page)).toContainText(" of ", { timeout: 30_000 });
  expect(Math.abs((await height()) - after)).toBeLessThan(2);
  // Double-click: the default again.
  await page.locator("#console-grip").dblclick();
  expect(Math.abs((await height()) - before)).toBeLessThan(2);
});

test("find goes to the next step where a condition holds, and says why when it can't", async ({ page }) => {
  await open(page);
  await page.locator("#first").click();
  await page.locator("#find-input").fill("total > 4");
  await page.locator("#find-input").press("Enter");
  await expect(page.locator("#step-label")).toHaveText(/next is line 5$/); // total just became 5
  await page.locator("#find-input").fill("total > ");
  await page.locator("#find-input").press("Enter");
  await expect(page.locator("#find-note")).toContainText("Can't read that");
  await page.locator("#find-input").fill("total > 100");
  await page.locator("#find-input").press("Enter");
  await expect(page.locator("#find-note")).toHaveText("Not true at any step after this one.");
});

test("a value's history: hovered in the drawing, clicked to go to its next change, opened from Changes", async ({
  page,
}) => {
  await open(page);
  await page.locator("#first").click();
  await press(page, 4, "next"); // total is 0, before the loop adds to it
  // A variable, hovered: a card with its values over the run (numbers: a sparkline).
  const total = page.locator('#memory [data-var$="|total"]').first();
  await total.hover({ force: true }); // the frame's box is drawn over its rows: the pointer's what counts
  const card = page.locator(".history-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("aria-label", "History of total");
  await expect(card.locator(".history-spark")).toBeVisible();
  await expect(card).toContainText("0 – 16");
  await expect(card).toContainText("Now: 0");
  // Its next change, from the card.
  await card.getByRole("button", { name: /^The next change/ }).click();
  await expect(label(page)).toHaveText(/Ran line 4, next is line 5$/);
  await expect(card).toContainText("Now: 5");
  await card.getByRole("button", { name: "Close", exact: true }).click();
  await expect(card).toBeHidden();

  // A list's cell, clicked: the next step where it changes.
  await page.locator("#changes-tab").click();
  await page.locator('#memory [data-cell$="|1"]').first().click({ force: true });
  await expect(page.locator("#changes")).toHaveText(/^nums\[1\]: from 3 → to 0$/);

  // A name in the Changes list opens its card.
  await page.locator("#changes .change-name-button").first().click();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("aria-label", "History of nums[1]");
  await expect(card).toContainText("Now: 0");
});

test("a value's card is dragged and pinned: it stays as the steps go by, and a press on it never reaches what's under it", async ({
  page,
}) => {
  await open(page);
  await page.locator("#first").click();
  await press(page, 4, "next");
  await page.locator('#memory [data-var$="|total"]').first().hover({ force: true });
  const card = page.locator(".history-card");
  await expect(card).toBeVisible();
  // Dragged by its head, over the memory window's zoom controls: it moves there, pinned.
  const head = (await card.locator(".history-head").boundingBox())!;
  const controls = page.locator("#memory .viewport-controls");
  const toggle = (await controls.locator(".controls-toggle").boundingBox())!;
  const next = (await card.locator(".history-next").boundingBox())!;
  const from = { x: head.x + 30, y: head.y + 8 };
  // So ◀ ▶ land right over the controls' collapse button.
  const to = {
    x: from.x + (toggle.x + toggle.width / 2 - (next.x + next.width / 2)),
    y: from.y + (toggle.y + toggle.height / 2 - (next.y + next.height / 2)),
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect(card).toHaveClass(/is-pinned/);
  await expect(card.locator(".history-pin")).toHaveAttribute("aria-pressed", "true");
  // The pointer leaves, the steps go by: it stays, and shows where it is now.
  await page.mouse.move(5, 5);
  await page.locator("#last").click();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Now: 16");
  // ▶ over the collapse button: only the card's button is pressed.
  const before = await controls.getAttribute("class");
  await page.locator("#first").click();
  await page.locator(".history-card .history-next").click();
  await expect(label(page)).toHaveText(/Ran line 2, next is line 3$/); // let total = 0
  expect(await controls.getAttribute("class")).toBe(before);
  // Another value: a card of its own beside the pinned one.
  await page.locator('#memory [data-cell$="|0"]').first().hover({ force: true });
  await expect(page.locator(".history-card")).toHaveCount(2);
  await page.locator(".history-card.is-pinned .history-close").click();
  await expect(page.locator(".history-card.is-pinned")).toHaveCount(0);
});
