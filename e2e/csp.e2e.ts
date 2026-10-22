/**
 * The app runs under its own Content-Security-Policy (public/_headers, sent
 * by `npm run preview` as by Cloudflare): every feature that loads something
 * or runs something, with no violation. The canvas renderer included: it
 * falls back to SVG quietly when it can't start, so it's checked it did.
 */
import { expect, test } from "@playwright/test";

test("the app runs under its policy, with no violations", async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { violations: string[] }).violations = seen;
    document.addEventListener("securitypolicyviolation", (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`),
    );
    localStorage.clear();
    localStorage.setItem("pr0l1ne:settings-version", "1");
    localStorage.setItem("pr0l1ne:language", "javascript");
    localStorage.setItem(
      "pr0l1ne:code:javascript",
      "const a = [3, 1, 2];\na.sort();\nconsole.log(a);\nfunction f(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; }\nf(20);\n",
    );
    localStorage.setItem("pr0l1ne:renderer", "canvas");
  });
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await expect(page.locator("#step-label")).toContainText(" of ", { timeout: 90_000 });
  // Canvas 2D really started (PixiJS needs pixi.js/unsafe-eval under this policy).
  await expect(page.locator("#memory canvas.viewport-canvas")).toHaveCount(1);
  await page.locator("#first").click();
  for (let i = 0; i < 3; i++) await page.locator("#next").click();
  await page.locator("#measure").click();
  await expect(page.locator("#measure-results")).toBeVisible({ timeout: 60_000 });
  await page.locator("#complexity").click();
  const violations = await page.evaluate(() => (window as unknown as { violations: string[] }).violations);
  // Fonts come from Google: a test machine without the network may not reach them, which isn't a violation.
  expect(violations).toEqual([]);
});
