/**
 * The sandbox, in real browsers: programs run on the code runner's site,
 * and nothing they try gets out (see "Security" in docs/how-it-works.md).
 * Each test is something a hostile program, or a hostile page, could try.
 */
import { expect, type Page, test, type Worker } from "@playwright/test";

const RUNNER = "http://127.0.0.1:4174";
const APP = "http://localhost:4173";

/** Open the app with a program in the editor, as if it had been saved there. */
/** Workers that have closed: the page may still list one for a moment after it's gone. */
const closedWorkers = new WeakSet<Worker>();

async function open(page: Page, language: string, code: string) {
  page.on("worker", (worker) => worker.once("close", () => closedWorkers.add(worker)));
  await page.addInitScript(
    ([language, code]) => {
      localStorage.clear();
      localStorage.setItem("pr0l1ne:settings-version", "1");
      localStorage.setItem("pr0l1ne:language", language);
      localStorage.setItem(`pr0l1ne:code:${language}`, code);
    },
    [language, code],
  );
  await page.goto("/");
}

const finished = (page: Page) => expect(page.locator("#step-label")).toContainText(" of ", { timeout: 90_000 });
const banner = (page: Page) => page.locator("#banner");

/**
 * The language worker, inside the runner's iframe. Chromium's automation
 * sees workers inside a cross-site frame; if another browser's doesn't,
 * the checks that need to run code in it are skipped there (the rest of
 * each test still runs, and Chromium runs them all).
 */
async function runnerWorker(page: Page, browserName: string) {
  // The newest one that's still running (the app replaces a worker that stopped).
  const find = () =>
    page
      .workers()
      .filter((w) => w.url().startsWith(RUNNER) && !closedWorkers.has(w))
      .at(-1);
  await expect
    .poll(() => !!find(), { timeout: 15_000 })
    .toBe(true)
    .catch((error) => {
      test.skip(
        browserName !== "chromium",
        `${browserName}'s automation doesn't show workers inside a cross-site frame`,
      );
      throw error;
    });
  return find()!;
}

const PROGRAMS: Record<string, string> = {
  python: "a = [3, 1, 2]\na.sort()\nprint(a)\n",
  javascript: "const a = [3, 1, 2];\na.sort();\nconsole.log(a);\n",
  typescript: "const a: number[] = [3, 1, 2];\nlet total: number = 0;\nfor (const x of a) total += x;\n",
};

for (const [language, code] of Object.entries(PROGRAMS)) {
  test(`${language} runs on the runner's site, not the app's`, async ({ page, browserName }) => {
    await open(page, language, code);
    await finished(page);
    await expect(banner(page)).toBeHidden();
    const frames = await page
      .locator("iframe.sandbox-frame")
      .evaluateAll((els) => els.map((f) => (f as HTMLIFrameElement).src));
    expect(frames).toEqual([`${RUNNER}/runner.html`]);
    const worker = await runnerWorker(page, browserName);
    expect(await worker.evaluate(() => self.location.origin)).toBe(RUNNER);
    // The app's own workers are only the editor's.
    expect(
      page
        .workers()
        .filter((w) => w.url().startsWith(APP))
        .every((w) => w.url().includes("editor.worker")),
    ).toBe(true);
  });
}

/** Each way out the worker test tries, run inside the runner's worker. */
const WAYS_OUT = [
  "fetch another site",
  "fetch the app",
  "fetch the app, no-cors",
  "websocket",
  "beacon",
  "import()",
  "EventSource",
] as const;

test("inside the worker, every way out is blocked", async ({ page, browserName }) => {
  await open(page, "javascript", "let a = 1;\n");
  await finished(page);
  // One attempt at a time. A browser may answer a blocked attempt by stopping
  // the worker altogether (Firefox can, reporting it as an error in the
  // worker: the app then replaces it as a crashed one). That attempt didn't
  // get out either: note it, and try the next one in the fresh worker.
  const results: Record<string, string> = {};
  // First, while the worker is untouched: can it see the app's window at all?
  results["the app's window"] = await (await runnerWorker(page, browserName)).evaluate(() =>
    "parent" in self || "top" in self ? "reachable" : "blocked",
  );
  // Then the ways out. The last ones (import(), EventSource) are the ones
  // Firefox answers by stopping the worker, so nothing comes after them.
  for (const name of WAYS_OUT) {
    const worker = await runnerWorker(page, browserName);
    results[name] = await worker
      .evaluate(
        async ([name, app]) => {
          const ways: Record<string, () => Promise<unknown>> = {
            "fetch another site": () => fetch("https://example.com/"),
            "fetch the app": () => fetch(`${app}/`),
            "fetch the app, no-cors": () => fetch(`${app}/`, { mode: "no-cors" }),
            websocket: () =>
              new Promise((resolve, reject) => {
                const ws = new WebSocket("wss://example.com/");
                ws.onopen = resolve;
                ws.onerror = reject;
              }),
            beacon: async () => {
              if (!navigator.sendBeacon("https://example.com/", "x")) throw new Error("not sent");
            },
            "import()": () => {
              const script = "https://example.com/x.js";
              return import(/* @vite-ignore */ script);
            },
            EventSource: () =>
              new Promise((resolve, reject) => {
                const es = new EventSource("https://example.com/");
                es.onopen = resolve;
                es.onerror = reject;
              }),
          };
          try {
            await Promise.race([
              ways[name](),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000)),
            ]);
            return "GOT OUT";
          } catch {
            return "blocked";
          }
        },
        [name, APP] as const,
      )
      .catch((error: Error) => {
        if (!/context was destroyed|Target closed|has been closed/i.test(error.message)) throw error;
        // Gone, even if the browser hasn't said so yet: the next attempt waits for the app's fresh one.
        closedWorkers.add(worker);
        return "blocked (the browser stopped the worker)";
      });
  }
  // Shown in the test output, so it's visible which attempts a browser stops the worker for.
  console.log(`[${browserName}] ways out:`, JSON.stringify(results));
  expect(Object.entries(results).filter(([, v]) => !v.startsWith("blocked"))).toEqual([]);
});

