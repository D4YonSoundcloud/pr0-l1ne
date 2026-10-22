/**
 * Browser tests (npm run test:e2e): the sandbox, in Chromium, Firefox and
 * WebKit, against both builds served locally (npm run preview: the app on
 * localhost:4173, the code runner on 127.0.0.1:4174). Build both first:
 *
 *   npm run build && npm run build:runner && npm run test:e2e
 *
 * Browsers come from `npx playwright install`. To use a Chromium you
 * already have, set PW_CHROMIUM to its path (and run --project=chromium).
 */
import { defineConfig, devices } from "@playwright/test";

const chromium = process.env.PW_CHROMIUM;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://localhost:4173/" },
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(chromium ? { launchOptions: { executablePath: chromium } } : {}) },
    },
    { name: "firefox", use: devices["Desktop Firefox"] },
    { name: "webkit", use: devices["Desktop Safari"] },
  ],
});
