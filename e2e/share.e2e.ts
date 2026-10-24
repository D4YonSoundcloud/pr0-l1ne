/**
 * Share links in real browsers (src/share/link.ts, app/shareController.ts):
 * a link opens its program without running it, Run runs it, editing makes
 * it the person's own code, a broken link says so, and Share makes a link
 * that opens the same program.
 */
import { expect, type Page, test } from "@playwright/test";
import { encodeShare } from "../src/share/link";

const link = async (language: string, code: string) => `/#${await encodeShare({ language, code })}`;
const banner = (page: Page) => page.locator("#banner");
const editorText = (page: Page) => page.locator("#editor .view-lines");

test.beforeEach(async ({ page }) => {
  // A visitor with their own unsaved JavaScript.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("set")) return;
    sessionStorage.setItem("set", "1");
    localStorage.clear();
    localStorage.setItem("pr0l1ne:settings-version", "1");
    localStorage.setItem("pr0l1ne:language", "javascript");
    localStorage.setItem("pr0l1ne:code:javascript", "let mine = 'my own work';\n");
  });
});

test("a link opens its program, says whose it is, and runs nothing until asked", async ({ page }) => {
  await page.goto(await link("python", "shared = [3, 1, 2]\nshared.sort()\n"));
  await expect(banner(page)).toContainText("This Python program came from a share link");
  await expect(editorText(page)).toContainText("shared.sort()");
  await expect(page.locator("#program-name")).toHaveText("Shared program");
  await expect(page.locator("#language")).toHaveValue("python");
  // Nothing ran: there's no step to show, even once Python has loaded (switching language loads it, ready).
  await expect(page.locator("#status")).toContainText("Python", { timeout: 90_000 });
  await page.waitForTimeout(1000);
  await expect(page.locator("#step-label")).toHaveText("");
  // Run runs it.
  await banner(page).getByRole("button", { name: "Run it" }).click();
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 90_000 });
});

test("opening a link and leaving without editing leaves the person's own code as it was", async ({ page }) => {
  await page.goto(await link("javascript", "let theirs = 1;\n"));
  await expect(editorText(page)).toContainText("theirs");
  await page.goto("/");
  await expect(editorText(page)).toContainText("my own work");
});

test("editing it makes it the person's own code, and takes the link out of the address", async ({ page }) => {
  await page.goto(await link("javascript", "let theirs = 1;\n"));
  await expect(editorText(page)).toContainText("theirs");
  expect(new URL(page.url()).hash).toMatch(/^#v1\./);
  await page.locator("#editor .view-lines").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" // mine now");
  await expect(page.locator("#program-name")).toHaveText("Untitled");
  await expect.poll(() => new URL(page.url()).hash).toBe("");
});

test("its Save button saves it as the person's own program", async ({ page }) => {
  await page.goto(await link("javascript", "let keep = 1;\n"));
  await banner(page).getByRole("button", { name: "Save to my programs" }).click();
  await expect(page.locator("#save-dialog")).toBeVisible();
  await page.locator("#save-name").fill("From a friend");
  await page.locator("#save-name").press("Enter");
  await expect(page.locator("#program-name")).toHaveText("From a friend");
});

test("a broken link says so, and the person's own code is still there", async ({ page }) => {
  await page.goto("/#v1.this-is-not-a-real-link");
  await expect(banner(page)).toContainText("Couldn't open the share link");
  await expect(editorText(page)).toContainText("my own work");
  expect(new URL(page.url()).hash).toBe("");
});

test("Share makes a link that opens the same program", async ({ page, context }) => {
  // What Share copies, caught on its way to the clipboard: reading the
  // clipboard back needs a permission (or a click) some browsers won't give a test.
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => {
          copied.push(text);
        },
      });
    }
  });
  await page.goto("/");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 90_000 });
  await page.locator("#share").click();
  // Copied, or (with no clipboard at all) shown to copy by hand.
  const shown = banner(page).locator("input.banner-input");
  await expect
    .poll(
      async () =>
        (await shown.count()) > 0 ||
        (await page.evaluate(() => (window as unknown as { copied: string[] }).copied.length)) > 0,
    )
    .toBe(true);
  const url = (await shown.count())
    ? await shown.inputValue()
    : await page.evaluate(() => (window as unknown as { copied: string[] }).copied[0]);
  // At the language's own page (app/routing.ts).
  expect(url).toMatch(/^http:\/\/localhost:4173\/javascript#v1\./);
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.locator("#banner")).toContainText("came from a share link");
  await expect(other.locator("#editor .view-lines")).toContainText("my own work");
});
