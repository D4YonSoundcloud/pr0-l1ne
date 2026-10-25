[← Docs index](README.md)

# Development

## Requirements

- **Node.js 22 or newer** and npm (check with `node --version`; the repo's `.nvmrc` says 22).
- **No network needed for Python.** Pyodide comes from the `pyodide` npm package, and the code runner serves it (about 6 MB compressed, cached by the browser after the first time). JavaScript and TypeScript need no download.
- **A modern browser**: recent Chrome, Edge, Firefox or Safari. Code runs in ES module workers, which need Firefox 114+ or Safari 15+.
- **Optional: Python 3.12** if you want to run the Python tracer's tests or inspect Python traces from the command line. The app itself doesn't need Python installed, because Python runs inside the browser.

## Install and run

```bash
git clone https://github.com/D4YonSoundcloud/pr0-l1ne.git
cd pr0-l1ne
npm ci
npm run dev
```

Open the URL it prints for PR0L1NE (http://localhost:5173). The bubble sort example runs automatically. `npm run dev` starts two dev servers: the app, and the code runner (http://127.0.0.1:5174) that programs run in. They're two sites, as they are when deployed; see [Security](how-it-works.md#security-running-other-peoples-code) in how-it-works.md.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the dev servers with hot reload: the app (http://localhost:5173) and the code runner (http://127.0.0.1:5174). |
| `npm run build` | Type-checks, then builds the app into `dist/`, with the docs site in `dist/docs/`. |
| `npm run docs:dev` | Serves the docs site with hot reload (http://localhost:5175/docs/). Edit any page in `docs/` and it updates. |
| `npm run docs:build` | Builds only the docs site into `dist/docs/`, and allows its inline scripts in `dist/_headers` (see Deploying). `npm run build` runs it. |
| `npm run build:runner` | Builds the code runner into `dist-runner/`: its page, the three language workers, Pyodide, and its `_headers`. |
| `npm run preview` | Serves both builds locally: the app (http://localhost:4173) and the runner (http://127.0.0.1:4174). Run both builds first. Built anywhere but Cloudflare, the app talks to this local runner. |
| `npm run typecheck` | Runs the TypeScript compiler without building. |
| `npm test` | Runs all tests: the TypeScript ones, then the Python tracer's under your Python and under Pyodide. |
| `npm run test:js` | Runs the Vitest suites: the JavaScript and TypeScript tracers (including generators, `async` and timers), hints, graphs, memory sizes, complexity estimates (every example, in all three languages), arrow routing, layout of every example, nesting, linked structures, animation and saved programs. |
| `npm run test:tracer` | Runs the Python tracer's unit tests (needs Python 3.12). |
| `npm run test:e2e` | Browser tests of the sandbox, the app's security policy, share links and SQL (`e2e/`, Playwright), against both builds: run `npm run build && npm run build:runner` first, and `npx playwright install` once for the browsers. `--project=chromium` for one browser. |
| `npm run test:pyodide` | Runs the same tests (the tracer's and Measure's) inside Pyodide, the Python the browser runs, loaded from the `pyodide` npm package in Node. No local Python needed. |
| `npm run trace -- file.py` | Prints the JSON trace for a Python file (needs Python 3.12). |
| `npm run trace:js -- file.js` | Prints the JSON trace for a JavaScript or TypeScript file (`.ts` files are treated as TypeScript). |
| `npm run instrument -- file.js` | Prints the instrumented version of a JavaScript or TypeScript file. |
| `npm run schema` | Regenerates `schema/trace.schema.json` from `src/trace/types.ts`, and `fixtures/policy.json` from `src/trace/policy.ts`. Run it after changing either; a test fails until you do. |
| `npm run test:golden` | Traces every example in all three languages and compares with `fixtures/traces/`. Add `-- -u` to accept intended changes. |
| `npm run test:coverage` | Runs the TypeScript tests with coverage (report in `coverage/js/index.html`), then the Python tests with coverage (`coverage/python/index.html`). Python coverage needs `pip install coverage`. |
| `npm run lint` | Checks formatting and lint rules: Biome for TypeScript, JavaScript, JSON, CSS and HTML, then Ruff and Pyright (types) for Python. Changes nothing. |
| `npm run format` | Fixes what can be fixed automatically: formats every file and applies safe lint fixes. |

Both builds are plain static files. You can host them anywhere that serves static content (GitHub Pages, Netlify, an S3 bucket), as long as they're on **two different sites** (two registrable domains, not two subdomains of one) and the runner's files are served with its headers (`dist-runner/_headers` lists them). Build the app with `VITE_RUNNER_URL` set to where the runner is, and the runner with `RUNNER_APP_ORIGINS` set to where the app is (see `src/sandbox/origins.ts`).



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

- **One policy.** The step budget, the time limits and the sampling rules are defined once, in `src/trace/policy.ts`. The app sends the budget and the sampling rules with every run (the `run` message in `worker/protocol.ts`), and both tracers take them as parameters, so neither has numbers of its own. The Python tracer, run outside the app (`npm run trace`, `npm run test:tracer`), reads the same policy from `fixtures/policy.json`, which `npm run schema` writes and `src/trace/policy.test.ts` checks. The conformance suite traces two 10,000-pass loops with the app's policy and with another one, and checks both tracers keep the same passes.
- **A schema.** `schema/trace.schema.json` is generated from `types.ts` with `npm run schema`. `src/trace/schema.test.ts` fails if it's out of date, so a change to the format always shows up in review. The rules for versions (what counts as breaking, and when `version` goes to 2) are at the top of `types.ts`.
- **Checks against it.** Every golden trace and every conformance trace is validated in the tests. In development builds (`npm run dev`), `src/worker/runner.ts` also checks every trace a worker sends. A bad trace then fails right away with a banner naming the field (`steps[3].heap.o4: needs "items"`), and the full trace in the console. Production builds leave the check, the validator and the schema out.
- **A conformance suite.** `src/trace/conformance.cases.ts` holds 32 small programs written in both Python and JavaScript. `conformance.test.ts` traces each pair and checks both have the same shape (`src/trace/shape.ts`): the output, how the program ended, loops and their passes (including which passes a sampled loop kept), and the final globals with every object and link they reach. Type names, sizes, ids and step counts aren't compared, since the languages differ there on purpose. If the two tracers drift apart, a case fails. To add a case, follow the notes at the top of `conformance.cases.ts`.

### Coverage

`npm run test:coverage` reports which lines the tests run. Use it as a map of untested code, not a score to chase.

Python pauses all other tracing and monitoring while a trace hook runs, so a coverage tool never sees code that runs inside the tracer's own hook. So the tracer keeps as little as possible there: `Tracer.trace()` hands each event to methods that the tests also call directly, on frames of a program's own code (`test_hooks.py`), and sampling (`sampling.py`) is driven by hand in `test_sampling.py`. Only `trace()` itself shows as "missing"; every trace runs it, and the golden traces check what it records. `test_tracer.py` traces whole programs end to end. Each of the other Python modules has its own test file: `test_analysis.py`, `test_shape.py`, `test_serializer.py`, `test_sizes.py`, `test_steplog.py`, `test_virtual_asyncio.py` and `test_measure.py`.

The JavaScript tracer has no such blind spot, so its modules are tested both end to end (`trace.test.ts`, `async.test.ts`) and directly (`inspector.test.ts`, `sampling.test.ts`, `instrument.test.ts`, `cost.test.ts`). The cost tables in `src/js/costs/` are tested entry by entry: `checkTable()` in `tableTests.ts` writes a call to each method and checks the estimate does what the entry says (a loop, a linear or n log n operation, a copy, growth, a result as long as its receiver). A new method goes in its table and is tested from there. Every file in `src/js/` has at least 80% of its branches covered.



## How the app is put together

`src/main.ts` only creates the pieces and connects them. Each piece owns one part of the page:

| File | What it does |
| --- | --- |
| `src/settings.ts` | Everything saved between visits (see "Saved settings") |
| `src/app/store.ts` | A small store: one state object, changed by named actions, with listeners |
| `src/app/state.ts` | The app's state (`language`, the open `program`, `stepIndex`, `playing`, `speed`, the `trace` on screen, the `tracedCode` it came from, whether it's `stale`, and whether Measure is `measuring`) and its actions (`setLanguage`, `setProgram`, `setStep`, `setPlaying`, `setSpeed`, `showTrace`, `markStale`, `setMeasuring`), which also save what's remembered |
| `src/app/elements.ts` | Finds the page's elements (`index.html`) once, by id |
| `src/app/programsController.ts` | Saved programs: the Open menu, Save, Save as, Delete, the save dialog and the unsaved-changes dot |
| `src/app/shareController.ts` | Share links: the Share button, and opening a link as a shared program that runs nothing until asked |
| `src/app/languageKind.ts` | The page for a program's languages or for SQL: the windows' names, and the controls that only one kind has |
| `src/app/csvImport.ts` | SQL's Import CSV button: a CSV file's table added to the program (`src/sql/csv.ts` writes it) |
| `src/app/playbackController.ts` | Moving through the steps: first / previous / next / last, the scrubber, Play and the speed menu, and the stepping keys (arrows, Home / End, Space, F10, Ctrl/Cmd + Enter) |
| `src/app/runController.ts` | Running code: one runner per language, started when first needed; the time budgets for Live and Run; queuing edits that arrive mid-run; the status text; and turning each result into the state, the banner and the editor's error marks |
| `src/app/measureController.ts` | Measure and growth runs: the Measure and results buttons, the Measure panel and its growth section, the time limit, the editor's count labels, and the last measurement (shown only in its language, and only while the code still matches) |
| `src/app/stepView.ts` | Drawing the step on screen: the step label, both canvas windows, the output so far and the editor's line marks |
| `src/app/memoryController.ts` | The memory view: builds the step's scene (arrows or nested, memory sizes and their model, output on the canvas) and hands it to the window's renderer; Reset layout |
| `src/app/loopController.ts` | Loop history: the loop tabs, stacked or animated, collapsing passes with no changes, and stacking vertically; builds the loop's scene and hands it to the window's renderer |
| `src/app/styleController.ts` | The Style panel and the appearance it edits (applied to each window's renderer with `setAppearance`), and how long each window's step animation runs |
| `src/app/spacingController.ts` | The Layout panel and the spacing it edits (`render/spacing.ts`): applied, the step redrawn once a frame, saved, and layouts saved by name |
| `src/app/complexityController.ts` | The complexity chip and panel, and the cost labels beside loops and functions |
| `src/app/layout.ts` | The window layout on a wide screen: stacked or side by side, the two dividers (drag, arrow keys, double-click to reset), swapping the editor and canvas sides, and windows minimized or maximized to bars. It works out the grid tracks (`layoutTracks`) as CSS variables; styles.css applies them under "window layout" |
| `src/app/routing.ts` | Each language's address (/python, /sql...): the address follows the language, Back and Forward switch it, and pr0l1ne.com shows the address of the language it opened |
| `src/app/sectionTools.ts` | A window header's tools: one row that never wraps, scrolling sideways (a mouse wheel too), with a fade at the side that has more |
| `src/app/loadingCard.ts` | The card over the canvas, with a spinner, while Python or PostgreSQL downloads |
| `src/site/pages.ts` | The site's pages for search engines: each language's title, description, canonical address, structured data and introduction, and the sitemap. The build (`sitePages` in vite.shared.ts) writes python.html and the others from index.html with them |
| `src/app/mobileViews.ts` | On a phone: which one or two of the editor, memory view and loop history show (the Code / Memory / Loops bar); styles.css lays them out under "Phones and narrow windows" |
| `src/app/shortcuts.ts` | The keys that work anywhere outside the editor: Run, Measure, Save, Save as, and the stepping keys |
| `src/app/banner.ts` | The banner above the canvas, and its Run / Measure buttons |
| `src/app/html.ts` | `escapeHtml`, for text put into the banner and panels |
| `src/app/autoFit.ts` | Reads a window's remembered auto-fit setting (on by default for the memory view on a phone) |
| `src/app/rendererSwitch.ts` | Switching renderers live (SVG or Canvas 2D, the Style panel's Rendering choice): stand-ins for each window that carry everything over to the new renderer |
| `src/app/saveSvg.ts` | The Save SVG button in each window's toolbar, and the file's name |
| `src/app/renderers.test.ts` | Both controllers against renderers that only record what they're asked: the renderer contract is all they use |
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

Ruff checks errors (`E4`, `E7`, `E9`, `F`), likely bugs (`B`), import order (`I`), modern syntax (`UP`) and complexity (`C90`: a function with more than 10 branches is split into named steps); `pyproject.toml` lists the two rules it skips and why. No function is over it; to keep it that way, split a growing function into named steps rather than silencing the check.

Pyright checks Python types in basic mode. Where it can't follow the code (asyncio's private event loop slots, which the tracer sets on purpose), the line says so with `# pyright: ignore[rule]` and a comment above it.

A rule that's wrong for one line is silenced on that line with a reason, for example `// biome-ignore lint/complexity/noBannedTypes: keys are the user's own functions`, never turned off for the whole project.

**`git blame` and the big format.** The commit that first formatted the whole codebase is listed in `.git-blame-ignore-revs`, so `git blame` and GitHub's blame view skip it and show who last really changed each line. Locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

## Deploying

The site is hosted on [Cloudflare Pages](https://developers.cloudflare.com/pages/), as two projects connected to this one GitHub repo: the app, and the code runner programs run in (on another site, for safety: see [Security](how-it-works.md#security-running-other-peoples-code)). Cloudflare builds and deploys both on its own:

| Event | The app | The runner |
| --- | --- | --- |
| Push to `main` | Production: https://pr0l1ne.com (also `pr0l1ne.pages.dev`) | https://pr0l1ne-run.pages.dev |
| Any other branch, or a pull request | A preview at `https://<branch>.pr0l1ne.pages.dev`, linked on the PR | `https://<branch>.pr0l1ne-run.pages.dev`, which that preview of the app talks to |

Each build works out which runner it talks to, and who may embed it, from where it's built (`CF_PAGES_BRANCH`; see `src/sandbox/origins.ts`), so nothing needs setting per branch. A branch name becomes its preview's name lowercased, with anything but letters and digits made a hyphen. If Cloudflare ever names a preview differently (a very long branch name, say), set `VITE_RUNNER_URL` on the app project's preview environment to the runner preview's address.

The two projects deploy separately, so for a minute after a push one can be newer than the other. If a change makes them unable to talk (a new `PROTOCOL_VERSION` or `SANDBOX_VERSION`), people with the app open see "PR0L1NE was updated since this page loaded. Reload the page" until both are deployed.

Cloudflare only builds; it doesn't run the tests. `.github/workflows/ci.yml` runs them (and the same builds) on every pull request and push to `main`, and in a second job the browser tests (`npm run test:e2e`) in Chromium, Firefox and WebKit. Requiring that check before merging into `main` (Settings → Rules → Rulesets) means only tested code reaches the live site.

`public/_headers` sets the app's caching (built files are kept for a year, the page itself is re-checked on every visit) and security headers, including its Content-Security-Policy (report-only for now). The runner's `_headers` is written by its build from `src/sandbox/origins.ts`.

**The docs site.** The pages in `docs/` are also a [VitePress](https://vitepress.dev/) site, built into `dist/docs/` by `npm run build`, so it deploys with the app at https://pr0l1ne.com/docs/ and needs nothing set up in Cloudflare. Its configuration is `docs/.vitepress/config.mts`: the sidebar, search, and the colours and fonts of the app (`docs/.vitepress/theme/custom.css`). The pages stay plain Markdown that reads the same on GitHub; links from a page to the code (`../src/...`) are sent to GitHub. VitePress puts three small scripts inside its pages (dark mode, and the list of page files), which the app's Content-Security-Policy would block: `scripts/docs-headers.mjs` hashes them after each build and adds the hashes to `script-src` in `dist/_headers`, so they, and nothing else inline, are allowed. One of them changes whenever the docs do, which is why it's done at build time. A new page goes in the `sidebar` in `config.mts`.

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
4. Under **Custom domains**, add `pr0l1ne.com`.
5. **The runner:** create a second Pages project from the same repo, the same way:

    | Setting | Value |
    | --- | --- |
    | Project name | `pr0l1ne-run` (gives `pr0l1ne-run.pages.dev`) |
    | Production branch | `main` |
    | Framework preset | None |
    | Build command | `npm run build:runner` |
    | Build output directory | `dist-runner` |
    | Environment variable | `NODE_VERSION` = `22` |

    It needs no custom domain: nobody visits it, and `pages.dev` is already a site of its own.
6. If something goes wrong after a deploy, open the project's **Deployments** list and use **Rollback** on the last good one (for both projects, if the change touched both).

If a name is taken, Cloudflare gives a slightly different address: change `APP_PROJECT` or `RUNNER_PROJECT` in `src/sandbox/origins.ts`, the `frame-src` in `public/_headers`, and the links in this file and the README.

## Project structure

```
pr0-l1ne/
├── index.html                  Page layout: toolbar, editor, canvas, timeline
├── runner.html                 The code runner's page (its own site; see src/runner/)
├── package.json
├── tsconfig.json               TypeScript config for the app
├── tsconfig.node.json          ...and for Node-only code (the CLI, Node-run tests)
├── vite.config.ts              The app's build (dist/)
├── vite.runner.config.ts       The runner's build (dist-runner/): workers, Pyodide, its headers
├── vite.shared.ts              What both builds share
├── playwright.config.ts        Browser tests: Chromium, Firefox, WebKit, against npm run preview
├── docs/                       The documentation, and the images it uses: also the docs site (pr0l1ne.com/docs)
│   └── .vitepress/             The docs site's configuration and theme
├── e2e/
│   ├── sandbox.e2e.ts          What a hostile program or page would try, in real browsers
│   ├── share.e2e.ts            Share links: open, run, edit, save, a broken link, Share
│   ├── sql.e2e.ts              SQL: a query stepped through, the page's windows, an error explained
│   └── csp.e2e.ts              The app under its own Content-Security-Policy
├── scripts/
│   ├── dev.mjs                 npm run dev: the app's and the runner's dev servers
│   ├── preview.mjs             npm run preview: both builds, served locally
│   ├── docs-headers.mjs        After the docs build: allows its inline scripts by hash in dist/_headers
│   └── test-pyodide.mjs        Runs the Python tracer's tests inside Pyodide
└── src/
    ├── main.ts                 Creates the state and controllers and connects them
    ├── app/                    The app's state and controllers (see "How the app is put together")
    ├── languages.ts            Per-language worker, Monaco mode and examples
    ├── sandbox/                Running programs on another site (see "Security" in how-it-works.md)
    │   ├── origins.ts          Where the runner is, who may embed it, its headers
    │   ├── messages.ts         Setting up a run: the handshake between app, runner page and worker
    │   ├── sandboxWorker.ts    The app's side: a Worker stand-in, really a hidden iframe of the runner
    │   └── *.test.ts           Tests (jsdom)
    ├── runner/                 The runner page
    │   ├── runner.ts           Its entry: the three workers, and the relay
    │   ├── relay.ts            Checks who's asking, starts the worker, hands it the app's port
    │   └── relay.test.ts       The relay with a fake page and workers
    ├── programs.ts             Saved programs (localStorage)
    ├── share/
    │   ├── link.ts             Share links: a program packed after the #, and opening one carefully
    │   └── link.test.ts        Round trips, and every way a link can be wrong
    ├── programs.test.ts        Saved program tests
    ├── monaco.ts               Lean Monaco build: editor features + 3 languages
    ├── editor.ts               Monaco setup, theme, commands and line markers
    ├── appearance.ts           Canvas style settings, presets, applying them
    ├── appearance.test.ts      Style settings tests
    ├── stylePanel.ts           The Style panel in the toolbar
    ├── spacingPanel.ts         The Layout panel: spacing sliders and saved layouts
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
    │   ├── policy.ts           The step budget, time limits and sampling rules, for both tracers
    │   ├── diff.ts             What changed between two steps
    │   ├── loopHistory.ts      Group steps into loop iterations
    │   ├── hints.ts            Parse and apply viz: comment hints
    │   ├── hints.test.ts       Hint tests (all three languages)
    │   ├── linked.ts           Linked lists and trees (loop history and memory)
    │   ├── linked.test.ts      Linked structure tests
    │   ├── graph.ts            Graphs: detection, the algorithm's state, one layout per run
    │   ├── graphLayout.ts      Graph layouts: layered (cycles, long edges, crossings), circle, stress
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
    │   ├── checkTrace.ts       Checking what the runner sends: limits, then the schema (no eval)
    │   ├── schemaErrors.ts     Schema errors as readable lines naming the field
    │   ├── complexity.ts       Time and space estimates: the code's shape plus the run
    │   └── complexity.test.ts  Every example's complexity, in all three languages
    ├── scene/                  What a step shows, worked out from the trace (no positions, no DOM)
    │   ├── memoryScene.ts      The memory view's scene: boxes, nesting, graphs, trees, links, output
    │   ├── memoryScene.test.ts Scene tests (valid for any renderer)
    │   ├── loopScene.ts        The loop history's scene: what to show, rows, bands, gaps, headers
    │   ├── loopScene.test.ts   Loop scene tests
    │   ├── nesting.ts          Nested mode: which objects are drawn inside others
    │   ├── nesting.test.ts     Tests for choosing what to nest
    │   ├── pointers.ts         Index pointers: which variables point into which lists
    │   └── renderer.ts         The renderer contract: what the app asks of whatever draws a window
    ├── render/
    │   ├── svgRenderers.ts     The SVG renderers behind the contract (SVG_RENDERERS)
    │   ├── svgRenderers.test.ts  What each renderer call does to the window
    │   ├── canvas/             The Canvas 2D renderers (PixiJS), drawing the same layout
    │   │   ├── canvasRenderers.ts  The windows: canvas, viewport surface, hover, drag, tweens (CANVAS_RENDERERS)
    │   │   ├── styles.ts       Styles from the page's CSS, through a hidden probe
    │   │   ├── paint.ts        Drawing -> paint list: shapes and text, colors resolved (PaintCache)
    │   │   ├── pixiScene.ts    Paint list -> PixiJS Graphics, Text and Containers, kept between steps (SceneCache)
    │   │   ├── keep.test.ts    Kept paint and objects draw exactly what a fresh build draws
    │   │   ├── path.ts         Path data: parse, flatten, dash, end direction
    │   │   ├── color.ts        Computed CSS colors as numbers
    │   │   ├── motion.ts       CSS easings, and tweens run once a frame
    │   │   └── *.test.ts       Tests (jsdom, with testing/fakePixi.ts and testing/canvasStyles.ts)
    │   ├── export.ts           A drawing as a standalone SVG file (Save SVG)
    │   ├── draw.ts             SVG helpers, metrics, cells, arrows, pointer markers
    │   ├── drawing.ts          The drawing model: marks (SVG elements as data), toSvg()
    │   ├── drawing.test.ts     Marks behave like the DOM: attribute order, classes, styles, selectors
    │   ├── patch.ts            Redrawing SVG: change the SVG on screen into the next drawing (SvgPatcher)
    │   ├── patch.test.ts       Every step of the examples patches to exactly what toSvg() makes
    │   ├── memory.ts           The memory view: memoryDrawing(), renderMemory() (SVG), applyFocus
    │   ├── memoryView/         Its parts:
    │   │   ├── shapes.ts       Shape, View, OutRef and the context they share
    │   │   ├── tables.ts       Frames, dicts, objects, functions, classes (title + rows)
    │   │   ├── sequences.ts    Lists, tuples, sets; grids of nested lists
    │   │   ├── objects.ts      Any heap object as a shape; what goes in a value slot
    │   │   ├── graphs.ts       A graph's box, with its picture
    │   │   ├── trees.ts        Binary trees as one block
    │   │   ├── output.ts       The printed-output card
    │   │   ├── layout.ts       Columns, placement, routing: the whole drawing
    │   │   └── focus.ts        Hover focus
    │   ├── memory.test.ts      The SVG renderer drawing scenes
    │   ├── route.ts            Arrow routing and non-overlapping placement
    │   ├── route.test.ts       Routing tests
    │   ├── spacing.ts          The layout's spacing, which the Layout panel changes
    │   ├── spacing.test.ts     Spacing settings, and the layout across their whole ranges
    │   ├── layout.test.ts      Every example, every step: the scene's boxes and links, no overlaps or crossings
    │   ├── loopView.ts         The loop view: loopDrawing(), renderLoopHistory() (SVG)
    │   ├── loopView/           Its parts:
    │   │   ├── shared.ts       Spacing, the column and track layouts, names and cells
    │   │   ├── plan.ts         Where everything goes in a row (shared by every row)
    │   │   ├── row.ts          One row: containers, variables, change arrows
    │   │   ├── grid.ts         A list of lists, as a grid
    │   │   ├── linked.ts       A linked list or a binary tree
    │   │   ├── bands.ts        Loop headers, unrecorded passes, passes where nothing changed
    │   │   └── layout.ts       The rows top to bottom: the whole drawing
    │   ├── loopView.test.ts    The loop renderer drawing scenes, every JS and TS example
    │   ├── graphView.ts        Drawing a graph, for both views
    │   ├── graphEdges.ts       Edge shapes (auto, curved, straight, angled) and weight label placement
    │   ├── animate.ts          What a step animates (plan), played as FLIP tweening for SVG
    │   ├── animate.test.ts     Animation tests (jsdom)
    │   ├── viewport.ts         Pan, zoom and node dragging for both sections (an SVG, or a surface)
    │   ├── viewport.test.ts    The viewport with a surface (the canvas renderer)
    │   ├── sqlView.ts          SQL: a stage's tables, and a statement's stages, as drawings
    │   └── sqlView.test.ts     Every SQL example, every step: rows keyed, patched as drawn fresh
    ├── sql/                    SQL, stepped through clause by clause (how-it-works.md, section 22)
    │   ├── sql.worker.ts       Entry point for the SQL worker: PGlite and the parser, answers runs
    │   ├── engine.ts           Postgres (PGlite), values as Postgres's text, its errors
    │   ├── parser.ts           Postgres's parser (libpg_query) and the deparser
    │   ├── script.ts           Byte offsets to characters and lines; the database hint
    │   ├── trace.ts            traceSql(): the run, statement by statement, as a Trace
    │   ├── select.ts           A SELECT's steps: a smaller query per clause; what isn't stepped yet
    │   ├── compose.ts          WITH, subqueries in FROM, UNION: parts stepped through first
    │   ├── statements.ts       CREATE, INSERT, UPDATE, DELETE: the table each changed
    │   ├── explain.ts          Postgres's errors, explained
    │   ├── databases.ts        The sample databases (shop, school, company, transit)
    │   ├── csv.ts              Import CSV: a CSV file as CREATE TABLE and INSERT
    │   └── sql.test.ts         The SQL tracer on PGlite in Node
    ├── js/
    │   ├── instrument.ts       Rewrites JavaScript to report on itself (Babel): parse, then
    │   ├── analyze.ts            passes 1 and 2: blocks everywhere; what each statement sees
    │   ├── transform.ts          pass 3: insert the runtime's calls
    │   ├── cost.ts             The code's shape, for complexity estimates (costAnalysis)
    │   ├── costs/
    │   │   ├── shape.ts        A function's loops, calls and costly built-ins, in order
    │   │   ├── loops.ts        How many passes each loop makes
    │   │   ├── sizes.ts        What each name and expression measures
    │   │   ├── syntax.ts       AST helpers shared by the above
    │   │   ├── table.ts        The MethodCost format; tables merged by method name
    │   │   ├── arrays.ts       What array methods cost (tests: arrays.test.ts)
    │   │   ├── strings.ts      What string methods cost (strings.test.ts)
    │   │   ├── maps.ts         What Map and Set methods cost (maps.test.ts)
    │   │   ├── builtins.ts     Object.keys and friends, Math (builtins.test.ts)
    │   │   └── tableTests.ts   checkTable(): every table entry, estimated as it says
    │   ├── measure.ts          Measure: run at full size with counters
    │   ├── typescript.ts       Strips TypeScript types, then instruments as JS
    │   ├── runtime.ts          Records steps: shadow stack, frames, timers, console
    │   ├── sampling.ts         Which passes of long loops are recorded (as sampling.py)
    │   ├── inspector.ts        How values look: the heap (Serializer) and console.log
    │   ├── trace.ts            traceJavaScript(): instrument, run, return a Trace
    │   ├── serve.ts            Worker side of the protocol, shared by JS and TS
    │   ├── javascript.worker.ts  Entry point for the JavaScript worker
    │   ├── typescript.worker.ts  Entry point for the TypeScript worker
    │   ├── cli.ts              npm run instrument / trace:js
    │   ├── trace.test.ts       JavaScript tracer tests, end to end (Vitest)
    │   ├── async.test.ts       Generators, async, timers and the event loop
    │   ├── typescript.test.ts  TypeScript tracer tests
    │   ├── instrument.test.ts  Function names, loop ids, parse errors, hints
    │   ├── inspector.test.ts   The serializer and console formatting, directly
    │   ├── sampling.test.ts    Sampling, driven by hand
    │   ├── cost.test.ts        costAnalysis: parameters, recursion, memoization
    │   └── measure.test.ts     Measure tests
    └── worker/
        ├── protocol.ts         Message types between page and workers
        ├── channel.ts          How a worker talks to the app: directly, or through the runner's port
        ├── runner.ts           Starts a worker, runs code, watchdog; the four ways a run can fail
        ├── runner.test.ts      The runner against a fake worker
        ├── pyodide.worker.ts   Loads Pyodide and the tracer, answers runs
        ├── pythonModules.ts    Writes the Python modules into Pyodide and imports them
        ├── tracer.py           The Python tracer: the settrace hook and the run
        ├── sampling.py         Which passes of long loops are recorded
        ├── policy.py           The policy's types; fixtures/policy.json outside the app
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
        ├── measure.py          Measure for Python: run at full size with counters
        └── counters.py         ...the counters, added by rewriting the syntax tree
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

Node can hide browser-only problems. Node has `process` and real built-in modules, and a browser doesn't, so a dependency that leans on them works in tests but fails in the worker. When you add or upgrade dependencies used by a worker, run `npm run build && npm run build:runner`, then `npm run preview`, and test the built worker in the browser.

**Adding a renderer** (WebGL, WebGPU...). Implement `MemoryRenderer` and `LoopRenderer` from `src/scene/renderer.ts` and export a `RendererFactory` like `SVG_RENDERERS` or `CANVAS_RENDERERS`. Add its kind to `RENDERER_KINDS` in `settings.ts`, a source for it in `main.ts`'s `RendererSwitch` (a dynamic `import()` keeps it out of the main bundle), and a line in `RENDERER_INFO` and `RENDERER_COMPARISON` in `stylePanel.ts` so people know what it's like. Nothing else in the app changes. The easiest start is the canvas renderer's: it reuses the SVG layout through a paint list (`render/canvas/paint.ts`), so only `pixiScene.ts` and the window would be new; PixiJS's `autoDetectRenderer` can already make a WebGL or WebGPU renderer instead of `"canvas"`. A renderer with its own layout starts from the scenes, which give everything to draw and nothing about where. Either way, copy the checks that keep the SVG renderer honest (`layout.test.ts`, `loopView.test.ts`, `renderers.test.ts`), and compare its pictures with the SVG renderer's in a browser.

**Changing the renderer.** Edit the files in `src/render/`. Vite hot-reloads the page. What a step shows is worked out first, in `src/scene/` (see "Scenes and renderers" in how-it-works.md), and drawing is a pure function of that scene, so you can paste a trace JSON into a unit test, build its scene and render it without running any code. A change to *what* is shown belongs in the scene, with a scene test; a change to *where* or *how* belongs in the renderer. A new spacing constant the person should be able to change goes in `render/spacing.ts` (a field in `SPACING_FIELDS` and a default), and the Layout panel shows it with no other change. Layout changes in `memory.ts`, `memoryView/`, `loopView.ts` or `loopView/` reach both renderers at once: they build a drawing (`render/drawing.ts`) that the SVG renderer makes SVG and the canvas renderer paints. A new kind of SVG element or attribute (one `paint.ts` doesn't read yet), or a CSS animation, needs a matching change in `src/render/canvas/` too: look at both renderers in the browser (Style → Rendering).

**Changing the SQL tracer.** Everything in `src/sql/` except the worker entry point runs in Node, on the same PGlite the browser runs: `npx vitest run src/sql` tests it, and the SQL examples are golden traces like the other languages'. A new sample database goes in `databases.ts`, under 15 rows a table; never change one that programs and share links may name, add a new one instead. A new kind of step goes in `select.ts`, with its query written from the parse tree's own pieces (`parser.deparse`), and the check at the end of `selectStages()` keeps a wrong picture from being shown.

**Upgrading PGlite or the parser.** Change `@electric-sql/pglite`, `libpg-query` or `pgsql-deparser` in `package.json`, then run `npx vitest run src/sql src/examples/golden.test.ts` and the browser tests. Keep the parser's Postgres version (libpg-query's major version) the same as PGlite's: a newer parser accepts syntax the database doesn't. Vite copies PGlite's files and the parser's `.wasm` into the runner's build (with hashes in their names); `src/sql/parser.ts` points the parser at its copy.

**Upgrading Pyodide.** Change the `pyodide` version in `package.json`: the runner's build copies that package's files to `/pyodide/<version>/` and tells the worker the version, and `npm run test:pyodide` tests the same package. (The `PYODIDE_VERSION` fallback in `pyodide.worker.ts` is only for the type checker.) Check which Python version the new release ships, run the tracer tests under that version, and keep the "use Python 3.X locally" note above in sync.

---

## Extending it

### Draw a new kind of object

Say you want sets drawn as bubbles or tuples drawn differently:

1. **Tracers**: add a branch to `Serializer.describe()` in `serialize.py` (Python) and in `inspector.ts` (JavaScript) that returns a new `kind`.
2. **Types**: add the shape to the `HeapObject` union in `trace/types.ts`. TypeScript will then point out every `switch` that needs a case.
3. **Diff**: teach `slotsOf()` in `diff.ts` what the object's slots are, so changes get highlighted.
4. **Render**: add a shape builder in `render/memoryView/` and pick it in `objectShape()` (objects.ts) (and, if it's a container, handle it in `cellsOf()` in `scene/loopScene.ts`).

### Add a structure-specific layout

Binary trees (`measureBlock()` in `memoryView/trees.ts`) and graphs (`graphBoxes()` in `memoryView/graphs.ts`) already have their own layouts in the memory view, using two patterns. A tree is measured as one block that the column walk places like a single wide box, with each node then put at its slot inside it. A graph is a single box drawn in place of a host object, with the other members aliased to it. Either pattern works for a new shape. Graph layouts are our own, in `src/trace/graphLayout.ts` (see "Graphs" in how-it-works.md): pure, synchronous and deterministic, with no layout library. Everything downstream needs a position per node, and optionally the bends of long edges (`routes`) and which edges point up (`back`).

### Teach graphs a new kind of state

`graphOverlay()` in `trace/graph.ts` decides what each variable means for a graph. To draw something new (say, a `color` dict for graph coloring as actual colors), add a field to `GraphOverlay`, fill it in the loop over variables, and draw it in `graphPicture()`. Add a line to `legendItems()` too, and to `nodeSignature()` so changes get highlighted.

### Add a hint

1. Add the keyword to `KEYWORDS` in [`trace/hints.ts`](../src/trace/hints.ts), parse it in `parseHints()` into a new field of `VizHints` (in `trace/types.ts`), and warn with the expected form when it doesn't parse.
2. Use it: either in `applyHints()`, if it changes the trace itself (like `hide`), or in a renderer through `trace.viz` (like `show`).
3. Add a case to `hints.test.ts` and document it in the [Hints](hints.md#hints-viz-comments) table.

No tracer needs to change, since they pass every `viz:` comment through as text.

### Add another language

Everything after the worker only depends on the trace format, so any language works if something can produce that JSON. The tracers here show the three main strategies. If the language's runtime has a tracing hook, like Python's `sys.settrace`, use it. If not, rewrite the program to report on itself, like the JavaScript tracer does. And if the language compiles to one that's already supported, compile it first and keep the line numbers, like the TypeScript tracer does. The language also needs to run in the browser, either natively or compiled to WebAssembly, unless you add a server.
