[← Docs index](README.md)

# Development

## Requirements

- **Node.js 22 or newer** and npm (check with `node --version`; the repo's `.nvmrc` says 22).
- **An internet connection** the first time you use Python. The page downloads Pyodide (about 6 MB compressed) from the jsDelivr CDN, and your browser caches it after that. JavaScript and TypeScript need no download.
- **A modern browser**: recent Chrome, Edge, Firefox or Safari. Code runs in ES module workers, which need Firefox 114+ or Safari 15+.
- **Optional: Python 3.12** if you want to run the Python tracer's tests or inspect Python traces from the command line. The app itself doesn't need Python installed, because Python runs inside the browser.

## Install and run

```bash
git clone https://github.com/D4YonSoundcloud/pr0-l1ne.git
cd pr0-l1ne
npm ci
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). The bubble sort example runs automatically.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the dev server with hot reload. |
| `npm run build` | Type-checks, then builds a static site into `dist/`. |
| `npm run preview` | Serves the built `dist/` folder locally. |
| `npm run typecheck` | Runs the TypeScript compiler without building. |
| `npm test` | Runs all tests: the TypeScript ones, then the Python tracer's under your Python and under Pyodide. |
| `npm run test:js` | Runs the Vitest suites: the JavaScript and TypeScript tracers (including generators, `async` and timers), hints, graphs, memory sizes, complexity estimates (every example, in all three languages), arrow routing, layout of every example, nesting, linked structures, animation and saved programs. |
| `npm run test:tracer` | Runs the Python tracer's unit tests (needs Python 3.12). |
| `npm run test:pyodide` | Runs the same tests (the tracer's and Measure's) inside Pyodide, the Python the browser runs, loaded from the `pyodide` npm package in Node. No local Python needed. |
| `npm run trace -- file.py` | Prints the JSON trace for a Python file (needs Python 3.12). |
| `npm run trace:js -- file.js` | Prints the JSON trace for a JavaScript or TypeScript file (`.ts` files are treated as TypeScript). |
| `npm run instrument -- file.js` | Prints the instrumented version of a JavaScript or TypeScript file. |
| `npm run schema` | Regenerates `schema/trace.schema.json` from `src/trace/types.ts`. Run it after changing the trace types; a test fails until you do. |
| `npm run test:golden` | Traces every example in all three languages and compares with `fixtures/traces/`. Add `-- -u` to accept intended changes. |
| `npm run test:coverage` | Runs the TypeScript tests with coverage (report in `coverage/js/index.html`), then the Python tests with coverage (`coverage/python/index.html`). Python coverage needs `pip install coverage`. |
| `npm run lint` | Checks formatting and lint rules: Biome for TypeScript, JavaScript, JSON, CSS and HTML, then Ruff and Pyright (types) for Python. Changes nothing. |
| `npm run format` | Fixes what can be fixed automatically: formats every file and applies safe lint fixes. |

The output of `npm run build` is plain static files. You can host `dist/` anywhere that serves static content (GitHub Pages, Netlify, an S3 bucket, `python3 -m http.server`).



## Testing

`npm test` runs every test: Vitest for TypeScript and JavaScript (including the golden traces), then the Python tests under your Python and under Pyodide.

### Golden traces

`src/examples/golden.test.ts` traces every example (38 Python, 39 JavaScript and 37 TypeScript) and compares each trace with a saved copy in `fixtures/traces/<language>/<example>.json`. Python runs in Pyodide, the same Python the browser uses.

- **A failing golden test means a tracer records something differently.** The diff shows which steps changed. If the change is a bug, fix it. If it's intended, accept it with `npm run test:golden -- -u` and commit the updated fixtures in the same pull request, so reviewers see exactly what moved.
- **The files are made for diffs.** The top of each file holds the trace's summary (loops, hints, output). Then each step takes one line and lists only the heap objects that changed since the step before.
- **They're repeatable.** Traces stop on the 20,000-step budget, never the clock. Python runs with `PYTHONHASHSEED=0` (as the app does), and sets of objects are listed in the order the tracer first saw them, so traces come out the same on every machine and every run.
- **A new example** gets its golden file the first time the test runs locally. In CI a missing file fails the test, so commit it with the example.

### Complexity shapes

The golden traces include each example's code shape (`Trace.cost`), but the examples don't reach every path of the Python analysis. `fixtures/shapes/python.json` holds programs that do (loops over `a + b`, recursion that halves, `heappush`, memoized functions...) with the shape recorded for each. `test_shape.py` checks every one is unchanged, on your Python and in Pyodide. If you change the analysis on purpose, record the new shapes with `UPDATE_SHAPES=1 npm run test:tracer` and review the diff. To cover a new path, add a program to the file's `programs` and record.


### The trace contract

The trace (`src/trace/types.ts`) is what the tracers and the rest of the app agree on. Three things keep it honest:

- **A schema.** `schema/trace.schema.json` is generated from `types.ts` with `npm run schema`. `src/trace/schema.test.ts` fails if it's out of date, so a change to the format always shows up in review. The rules for versions (what counts as breaking, and when `version` goes to 2) are at the top of `types.ts`.
- **Checks against it.** Every golden trace and every conformance trace is validated in the tests. In development builds (`npm run dev`), `src/worker/runner.ts` also checks every trace a worker sends. A bad trace then fails right away with a banner naming the field (`steps[3].heap.o4: needs "items"`), and the full trace in the console. Production builds leave the check, the validator and the schema out.
- **A conformance suite.** `src/trace/conformance.cases.ts` holds 32 small programs written in both Python and JavaScript. `conformance.test.ts` traces each pair and checks both have the same shape (`src/trace/shape.ts`): the output, how the program ended, loops and their passes (including which passes a sampled loop kept), and the final globals with every object and link they reach. Type names, sizes, ids and step counts aren't compared, since the languages differ there on purpose. If the two tracers drift apart, a case fails. To add a case, follow the notes at the top of `conformance.cases.ts`.

### Coverage

`npm run test:coverage` reports which lines the tests run. Use it as a map of untested code, not a score to chase.

Python pauses all other tracing and monitoring while a trace hook runs, so a coverage tool never sees code that runs inside the tracer's own hook. So the tracer keeps as little as possible there: `Tracer.trace()` hands each event to methods that the tests also call directly, on frames of a program's own code (`test_tracer.py`, `HookTests`), and sampling (`sampling.py`) is driven by hand in `test_sampling.py`. Only `trace()` itself shows as "missing"; every trace runs it, and the golden traces check what it records. Each of the other Python modules has its own test file: `test_analysis.py`, `test_shape.py`, `test_serializer.py`, `test_sizes.py`, `test_steplog.py` and `test_virtual_asyncio.py`.



## How the app is put together

`src/main.ts` only creates the pieces and connects them. Each piece owns one part of the page:

| File | What it does |
| --- | --- |
| `src/settings.ts` | Everything saved between visits (see "Saved settings") |
| `src/app/store.ts` | A small store: one state object, changed by named actions, with listeners |
| `src/app/state.ts` | The app's state (`language`, the open `program`, `stepIndex`, `playing`, `speed`, the `trace` on screen, the `tracedCode` it came from, whether it's `stale`, and whether Measure is `measuring`) and its actions (`setLanguage`, `setProgram`, `setStep`, `setPlaying`, `setSpeed`, `showTrace`, `markStale`, `setMeasuring`), which also save what's remembered |
| `src/app/elements.ts` | Finds the page's elements (`index.html`) once, by id |
| `src/app/programsController.ts` | Saved programs: the Open menu, Save, Save as, Delete, the save dialog and the unsaved-changes dot |
| `src/app/playbackController.ts` | Moving through the steps: first / previous / next / last, the scrubber, Play and the speed menu, and the stepping keys (arrows, Home / End, Space, F10, Ctrl/Cmd + Enter) |
| `src/app/runController.ts` | Running code: one runner per language, started when first needed; the time budgets for Live and Run; queuing edits that arrive mid-run; the status text; and turning each result into the state, the banner and the editor's error marks |
| `src/app/measureController.ts` | Measure and growth runs: the Measure and results buttons, the Measure panel and its growth section, the time limit, the editor's count labels, and the last measurement (shown only in its language, and only while the code still matches) |
| `src/app/stepView.ts` | Drawing the step on screen: the step label, both canvas windows, the output so far and the editor's line marks |
| `src/app/memoryController.ts` | The memory view: dragging boxes and Reset layout, hover highlighting, arrows or nested, memory sizes and their model, and output on the canvas |
| `src/app/loopController.ts` | Loop history: the loop tabs, stacked or animated, collapsing passes with no changes, and stacking vertically |
| `src/app/styleController.ts` | The Style panel and the appearance it edits, and how long each window's step animation runs |
| `src/app/complexityController.ts` | The complexity chip and panel, and the cost labels beside loops and functions |
| `src/app/layout.ts` | The two dividers (drag, arrow keys, double-click to reset) and swapping the editor and canvas sides |
| `src/app/shortcuts.ts` | The keys that work anywhere outside the editor: Run, Measure, Save, Save as, and the stepping keys |
| `src/app/banner.ts` | The banner above the canvas, and its Run / Measure buttons |
| `src/app/html.ts` | `escapeHtml`, for text put into the banner and panels |
| `src/app/autoFit.ts` | Reads a window's remembered auto-fit setting |
| `src/app/testHelpers.ts` | Helpers for the controllers' tests: a storage stand-in, app state, tracing JavaScript, timers run by hand |

How the pieces talk:

- **Controllers read the state** with `app.get()`.
- **They change it only through actions.** For example, `app.setLanguage("python")` also reopens the program that was open in Python, and forgets the trace.
- **They react to changes themselves** with `app.watch(...)`. When the language changes, the run controller drops a waiting Live run, Measure stops and shows that language's results, the canvas windows start afresh and the Open menu refills, without `main.ts` calling each of them. The complexity estimate is redone whenever the trace changes.
- **Each controller takes its page elements (by their ids' names) and helpers as arguments,** so its tests (`*.test.ts` beside it, in a jsdom page) build a small page and check what a person would see. `main.ts` passes the whole page (`els`); each takes the elements it names.
- **Controllers that need each other get a function, not the object** (`animation: () => style.animationFor("memory")`), so they can be created in any order. A controller mustn't call these while it's being constructed: what they reach may not exist yet.
- **`src/app/elements.test.ts` guards the page itself.** It loads `index.html` and checks every element the app looks up is there; a missing one would stop the app as it starts.

## Saved settings

Everything the app remembers between visits (the language, the code, saved programs, panel sizes, the Style panel, playback speed...) is defined in `src/settings.ts`. Nothing else reads or writes `localStorage`.

- **Reading and writing:** `settings.speed.get()`, `settings.code("python").set(code)`. Each setting has a type and a default, so a missing or garbled saved value comes back as the default.
- **Keys** are `pr0l1ne:<name>`. Before settings version 1 they were `algoviz:<name>`. The first visit after the change copies every old key over once, and leaves the old keys in place so an older build still works.
- **Changing a key or format:** bump `SETTINGS_VERSION` and add a step to `MIGRATIONS`, so people keep what they saved. Add a test for it in `settings.test.ts`.
- **When storage is unavailable** (some privacy modes), settings last for the visit only.

## Code style

Formatting and lint rules are automatic, so nobody has to think about spacing or argue about style:

| Tool | Checks | Config |
| --- | --- | --- |
| [Biome](https://biomejs.dev/) | TypeScript, JavaScript, JSON, CSS and HTML: formatting, lint rules, sorted imports | `biome.json` |
| [Ruff](https://docs.astral.sh/ruff/) | Python in `src/worker/`: formatting and lint rules | `pyproject.toml` |
| [Pyright](https://microsoft.github.io/pyright/) | Python types, in basic mode (installed by npm, no Python setup needed) | `pyproject.toml` |
| [Lefthook](https://lefthook.dev/) | Runs Biome and Ruff on the files you commit, and both typecheckers before you push | `lefthook.yml` |
| EditorConfig | Indentation and line endings for editors | `.editorconfig` |

The style: 2-space indents (4 in Python), double quotes, semicolons, trailing commas, lines up to 120 characters.

**Hooks.** `npm ci` installs the git hooks. Each commit formats and fixes the staged files and adds the fixes to the commit; each push type-checks the project (TypeScript with `tsc`, Python with Pyright). Ruff is a Python tool, so install it once with `pip install ruff` (or `pipx install ruff`); without it, the hook skips the Python files with a note. To skip the hooks once, use `git commit --no-verify`.

**Editors.** VS Code suggests the Biome, Ruff and EditorConfig extensions when you open the project (`.vscode/extensions.json`). With them, files format on save the same way the hooks do.

**Lint rules.** Biome's recommended rules, with two changes in `biome.json`:

- `noNonNullAssertion` is off: the code uses `!` deliberately where TypeScript can't see that a value exists.
- In CSS, `noDescendingSpecificity` and `noImportantStyles` are off: some rules must override the Monaco editor's own styles.

Ruff checks errors (`E4`, `E7`, `E9`, `F`), likely bugs (`B`), import order (`I`), modern syntax (`UP`) and complexity (`C90`: a function with more than 10 branches is split into named steps); `pyproject.toml` lists the two rules it skips and why. The functions over that limit when the check was turned on are marked `# noqa: C901 (W4 splits it)`, and the marks go as the code health plan's W4 splits them.

Pyright checks Python types in basic mode. Where it can't follow the code (asyncio's private event loop slots, which the tracer sets on purpose), the line says so with `# pyright: ignore[rule]` and a comment above it.

