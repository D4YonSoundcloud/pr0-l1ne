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
 *   node scripts/bench-browser.mjs --headed            in a window, so WebGL is drawn by the
 *                                                      graphics card (headless draws it in software)
 *   node scripts/bench-browser.mjs --channel chrome     with the Google Chrome installed here
 *   node scripts/bench-browser.mjs --zooms             levels of detail: each JavaScript
 *                                                      program at 100% to 1%, with them and
 *                                                      without (?nolod), steps and panning
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
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

async function open(page, language, code, renderer, extra = "") {
  await page.goto(`${URL_BASE}/${language}?perf${extra}`);
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
  await page.evaluate(() => window.__pr0l1nePerf.whenDrawn?.());
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
      // Laid out in the layout worker: wait for the drawing, then the frame it's on.
      await window.__pr0l1nePerf.whenDrawn?.();
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

/** Zooms for --zooms, as presses of "−" from 100% (each zooms out by 1.25). */
const ZOOMS = [
  ["100%", 0],
  ["41%", 4],
  ["21%", 7],
  ["5.5%", 13],
  ["1%", 21],
];

/** Pan the window with the wheel, a frame each: the median frame, in ms. */
async function panFrames(page) {
  return page.evaluate(async () => {
    const el = document.getElementById("memory");
    const box = el.getBoundingClientRect();
    const frames = [];
    for (let i = 0; i < 24; i++) {
      const start = performance.now();
      el.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: i % 2 ? 40 : -40,
          deltaY: i % 4 < 2 ? 30 : -30,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      frames.push(performance.now() - start);
    }
    frames.sort((a, b) => a - b);
    return frames[Math.floor(frames.length / 2)];
  });
}

/** --zooms: each JavaScript program, each renderer, with levels of detail and without, at each zoom. */
async function zoomSuite(browser, files) {
  const out = [];
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(join(PROGRAMS, file), "utf8");
    for (const renderer of ["svg", "canvas", "webgl"]) {
      for (const lod of [true, false]) {
        process.stderr.write(`${file} (${renderer}, ${lod ? "levels" : "no levels"})…\n`);
        const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
        try {
          await open(page, "javascript", code, renderer, lod ? "" : "&nolod");
          await page.locator("#mode-arrows").click();
          const row = { program: file, renderer, lod, gpu, zooms: {} };
          let pressed = 0;
          await page.locator("#memory").focus();
          await page.keyboard.press("0"); // 100%, Auto-fit off
          await stepThrough(page); // warm up: the first steps drawn are slower
          for (const [label, presses] of ZOOMS) {
            await page.locator("#memory").focus();
            for (; pressed < presses; pressed++) await page.keyboard.press("-");
            await page.waitForTimeout(300);
            await page.evaluate(() => window.__pr0l1nePerf.whenDrawn?.());
            const steps = await stepThrough(page);
            row.zooms[label] = {
              step: steps.frame,
              render: steps.render,
              draw: renderer === "svg" ? steps.patch : steps.paint,
              pan: await panFrames(page),
            };
          }
          out.push(row);
        } catch (e) {
          process.stderr.write(`  ${String(e).split("\n")[0]}\n`);
        }
        await page.close();
      }
    }
  }
  return out;
}

const executablePath = process.env.PW_CHROMIUM;
const channel = arg("channel");
const headed = process.argv.includes("--headed");
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  ...(channel ? { channel } : {}),
  headless: !headed,
  // A window behind others still draws every frame (Chrome slows hidden pages' frames down).
  args: [
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
  ],
});

/** What draws WebGL in this browser: the graphics card's name, or SwiftShader (software, on the processor). */
async function webglRenderer() {
  const page = await browser.newPage();
  await page.goto(URL_BASE).catch(() => {
    process.stderr.write(`Nothing at ${URL_BASE}: build, then start \`npm run preview\` in another terminal.\n`);
    process.exit(1);
  });
  const name = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "no WebGL";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });
  await page.close();
  return name;
}
const gpu = await webglRenderer();
process.stderr.write(`WebGL drawn by: ${gpu}\n`);
if (/swiftshader|llvmpipe|software/i.test(gpu))
  process.stderr.write("  (software: WebGL times won't say what a graphics card does; try --headed)\n");
