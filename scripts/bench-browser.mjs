/**
 * The benchmark in the page: each program in bench/programs run by the app
 * itself (Python in Pyodide, JavaScript in the runner), then stepped through
 * in both renderers and both memory modes, timing each stage (src/perf.ts,
 * the page opened with ?perf) and each step from asking for it to the frame
 * after it's drawn. See bench/README.md.
 *
 *   npm run build && npm run build:runner && npm run preview   (in another terminal)
 *   node scripts/bench-browser.mjs                     print the numbers
 *   node scripts/bench-browser.mjs --save baseline     and keep them in bench/results/browser-baseline.json
 *   node scripts/bench-browser.mjs --compare baseline  beside a saved run
 *   node scripts/bench-browser.mjs --only grid         programs whose name has "grid"
 *   PW_CHROMIUM=/path/to/chrome ...                    a Chromium of your own
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = new URL("..", import.meta.url).pathname;
const PROGRAMS = join(ROOT, "bench/programs");
const RESULTS = join(ROOT, "bench/results");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const URL_BASE = arg("url") ?? "http://localhost:4173";
/** Steps visited in each renderer and mode, spread through the run. */
const STEPS = 8;

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

async function open(page, language, code, renderer) {
  await page.goto(`${URL_BASE}/${language}?perf`);
  await page.evaluate(
    ([lang, c, r]) => {
      localStorage.setItem(`pr0l1ne:code:${lang}`, c);
      localStorage.setItem("pr0l1ne:renderer", r);
      // No step animation: each step is timed to its frame, not to the end of a slide.
      localStorage.setItem(
        "pr0l1ne:appearance",
        JSON.stringify({
          memory: { duration: 0 },
          loop: { duration: 0 },
        }),
      );
    },
    [language, code, renderer],
  );
  const started = Date.now();
  await page.reload();
  await page.locator("#step-label").filter({ hasText: " of " }).waitFor({ timeout: 180_000 });
  // The first trace (Python downloads its runtime first, the first time).
  await page.waitForFunction(() => window.__pr0l1nePerf?.lastTrace, null, { timeout: 180_000 });
  return Date.now() - started;
}

/** Visit steps spread through the run; each one's time from asking to the frame after it's drawn. */
async function stepThrough(page) {
  await page.evaluate(() => window.__pr0l1nePerf.reset());
  const max = Number(await page.locator("#scrubber").evaluate((el) => el.max));
  const frames = [];
  for (let k = 1; k <= STEPS; k++) {
    const step = Math.round((k * max) / (STEPS + 1));
    const ms = await page.evaluate(async (value) => {
      const scrubber = document.getElementById("scrubber");
      const start = performance.now();
      scrubber.value = String(value);
      scrubber.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    }, step);
    frames.push(ms);
  }
  const summary = await page.evaluate(() => window.__pr0l1nePerf.summary());
  const stage = (name) => summary[name]?.median;
  return {
    frame: median(frames),
    frameMax: Math.max(...frames),
    scene: stage("memory.scene"),
    layout: stage("memory.layout"),
    route: stage("memory.route"),
    render: stage("memory.render"),
    loop: stage("loop.render"),
    patch: stage("svg.patch"),
    paint: (stage("canvas.paint") ?? 0) + (stage("canvas.build") ?? 0) + (stage("canvas.draw") ?? 0) || undefined,
  };
}

const executablePath = process.env.PW_CHROMIUM;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const only = arg("only");
const files = readdirSync(PROGRAMS)
  .filter((name) => /\.(js|py)$/.test(name) && (!only || name.includes(only)))
  .sort();
const results = [];
for (const file of files) {
  const language = file.endsWith(".py") ? "python" : "javascript";
  const code = readFileSync(join(PROGRAMS, file), "utf8");
  const result = { program: file, views: {} };
  for (const renderer of ["svg", "canvas"]) {
    process.stderr.write(`${file} (${renderer})…\n`);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (e) => process.stderr.write(`  page error: ${e.message}\n`));
    try {
      const loadMs = await open(page, language, code, renderer);
      if (renderer === "svg") {
        const run = await page.evaluate(() => {
          const p = window.__pr0l1nePerf;
          const s = p.summary();
          return { trace: p.lastTrace, run: s["run.trace"]?.max, hints: s["run.hints"]?.max, show: s["run.show"]?.max };
        });
        result.run = { ...run, loadMs };
      }
      for (const mode of ["arrows", "nested"]) {
        await page.locator(`#mode-${mode}`).click();
        result.views[`${renderer}.${mode}`] = await stepThrough(page);
      }
    } catch (e) {
      result.error = String(e).split("\n")[0];
      process.stderr.write(`  ${result.error}\n`);
    }
    await page.close();
  }
  results.push(result);
}
await browser.close();

const compare = arg("compare");
const against = compare ? JSON.parse(readFileSync(join(RESULTS, `browser-${compare}.json`), "utf8")) : [];
const old = new Map(against.map((r) => [r.program, r]));
const f = (n) => (n === undefined || n === null || Number.isNaN(n) ? "–" : n.toFixed(0));
const vs = (now, before) => (before === undefined ? f(now) : `${f(now)} (was ${f(before)})`);
const lines = [
  "| Program | Run | Steps | Objects: most | Step, SVG arrows / nested | Step, canvas arrows / nested | Layout arrows | Routing | SVG patch | Canvas paint |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
for (const r of results) {
  const o = old.get(r.program);
  const v = r.views;
  const ov = o?.views ?? {};
  const t = r.run?.trace;
  lines.push(
    `| ${r.program}${r.error ? ` (${r.error})` : ""} | ${vs(r.run?.run, o?.run?.run)} ms${t?.truncated ? ` (stopped: ${t.stoppedBy})` : ""} | ${t?.steps ?? "–"} | ${t?.maxHeap ?? "–"} | ${vs(v["svg.arrows"]?.frame, ov["svg.arrows"]?.frame)} / ${vs(v["svg.nested"]?.frame, ov["svg.nested"]?.frame)} ms | ${vs(v["canvas.arrows"]?.frame, ov["canvas.arrows"]?.frame)} / ${vs(v["canvas.nested"]?.frame, ov["canvas.nested"]?.frame)} ms | ${f(v["svg.arrows"]?.layout)} ms | ${f(v["svg.arrows"]?.route)} ms | ${f(v["svg.arrows"]?.patch)} ms | ${f(v["canvas.arrows"]?.paint)} ms |`,
  );
}
console.log(lines.join("\n"));
const save = arg("save");
if (save) writeFileSync(join(RESULTS, `browser-${save}.json`), `${JSON.stringify(results, null, 2)}\n`);