A rule that's wrong for one line is silenced on that line with a reason, for example `// biome-ignore lint/complexity/noBannedTypes: keys are the user's own functions`, never turned off for the whole project.

**`git blame` and the big format.** The commit that first formatted the whole codebase is listed in `.git-blame-ignore-revs`, so `git blame` and GitHub's blame view skip it and show who last really changed each line. Locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

## Deploying

The site is hosted on [Cloudflare Pages](https://developers.cloudflare.com/pages/), connected to this GitHub repo. Cloudflare builds and deploys on its own:

| Event | Where it goes |
| --- | --- |
| Push to `main` | Production: https://pr0l1ne.pages.dev |
| Any other branch, or a pull request | A preview at `https://<branch>.pr0l1ne.pages.dev`, linked on the PR |

Cloudflare only builds; it doesn't run the tests. `.github/workflows/ci.yml` runs them (and the same build) on every pull request and push to `main`. Requiring that check before merging into `main` (Settings → Rules → Rulesets) means only tested code reaches the live site.

`public/_headers` sets caching (built files are kept for a year, the page itself is re-checked on every visit) and basic security headers.

### One-time setup

1. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, and authorize GitHub for `D4YonSoundcloud/pr0-l1ne`.
2. Build settings:

    | Setting | Value |
    | --- | --- |
    | Project name | `pr0l1ne` (gives `pr0l1ne.pages.dev`) |
    | Production branch | `main` |
    | Framework preset | None (or Vite) |
    | Build command | `npm run build` |
    | Build output directory | `dist` |
    | Environment variable | `NODE_VERSION` = `22` |