const only = arg("only");
const files = readdirSync(PROGRAMS)
  .filter((name) => /\.(js|py)$/.test(name) && (!only || name.includes(only)))
  .sort();
if (process.argv.includes("--zooms")) {
  const rows = await zoomSuite(browser, files);
  await browser.close();
  const f = (n) => (n === undefined || n === null ? "–" : n.toFixed(0));
  const lines = [
    `| Program | Renderer | ${ZOOMS.map(([z]) => `${z}: step / drawing / pan frame`).join(" | ")} |`,
    `| --- | --- | ${ZOOMS.map(() => "---").join(" | ")} |`,
  ];
  for (const r of rows.filter((x) => x.lod)) {
    const off = rows.find((x) => !x.lod && x.program === r.program && x.renderer === r.renderer);
    const cell = ([z]) => {
      const on = r.zooms[z];
      const was = off?.zooms[z];
      return `${f(on?.step)} / ${f(on?.draw)} / ${f(on?.pan)} ms (without: ${f(was?.step)} / ${f(was?.draw)} / ${f(was?.pan)})`;
    };
    lines.push(`| ${r.program} | ${r.renderer} | ${ZOOMS.map(cell).join(" | ")} |`);
  }
  console.log(`WebGL drawn by: ${gpu}\n`);
  console.log(lines.join("\n"));
  const save = arg("save");
  if (save) writeFileSync(join(RESULTS, `zooms-${save}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  process.exit(0);
}

const results = [];
for (const file of files) {
  const language = file.endsWith(".py") ? "python" : "javascript";
  const code = readFileSync(join(PROGRAMS, file), "utf8");
  const result = { program: file, gpu, views: {} };
  for (const renderer of ["svg", "canvas", "webgl"]) {
    process.stderr.write(`${file} (${renderer})…\n`);
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (e) => process.stderr.write(`  page error: ${e.message}\n`));
    try {
      const loadMs = await open(page, language, code, renderer);
      if (renderer === "svg") {
        const run = await page.evaluate(() => {
          const p = window.__pr0l1nePerf;
          const s = p.summary();
          return {
            trace: p.lastTrace,
            run: s["run.trace"]?.max,
            prepare: s["run.prepare"]?.max,
            show: s["run.show"]?.max,
          };
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
  "| Program | Run | Steps | Objects: most | Step, SVG arrows / nested | Step, canvas arrows / nested | Step, WebGL arrows / nested | Layout arrows | Routing | SVG patch | Canvas paint | WebGL paint |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
for (const r of results) {
  const o = old.get(r.program);
  const v = r.views;
  const ov = o?.views ?? {};
  const t = r.run?.trace;
  lines.push(
    `| ${r.program}${r.error ? ` (${r.error})` : ""} | ${vs(r.run?.run, o?.run?.run)} ms${t?.truncated ? ` (stopped: ${t.stoppedBy})` : ""} | ${t?.steps ?? "–"} | ${t?.maxHeap ?? "–"} | ${vs(v["svg.arrows"]?.frame, ov["svg.arrows"]?.frame)} / ${vs(v["svg.nested"]?.frame, ov["svg.nested"]?.frame)} ms | ${vs(v["canvas.arrows"]?.frame, ov["canvas.arrows"]?.frame)} / ${vs(v["canvas.nested"]?.frame, ov["canvas.nested"]?.frame)} ms | ${vs(v["webgl.arrows"]?.frame, ov["webgl.arrows"]?.frame)} / ${vs(v["webgl.nested"]?.frame, ov["webgl.nested"]?.frame)} ms | ${f(v["svg.arrows"]?.layout)} ms | ${f(v["svg.arrows"]?.route)} ms | ${f(v["svg.arrows"]?.patch)} ms | ${f(v["canvas.arrows"]?.paint)} ms | ${f(v["webgl.arrows"]?.paint)} ms |`,
  );
}
console.log(`WebGL drawn by: ${gpu}\n`);
console.log(lines.join("\n"));
const save = arg("save");
if (save) writeFileSync(join(RESULTS, `browser-${save}.json`), `${JSON.stringify(results, null, 2)}\n`);