test("a program's own attempts to get out are blocked", async ({ page }) => {
  // Synchronous attempts only: the tracer doesn't wait for real network
  // replies (a fetch's rejection can come after the program has finished,
  // in Firefox it does), but a synchronous request or importScripts fails
  // on the spot, so what each got is always in the last step.
  await open(
    page,
    "javascript",
    `const out = [];
const tryIt = (name, f) => { try { f(); out.push(name + ": GOT OUT"); } catch (e) { out.push(name + ": blocked"); } };
const get = (url) => { const xhr = new XMLHttpRequest(); xhr.open("GET", url, false); xhr.send(); };
tryIt("another site", () => get("https://example.com/"));
tryIt("the app", () => get("${APP}/"));
tryIt("importScripts", () => importScripts("https://example.com/x.js"));
`,
  );
  await finished(page);
  // The app opens on the last step: its memory view shows what each attempt got.
  await expect(page.locator("#memory")).toContainText("another site: blocked");
  await expect(page.locator("#memory")).toContainText("the app: blocked");
  await expect(page.locator("#memory")).toContainText("importScripts: blocked");
  await expect(page.locator("#memory")).not.toContainText("GOT OUT");
});

test("the runner page can't reach, navigate or pop up over the app", async ({ page }) => {
  await open(page, "javascript", "let a = 1;\n");
  await finished(page);
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    await d.dismiss();
  });
  const popups: string[] = [];
  page.on("popup", (p) => popups.push(p.url()));
  const frame = page.frames().find((f) => f.url().startsWith(RUNNER))!;
  const results = await frame.evaluate(() => {
    const out: Record<string, string> = {};
    try {
      out.document = window.parent.document ? "GOT OUT" : "blocked";
    } catch {
      out.document = "blocked";
    }
    try {
      window.top!.location.href = "https://example.com/";
      out.navigate = "tried";
    } catch {
      out.navigate = "blocked";
    }
    try {
      out.popup = window.open("https://example.com/") ? "GOT OUT" : "blocked";
    } catch {
      out.popup = "blocked";
    }
    try {
      alert("hi");
    } catch {
      // blocked by throwing, in some browsers
    }
    return out;
  });
  await page.waitForTimeout(500);
  expect(results.document).toBe("blocked");
  expect(results.popup).toBe("blocked");
  expect(popups).toEqual([]);
  expect(dialogs).toBe(0);
  expect(page.url().startsWith(APP)).toBe(true);
});

test("a program that tampers with its own trace is refused, not drawn", async ({ page }) => {
  await open(
    page,
    "javascript",
    `// Change the trace on its way to the app.
const post = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (message, transfer) {
  if (message && message.type === "result") message.trace.surprise = true;
  return post.call(this, message, transfer);
};
let a = 1;
`,
  );
  await expect(banner(page)).toContainText("doesn't match the trace format", { timeout: 60_000 });
  await expect(banner(page)).toContainText("surprise");
});

test("an endless loop is stopped, and the next run works", async ({ page }) => {
  await open(page, "javascript", "let x = 0;\nwhile (true) { x++; }\n");
  await expect(banner(page)).toContainText(/stopped/i, { timeout: 60_000 });
  await finished(page);
});

test("a program stuck inside one call is cut off, and gets a fresh runner", async ({ page }) => {
  test.slow();
  await open(page, "python", "x = sum(range(10**12))\n");
  await expect(banner(page)).toContainText(/more than 10 seconds/, { timeout: 150_000 });
  await expect(page.locator("iframe.sandbox-frame")).toHaveCount(1);
});

test("the runner sends its rules with its page and its workers", async ({ page, request, browserName }) => {
  await open(page, "javascript", "let a = 1;\n");
  await finished(page);
  const worker = await runnerWorker(page, browserName);
  for (const url of [`${RUNNER}/runner.html`, worker.url()]) {
    const csp = (await request.get(url)).headers()["content-security-policy"] ?? "";
    expect(csp, url).toContain("default-src 'none'");
    expect(csp, url).toContain("connect-src 'self'");
    expect(csp, url).toContain("frame-ancestors");
  }
});

test("only the app may embed the runner", async ({ page }) => {
  // A page that isn't the app (about:blank, an opaque origin) embeds the runner: the browser refuses to show it.
  await page.setContent(`<iframe src="${RUNNER}/runner.html"></iframe>`);
  await page.waitForTimeout(2000);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  // Where the browser refused the frame, there may be nothing to run code in:
  // Firefox's error page never answers. No answer, or an error, means the
  // runner isn't there.
  const title = await Promise.race([
    frame ? frame.evaluate(() => document.title).catch(() => "blocked") : Promise.resolve("blocked"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked (no answer)"), 5000)),
  ]);
  expect(title).not.toBe("PR0L1NE code runner");
});