3. **Save and Deploy.** The first build takes a few minutes; later ones redeploy on every push.
4. If something goes wrong after a deploy, open the project's **Deployments** list and use **Rollback** on the last good one.

If the name `pr0l1ne` is taken, Cloudflare gives a slightly different address: update the links in this file and the README.

## Project structure

```
pr0-l1ne/
├── index.html                  Page layout: toolbar, editor, canvas, timeline
├── package.json
├── tsconfig.json               TypeScript config for the app
├── tsconfig.node.json          ...and for Node-only code (the CLI, Node-run tests)
├── vite.config.ts
├── docs/                       Images used in this README
├── scripts/
│   └── test-pyodide.mjs        Runs the Python tracer's tests inside Pyodide
└── src/
    ├── main.ts                 Creates the state and controllers and connects them
    ├── app/                    The app's state and controllers (see "How the app is put together")
    ├── languages.ts            Per-language worker, Monaco mode and examples
    ├── programs.ts             Saved programs (localStorage)
    ├── programs.test.ts        Saved program tests
    ├── monaco.ts               Lean Monaco build: editor features + 3 languages
    ├── editor.ts               Monaco setup, theme, commands and line markers
    ├── appearance.ts           Canvas style settings, presets, applying them
    ├── appearance.test.ts      Style settings tests
    ├── stylePanel.ts           The Style panel in the toolbar
    ├── complexityPanel.ts      The complexity chip, its panel and the editor labels
    ├── measurePanel.ts         Measure's results panel and the editor heat map
    ├── growthView.ts           "How it grows": growth runs' charts and comparisons
    ├── examples/
    │   ├── index.ts            The Example type (group, name, code)
    │   ├── python.ts           Python examples, grouped by topic
    │   ├── javascript.ts       JavaScript examples
    │   └── typescript.ts       TypeScript examples
    ├── styles.css              All styles, including the SVG diagram styles
    ├── trace/
    │   ├── types.ts            The trace format (the tracer/renderer contract)
    │   ├── diff.ts             What changed between two steps
    │   ├── loopHistory.ts      Group steps into loop iterations
    │   ├── hints.ts            Parse and apply viz: comment hints
    │   ├── hints.test.ts       Hint tests (all three languages)
    │   ├── linked.ts           Linked lists and trees (loop history and memory)
    │   ├── linked.test.ts      Linked structure tests
    │   ├── graph.ts            Graphs: detection, the algorithm's state, layout
    │   ├── graph.test.ts       Graph tests
    │   ├── output.ts           What a step printed (text, line, printed objects)
    │   ├── measurement.ts      What a Measure run reports, and formatting it
    │   ├── growth.ts           Growth runs: size hints, the ladder, fitting, the code's estimate
    │   ├── growth.test.ts      Growth tests
    │   ├── delta.ts            Rebuilding heaps sent as deltas; deep equality
    │   ├── memory.ts           Memory sizes: the Python, textbook and V8 models
    │   ├── memory.test.ts      Memory size tests
    │   ├── bigO.ts             Big-O expressions: add, multiply, simplify, format
    │   ├── bigO.test.ts        Big-O tests
    │   ├── complexity.ts       Time and space estimates: the code's shape plus the run
    │   └── complexity.test.ts  Every example's complexity, in all three languages
    ├── render/
    │   ├── draw.ts             SVG helpers, metrics, cells, arrows, pointers
    │   ├── memory.ts           The memory view (arrows or nested, draggable boxes)
    │   ├── memory.test.ts      Tests for choosing what to nest
    │   ├── route.ts            Arrow routing and non-overlapping placement
    │   ├── route.test.ts       Routing tests
    │   ├── layout.test.ts      Every example, every step: no overlaps or crossings
    │   ├── loopView.ts         The loop history view (stacked or animated)
    │   ├── graphView.ts        Drawing a graph, for both views
    │   ├── animate.ts          FLIP tweening between two drawings
    │   ├── animate.test.ts     Animation tests (jsdom)
    │   └── viewport.ts         Pan, zoom and node dragging for both sections
    ├── js/
    │   ├── instrument.ts       Rewrites JavaScript to report on itself (Babel)
    │   ├── cost.ts             The code's shape, for complexity estimates
    │   ├── measure.ts          Measure: run at full size with counters
    │   ├── measure.test.ts     Measure tests
    │   ├── typescript.ts       Strips TypeScript types, then instruments as JS
    │   ├── runtime.ts          Records steps: shadow stack, loops, serialization
    │   ├── trace.ts            traceJavaScript(): instrument, run, return a Trace
    │   ├── serve.ts            Worker side of the protocol, shared by JS and TS
    │   ├── javascript.worker.ts  Entry point for the JavaScript worker
    │   ├── typescript.worker.ts  Entry point for the TypeScript worker
    │   ├── cli.ts              npm run instrument / trace:js
    │   ├── trace.test.ts       JavaScript tracer tests (Vitest)
    │   ├── async.test.ts       Generators, async, timers and the event loop
    │   └── typescript.test.ts  TypeScript tracer tests (Vitest)
    └── worker/
        ├── protocol.ts         Message types between page and workers
        ├── runner.ts           Starts a worker, runs code, watchdog
        ├── pyodide.worker.ts   Loads Pyodide and the tracer, answers runs
        ├── pythonModules.ts    Writes the Python modules into Pyodide and imports them
        ├── tracer.py           The Python tracer: the settrace hook and the run
        ├── sampling.py         Which passes of long loops are recorded
        ├── steplog.py          Recorded steps, with heaps as deltas
        ├── virtual_asyncio.py  asyncio on a virtual clock (tracer and Measure)
        ├── analysis.py         Read before running: hints, loops, index names
        ├── shape.py            The code's shape for complexity: the tree per function
        ├── shape_names.py      ...what size each name stands for
        ├── shape_loops.py      ...how many passes a while loop makes
        ├── shape_costs.py      ...what expressions and calls cost
        ├── serialize.py        Python values -> trace values and heap objects
        ├── sizes.py            Memory sizes, as a 64-bit Python reports them
        ├── test_*.py           Python tests, one file per module
        └── measure.py          Measure for Python: run at full size with counters
```

