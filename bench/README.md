# Benchmarks

Programs much bigger than the examples, and two scripts that time what
PR0L1NE does with them: tracing, and drawing steps. They're for comparing
before and after a change to the tracers or the drawing, not a test that
passes or fails.

## The programs

`programs/` has each program in JavaScript and Python (the last one only in
Python):

| Program | What it stresses |
| --- | --- |
| `1-long-list` | A 2,000-node linked list, then a walk down it: a long chain of objects, very wide in Arrows mode |
| `2-big-tree` | A balanced search tree of 1,023 nodes, built by recursive inserts, then a search: tree layout, and many short calls |
| `3-big-grid` | A 60 × 60 grid filled by dynamic programming, with a heatmap: 3,600 cells, and a loop history of grids |
| `4-dense-graph` | 400 nodes with about 2,400 edges, then a breadth-first search: graph layout and edges |
| `5-deep-recursion` | Recursion 400 calls deep, each call making a list the next points to: a deep call stack |
| `6-everything` | 300 records with orders, a second index into the same records, and a 40 × 40 shortest-path grid: everything at once |

## Outside the browser

```sh
npx tsx scripts/bench.ts                     # print the numbers
npx tsx scripts/bench.ts --save baseline     # and keep them in results/baseline.json
npx tsx scripts/bench.ts --compare baseline  # beside a saved run
npx tsx scripts/bench.ts --only grid         # programs whose name has "grid"
```

Each program is traced with the app's own budget and time limit
(`src/trace/policy.ts`): JavaScript in this process, Python with the real
tracer in CPython (timed inside Python, so starting Python isn't counted;
**Read it** is reading its JSON and rebuilding heaps, as the Python worker
does). Then six of its steps (spread through the run, and the one with the
most objects) are drawn in both memory modes, and their loop history. The
times are medians over those steps. **Trace size** is what crosses from the
tracer to the page: Python's JSON, or a structured clone of a JavaScript
trace.

CPython is several times faster than Pyodide, so Python's numbers here are
the tracer's own speed, not what the page sees: the browser benchmark has
that.

## In the browser

```sh
npm run build && npm run build:runner
npm run preview                                    # in another terminal
node scripts/bench-browser.mjs                     # print the numbers
node scripts/bench-browser.mjs --save baseline     # and keep them in results/browser-baseline.json
node scripts/bench-browser.mjs --compare baseline  # beside a saved run
PW_CHROMIUM=/path/to/chrome node scripts/bench-browser.mjs  # a Chromium of your own
```

Each program is run by the page itself (Python in Pyodide), opened with
`?perf`, which turns on the timing of each stage (`src/perf.ts`). Then eight
steps spread through the run are shown in each renderer (SVG and canvas) and
each memory mode, with animation off. **Step** is the time from asking for a
step to the frame after it's drawn; the stage times are medians from
`src/perf.ts`.

### At each zoom

```sh
node scripts/bench-browser.mjs --zooms                # steps and drawing at 100%, 41%, 21%, 5.5% and 1%
node scripts/bench-browser.mjs --zooms --save phase2  # and keep them in results/zooms-phase2.json
```

Each program is opened twice, with levels of detail (`src/render/lod.ts`)
and without (`?nolod`, which keeps every zoom at full detail), in each
renderer. At each zoom it steps through the run as above, and times panning
(the median frame while it pans). **Step** is the whole step as above;
**drawing** is only the renderer's part (SVG's patch, or canvas's paint),
which is what the levels change: the layout before it is the same at any
zoom.

## Timing a stage

`timed("stage", () => work())` (src/perf.ts) records how long `work` takes
when timing is on (`perf.on`, or the page opened with `?perf`), and is a
plain call otherwise. The page's timings are `window.__pr0l1nePerf`:
`summary()` gives each stage's count, median, 90th percentile and largest
time.