The diagram styling lives in the `/* diagrams */` section of `styles.css`. Every color, line weight and corner radius there is a CSS custom property. The Style panel sets them (see [Styling](how-it-works.md#14-styling)), and the defaults on `:root` match the Graph paper theme. To add a theme, add an entry to `PRESETS` in `appearance.ts`.

---

## Development workflow

**Changing the tracer.** `tracer.py` is ordinary Python, so the fastest loop is outside the browser:

```bash
# See the trace for a program
npm run trace -- path/to/program.py | python3 -m json.tool | less

# Run the tests under your Python, then under Pyodide (the browser's Python)
npm run test:tracer
npm run test:pyodide
```

Use Python 3.12 locally to match Pyodide 0.27's interpreter, and run `npm run test:pyodide` before you're done: it runs the same tests in the real browser runtime, which is 32-bit and differs in small ways (that's how a Python 3.12 difference in where generators pause was caught). Line-event behavior (which lines fire, and when) can differ slightly between Python versions, and loop detection depends on it. Vite reloads the worker when `tracer.py` changes, so the browser picks up edits automatically.

**Changing the JavaScript or TypeScript tracer.** Everything in `src/js/` except the worker entry points runs in Node, so you can work on it without a browser. The CLI picks TypeScript for `.ts` files:

```bash
# See what your code turns into
npm run instrument -- path/to/program.js

# See the trace
npm run trace:js -- path/to/program.js | less

# Run the tests (add --watch to re-run on save)
npm run test:js
```

When something looks wrong in the canvas, `npm run instrument` is usually the quickest way to see why: the output is readable, and every `__av.` call corresponds to one recorded event. For TypeScript, it also shows you the JavaScript the types were stripped down to.

Node can hide browser-only problems. Node has `process` and real built-in modules, and a browser doesn't, so a dependency that leans on them works in tests but fails in the worker. When you add or upgrade dependencies used by a worker, run `npm run build` and test the built worker in the browser.

**Changing the renderer.** Edit the files in `src/render/`. Vite hot-reloads the page. Because rendering is a pure function of `(trace, stepIndex)`, you can paste a trace JSON into a test page or a unit test and render it without running any code.

**Upgrading Pyodide.** Change `PYODIDE_VERSION` in `pyodide.worker.ts`. Check which Python version the new release ships, run the tracer tests under that version, and keep the "use Python 3.X locally" note above in sync.

---

## Extending it

### Draw a new kind of object

Say you want sets drawn as bubbles or tuples drawn differently:

1. **Tracers**: add a branch to `Serializer.describe()` in `serialize.py` (Python) and in `runtime.ts` (JavaScript) that returns a new `kind`.
2. **Types**: add the shape to the `HeapObject` union in `trace/types.ts`. TypeScript will then point out every `switch` that needs a case.
3. **Diff**: teach `slotsOf()` in `diff.ts` what the object's slots are, so changes get highlighted.
4. **Render**: add a shape builder in `memory.ts` (and, if it's a container, handle it in `cellsOf()` in `loopView.ts`).

### Add a structure-specific layout

Binary trees (`findTreeBlocks()` in `memory.ts`) and graphs (`graphBoxes()`) already have their own layouts in the memory view, using two patterns. A tree is measured as one block that the column walk places like a single wide box, with each node then put at its slot inside it. A graph is a single box drawn in place of a host object, with the other members aliased to it. Either pattern works for a new shape. For bigger graphs, a layout library such as [ELK.js](https://github.com/kieler/elkjs) or [dagre](https://github.com/dagrejs/dagre) could replace `computeLayout()` in `graph.ts`. Everything downstream only needs a position per node.

### Teach graphs a new kind of state

`graphOverlay()` in `trace/graph.ts` decides what each variable means for a graph. To draw something new (say, a `color` dict for graph coloring as actual colors), add a field to `GraphOverlay`, fill it in the loop over variables, and draw it in `graphPicture()`. Add a line to `legendItems()` too, and to `nodeSignature()` so changes get highlighted.

### Add a hint

1. Add the keyword to `KEYWORDS` in [`trace/hints.ts`](../src/trace/hints.ts), parse it in `parseHints()` into a new field of `VizHints` (in `trace/types.ts`), and warn with the expected form when it doesn't parse.
2. Use it: either in `applyHints()`, if it changes the trace itself (like `hide`), or in a renderer through `trace.viz` (like `show`).
3. Add a case to `hints.test.ts` and document it in the [Hints](hints.md#hints-viz-comments) table.

No tracer needs to change, since they pass every `viz:` comment through as text.

### Add another language

Everything after the worker only depends on the trace format, so any language works if something can produce that JSON. The tracers here show the three main strategies. If the language's runtime has a tracing hook, like Python's `sys.settrace`, use it. If not, rewrite the program to report on itself, like the JavaScript tracer does. And if the language compiles to one that's already supported, compile it first and keep the line numbers, like the TypeScript tracer does. The language also needs to run in the browser, either natively or compiled to WebAssembly, unless you add a server.
