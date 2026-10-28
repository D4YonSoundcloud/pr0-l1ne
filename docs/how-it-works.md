[← Docs index](README.md)

# How it works

## The big picture

```
┌──── the app: pr0l1ne.com, main thread ─┐      ┌── the runner: pr0l1ne-run.pages.dev ──┐
│                                         │      │  (hidden iframe; another site)        │
│  editor.ts ──code──▶ runner.ts ─────────┼─run─▶│  Web Worker                           │
│  (Monaco)            (watchdog,         │      │  pyodide.worker.ts   (Python)         │
│                       one per language, │      │    └─ Pyodide (CPython/WASM)          │
│                       each a            │      │         └─ tracer.py                  │
│                       SandboxWorker)    │      │            sys.settrace + ast         │
│                      ◀──────────────────┼trace─┤                                       │
│                                         │      │  javascript.worker.ts  (JS)           │
│  app state holds { trace, stepIndex }   │      │    ├─ instrument.ts  (Babel)          │
│                                         │      │    └─ runtime.ts  (recorder)          │
│                                         │      │                                       │
│                                         │      │  typescript.worker.ts  (TS)           │
│                                         │      │    ├─ typescript.ts  (strip)          │
│                                         │      │    └─ then same as JS                 │
│                                         │      │                                       │
│                                         │      │  sql.worker.ts  (SQL)                 │
│                                         │      │    ├─ PGlite (Postgres/WASM)          │
│                                         │      │    └─ libpg_query (its parser)        │
│                                         │      └───────────────────────────────────────┘
│     │
│     ├─ trace/hints.ts        parse and apply viz: comments
│     ├─ trace/diff.ts         what changed between step N-1 and N
│     ├─ trace/loopHistory.ts  which steps are which loop iteration
│     ├─ render/memory.ts      snapshot ─▶ drawing (frames, heap, arrows)
│     ├─ render/loopView.ts    loop rows ─▶ drawing (stacked or live row)
│     └─ render/animate.ts     tween old drawing ─▶ new drawing
└─────────────────────────────────────────┘
```
The design rule that holds this together: **each layer only talks to the next through data.** The tracers know nothing about drawing. The renderer knows nothing about Python or JavaScript. The contract between them is the trace format in [`src/trace/types.ts`](../src/trace/types.ts). That's why adding JavaScript didn't require any new rendering code, only two small tweaks (JavaScript's primitive type names, and `function` instead of `def` in function titles), and why TypeScript needed none at all.

## 1. Running code without freezing the page

User code runs in a **Web Worker**, a separate thread, so even a `while True:` can't lock up the editor. And the worker runs on **another site** (the code runner, `pr0l1ne-run.pages.dev`), in a hidden iframe, so a program can't reach anything of PR0L1NE's: see [Security](#security-running-other-peoples-code) below.

There's one worker per language, and both speak the same small protocol, defined in [`protocol.ts`](../src/worker/protocol.ts): the page sends `run` with the source code, and the worker answers with `ready`, then a `result` holding a trace. `ready` says which version of the protocol the worker speaks (`PROTOCOL_VERSION`); the page refuses a worker that speaks another one, such as a worker cached from before a deploy talking to a newer page, and asks for a reload instead of misreading its messages. Raise the version whenever a message changes shape.

- [`pyodide.worker.ts`](../src/worker/pyodide.worker.ts) imports Pyodide from the runner's own site (the build copies it there from the `pyodide` package), loads the tracer into it, and then answers runs. Vite bundles every `.py` file in `src/worker/` except the tests as text (`import.meta.glob` with `?raw`). [`pythonModules.ts`](../src/worker/pythonModules.ts) writes each one into Pyodide's virtual file system and imports `tracer` and `measure` the normal way, so the modules import each other as they do on your machine. The Node tests load them the same way (`src/testing/pythonTracer.ts`).
- [`javascript.worker.ts`](../src/js/javascript.worker.ts) and [`typescript.worker.ts`](../src/js/typescript.worker.ts) are one-line entry points into [`serve.ts`](../src/js/serve.ts), which handles the protocol. They're ready immediately, and call `traceJavaScript()` or `traceTypeScript()` for each run. Keeping them as separate workers means only the TypeScript one contains Babel's core.

[`languages.ts`](../src/languages.ts) lists each language's worker, Monaco language mode and examples, so everything language-specific in the UI comes from one place. Each worker is a `SandboxWorker` ([`sandbox/sandboxWorker.ts`](../src/sandbox/sandboxWorker.ts)): the same interface as a `Worker` (`postMessage`, `onmessage`, `onerror`, `terminate`), but behind it an iframe of the runner page, which starts the real worker on its own site.

[`runner.ts`](../src/worker/runner.ts) is the main-thread side. There's one runner per language, created the first time that language is used, so someone writing JavaScript never downloads Python. It keeps one run in flight at a time, and the run controller ([`app/runController.ts`](../src/app/runController.ts)) drops intermediate edits so only the newest code runs after the current run finishes. It also has a **watchdog**: if a run takes longer than 10 seconds, it terminates the worker (removing its iframe, which ends everything in it) and starts a fresh one. (The tracer's own step budget, below, catches almost every runaway loop first. The watchdog is the fallback for code stuck inside a single long C call, like `sum(range(10**12))`, which never produces a trace event.)

**How a run can fail.** The runner turns everything that can happen at the boundary into one of four outcomes, and the run controller shows each its own way (a message, and a colour on the banner):

| What happened | Outcome | Shown as |
| --- | --- | --- |
| The program raised an error | a `trace` with `error` | the program's own output: the error, on its line |
| It used up its steps or time, or the watchdog stopped it | a `trace` with `truncated`, or `timeout` | stopped, and why, with what to do next |
| The tracer itself failed (an exception in the worker, the worker dying after it loaded, or, in development builds, a trace that doesn't match the schema) | `crash` | a PR0L1NE bug, not the program's, with a link to report it |
| The language runtime didn't load (usually the network), or the worker speaks another protocol version | `unavailable` | nothing ran: try again, or reload the page |

A run waiting when the runtime fails to load ends at once as `unavailable`, and the next run tries a fresh worker. Only a `crash` goes to `reportCrash` (`RunOptions` and `MeasureOptions`), where error reporting will plug in; the other three are the program's doing or the network's. `src/worker/runner.test.ts` drives the runner with a fake worker through each of these, plus results arriving out of order, a run that never answers, and two languages' runners at once.

## Security: running other people's code

Everyone runs their own code today, but a shared link would run someone else's in your browser. So programs never run on PR0L1NE's own site. A program in a worker on `pr0l1ne.com` could fetch the site with your cookies (once there are accounts), read its storage, and talk to other sites; the browser only keeps those apart between *sites*. So the workers run on another site, the **code runner**, with nothing on it to reach and no way out.

```
pr0l1ne.com (the app)                         pr0l1ne-run.pages.dev (the runner)
  <iframe sandbox="allow-scripts               runner.html: checks who's asking,
          allow-same-origin" hidden>  ──────▶  starts the language's worker, hands
                                               it the app's port
  ◀═════════ one port: the protocol ═════════▶ the worker: runs the program
```

**Why it holds.** `pr0l1ne-run.pages.dev` is another site from `pr0l1ne.com` (and from `pr0l1ne.pages.dev`: Cloudflare lists `pages.dev` on the Public Suffix List, so each project is a site of its own). The browser gives the runner none of the app's cookies, storage or pages, whatever its code does. On top of that, every file the runner serves carries its own Content-Security-Policy ([`sandbox/origins.ts`](../src/sandbox/origins.ts), written into `dist-runner/_headers` by the build):

| Directive | Means |
| --- | --- |
| `default-src 'none'` | nothing unless allowed below |
| `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'` | its own scripts only; `new Function()` runs JavaScript programs, Pyodide is WebAssembly |
| `worker-src 'self'` | workers from its own files |
| `connect-src 'self'` | fetch its own files only (Pyodide's standard library): no other site, no WebSockets, no beacons |
| `frame-ancestors https://pr0l1ne.com ...` | only the app's pages may embed it |
| `base-uri 'none'`, `form-action 'none'` | no other way out |

The runner keeps nothing: no cookies, no storage, no API. If a program takes over everything it can reach, it has an empty site that can only answer the app through one port, and the app treats what arrives as data. The iframe's `sandbox` attribute takes away the rest: the runner page can't navigate the app's tab, open popups, show dialogs, submit forms or start downloads. (`allow-same-origin` gives it its own origin, which its workers need; on another site, that's no way into the app's.) The program runs in a worker inside the iframe, not in the page itself, so it has no DOM and no WebRTC either, and a stuck program can't freeze a browser that runs the iframe on the app's own thread (Firefox and Safari may).

**Language-level blocking isn't the wall.** Deleting `fetch` and the like before running a program would leak: JavaScript has many ways back to a fresh copy, and Python reaches all of it through Pyodide (`import js`). The wall is the browser's: another site, and a policy it enforces however the program tries.

**Setting up a run** ([`sandbox/messages.ts`](../src/sandbox/messages.ts)). The app makes two `MessageChannel`s and posts a `connect` message to the iframe with their far ends, addressed to the runner's origin only (if anything else were in the frame, it would never get the ports). The runner page ([`runner/relay.ts`](../src/runner/relay.ts)) answers only the page that embeds it, only from the app's sites (`originAllowed`, matching as CSP does), and only once. It starts the language's worker, named so the worker knows to wait for its port ([`worker/channel.ts`](../src/worker/channel.ts)), and hands it the data port. From then on runs go straight between the app and the worker, so a trace is copied once, not twice through the page. The control port stays with the page, which says `hello` when it's set up, or `error` when the worker can't start or dies. A runner from another deploy answers `hello` with another version, which the app treats like a worker of another protocol version: reload. If the page never answers (no network, or something blocking it), the app reports that the runtime couldn't load after 20 seconds. Stopping a worker removes its iframe.

**Which runner, and who may embed it.** Both are decided when building ([`sandbox/origins.ts`](../src/sandbox/origins.ts)):

| Built | The app talks to | The runner may be embedded by |
| --- | --- | --- |
| On Cloudflare, `main` | `https://pr0l1ne-run.pages.dev/` | `pr0l1ne.com`, `www.pr0l1ne.com`, `pr0l1ne.pages.dev`, `*.pr0l1ne.pages.dev` (branch previews) |
| On Cloudflare, a branch | that branch's runner preview, `https://<branch>.pr0l1ne-run.pages.dev/` | the same |
| Anywhere else | the runner on this machine, `http://127.0.0.1:4174/` (`npm run preview`; `npm run dev` uses `:5174`) | the app on this machine, `http://localhost:*` and `http://127.0.0.1:*` |

`VITE_RUNNER_URL` and `RUNNER_APP_ORIGINS` override them. Locally the app is `localhost` and the runner `127.0.0.1`: two sites, as in production (a site ignores the port, so two ports on `localhost` would be one).

**What a program can still do.** Use the CPU until the watchdog stops it, and memory until the browser stops the runner (where the browser gives cross-site iframes their own process, that's the runner's process, not the app's). Tamper with its own trace: it runs in the same worker as the tracer, so it can change what's sent. So what arrives is checked before anything uses it, and never used as HTML (the banner escapes everything quoted from a program). Nothing it does can follow you off the page: if you copy someone's program to run on your own machine, that's outside any sandbox.

**Checking what arrives** ([`trace/checkTrace.ts`](../src/trace/checkTrace.ts), in [`worker/runner.ts`](../src/worker/runner.ts)). Every message from the runner is checked before it's used. A message that isn't part of the protocol, or has the wrong fields, is ignored. A trace then goes through two passes, and one that fails ends the run as a crash naming the problem ("the trace doesn't match the trace format: steps[3].line: should be number"):

1. **Limits:** plain data only (objects, arrays, strings, numbers, booleans, null: no `Map`s, `Date`s or class instances, which structured cloning could carry), no cycles, no `__proto__` keys (a key by that name, merged carelessly, could reach every object's prototype), at most 5 million objects nested at most 100 deep, and at most 200 million characters of text. One pass, without recursion, over each object once however often it's shared.
2. **The schema** (`schema/trace.schema.json`), compiled into plain functions when building (`traceValidators` in `vite.shared.ts`), since Ajv's usual compile needs `eval` and the app's policy allows none. Steps share most of their heap objects (on the 300-node stress program, 932 objects are referred to 350,000 times across 2,000 steps), so the steps are checked without their heap objects, and then each heap object once. That takes about 90 ms on that program and a few milliseconds on ordinary ones, where checking every reference took over 500.

A Measure result or its progress gets the limits pass. The tests' own check (`trace/validate.ts`, which lists every problem) is the same schema; every golden and conformance trace passes both.

**The app's own policy.** `public/_headers` sends the app a Content-Security-Policy too: its own scripts only (no inline scripts, no `eval`), styles and fonts from itself and Google Fonts, connections to itself only, and frames from the runner only. It's the backstop if a bug ever let a string be read as HTML: no script it brought could run. Since programs don't run on the app's site, the app needs no `unsafe-eval`; PixiJS builds some of its code with `new Function()`, so the canvas renderer imports `pixi.js/unsafe-eval`, which swaps in versions that don't. `npm run preview` sends the same headers (`appHeaders` in `vite.shared.ts`), so the app is tried locally under the policy it has live.

[`sandbox/*.test.ts`](../src/sandbox/), [`runner/relay.test.ts`](../src/runner/relay.test.ts), [`worker/channel.test.ts`](../src/worker/channel.test.ts) and [`trace/checkTrace.test.ts`](../src/trace/checkTrace.test.ts) test each piece. **In real browsers**, [`e2e/sandbox.e2e.ts`](../e2e/sandbox.e2e.ts) (`npm run test:e2e`, Playwright; CI runs it in Chromium, Firefox and WebKit) tries what a hostile program or page would:

- programs in each language run on the runner's site, and the app's only worker is the editor's
- from inside the runner's worker, fetches to other sites and to the app, WebSockets, beacons, `import()` and `EventSource` are blocked, and the app's window is out of reach
- a program's own attempts (`fetch`, `importScripts`) are blocked
- the runner page can't read the app's page, navigate it, open popups or show dialogs
- a program that rewrites its own trace on its way out is refused, not drawn
- an endless loop is stopped; a program stuck inside one call is cut off and gets a fresh runner
- the runner sends its policy with its page and its workers, and a page that isn't the app can't embed it

[`e2e/csp.e2e.ts`](../e2e/csp.e2e.ts) uses the app under its own policy, the canvas renderer included, and expects no violations. Where a browser's automation can't see workers inside a cross-site frame, the checks that need to run code in one are skipped there (Chromium runs them all).

## Share links

**Share** copies a link with the program inside it ([`share/link.ts`](../src/share/link.ts)):

```
https://pr0l1ne.com/python#v1.bVJLbsIwEN1zitkAkvA...
                          └┬┘└───────── the program, packed ─────────┘
                        version
```

Packing: `{"language": "python", "code": "..."}` as JSON, compressed with the browser's own deflate (`CompressionStream("deflate-raw")`), then written in base64url, whose letters, digits, `-` and `_` go in a link as they are. Base64 adds back a third of what compression saves, so short programs barely shrink, but every example's link is under 1,500 characters, and code repeats enough that long programs pack to under half. Links are capped at 32,000 characters (`MAX_FRAGMENT`), which chat apps and forms keep whole.

**Why after the `#`.** The fragment is the one part of a link the browser never sends: opening `pr0l1ne.com/python#v1....` asks Cloudflare for `pr0l1ne.com/python` only (a link made before each language had its own page, `pr0l1ne.com/#v1....`, still opens). So the program goes from the person who shared it straight to whoever opens it, and nothing is stored, logged or moderated anywhere. The cost: a link can't be edited or deleted (the program *is* the link), and link previews in chat apps are the standard PR0L1NE card, since they can't see the program either. Short links stored on a server, later, would add both.

**Opening one is careful** (`decodeShare`), because the link came from someone else: the version (only `v1.`; a later format would be `v2.`, and `v1.` keeps working), the characters, the length, the size after decompressing (read as it streams, stopping at 1 MB, so a tiny link can't unpack into gigabytes), valid UTF-8, a JSON object, a language the app has, and code that's text. Fields a later `v1` might add are ignored. Any failure is a `ShareLinkError` saying what's wrong in the person's words.

**What the app does with it** ([`app/shareController.ts`](../src/app/shareController.ts)). At start-up, before running anything, `openFromLocation()` looks for `#v1.` in the address; a link pasted into an open page's address bar is caught by `hashchange` (asking first if there's unsaved work). A program that opens is put in the editor, switching language if needed, as a **shared program** (`AppState.shared`, `app.openShared()`): no saved program open, the picture cleared, and a banner saying it's someone else's code, with Run and Save buttons. Nothing runs until the person asks; when it does, it runs in the runner like anything else. The editor's change handler asks `isUnedited()` first, so putting the program there isn't remembered as the person's own code and doesn't start a Live run: their saved programs, and their unsaved code in that language, stay as they were. The first real edit makes it ordinary unsaved code (`keepShared()`) and takes the link out of the address (`history.replaceState`), so a reload doesn't bring the original back over their edits. The code only ever goes into the editor as text; the banner escapes what it quotes.

[`share/link.test.ts`](../src/share/link.test.ts) checks round trips (Unicode, line endings, empty code) and every way a link can be wrong; [`app/shareController.test.ts`](../src/app/shareController.test.ts) the button and opening; [`e2e/share.e2e.ts`](../e2e/share.e2e.ts) the whole flow in browsers.

## 2. Tracing Python with `sys.settrace`

[`tracer.py`](../src/worker/tracer.py) is plain CPython, and the core trick fits in a few lines. Python lets you install a function that the interpreter calls on every event:

```python
sys.settrace(self.trace)
exec(compile(source, "<user>", "exec"), user_globals)
```

The interpreter then calls `trace(frame, event, arg)` for each:

- `call`: a function (or the module itself) starts,
- `line`: a line is about to run,
- `return`: a function is about to return (`arg` is the return value),
- `exception`: an exception is raised in this frame.

The `frame` object is a live view of the running program. `frame.f_locals` holds the variables, `frame.f_back` points to the caller, and `frame.f_lineno` is the current line. The tracer only cares about frames whose filename is `"<user>"` (the name we compiled the code under), so library internals are skipped.

At each event, `record()` walks the stack from the current frame outward, serializes every frame's variables, and appends a **step** to the trace.

**Serialization** ([`Serializer`](../src/worker/serialize.py)) turns Python values into two kinds of trace value:

- primitives (`int`, `float`, `str`, `bool`, `None`, ...) become `{"kind": "prim", "type": "int", "repr": "42"}`,
- everything else becomes a reference `{"kind": "ref", "id": "o140..."}`, and the object itself goes into the step's `heap` dictionary, recursively.

**Stable identity** is what makes "this is the same list as one step ago" possible, which every highlight and arrow depends on. The tracer numbers objects in the order it first sees them (`o1`, `o2`, ...), using Python's `id()` to recognize an object it has seen before. That makes ids the same on every run of the same program, which is how a box you've [dragged](user-guide.md#rearranging-the-memory-view) keeps its place through live re-runs. `id()` is only unique while an object is alive, and CPython can reuse it after an object is garbage collected. To prevent two objects sharing an id, the tracer keeps a reference to every object it has seen (`keepalive`) until the run ends.

**Safety rails:**

- **Step and time budgets.** After `maxSteps` recorded steps (20,000), or after `max_seconds` (6 for Run, 1.5 for Live runs), both set in [`trace/policy.ts`](../src/trace/policy.ts) and sent with each run, the trace function raises `StepLimitExceeded`. It subclasses `BaseException` rather than `Exception`, so user code with `except Exception:` can't swallow it.
- **Size caps.** Containers show at most 60 items and primitives at most 48 characters, so a 10,000-element list doesn't produce a huge trace.
- **Output capture.** `sys.stdout` is swapped for a `StringIO` during the run. Each step records how many characters had been printed so far, so the output panel shows exactly what was printed up to the step you're on.
- **No `input()`.** There's no keyboard in a worker, so `input()` raises an error asking you to hard-code test data.

## 3. Static analysis of Python with `ast`

Before running anything, `analyze()` ([`analysis.py`](../src/worker/analysis.py)) parses the code with Python's own `ast` module to learn two things the runtime trace can't tell us.

**Where the loops are.** For each `for` and `while`, it records the header line and the body's line range. Each loop gets an id from its header line (`L4`).

**Which names index which containers.** Every `Subscript` node whose target is a plain name is recorded, along with the names used inside the brackets. So `arr[j + 1]` produces `{"arr": ["j"]}`. One level of nesting is recorded too, under the name plus `[]`: `grid[i][j]` produces `{"grid": ["i"], "grid[]": ["j"]}`, which is how a grid knows `i` picks a row and `j` a column. The JavaScript instrumenter records the same thing from `MemberExpression`s. This drives [pointer detection](#pointer-detection).

## 4. Detecting loop iterations in Python

`sys.settrace` reports lines, not iterations, so iterations are inferred from line transitions inside each frame (see `update_loops`):

- **Loop entered**: execution reaches a loop's header line while the loop isn't active in this frame. A new *instance* starts at iteration 0.
- **New iteration**: execution moves *from the header line into the body*. The iteration counter goes up by one.
- **Loop exited**: execution reaches a line that's neither the header nor inside the body. The instance ends.

Counting header-to-body transitions, rather than header visits, matters because Python re-checks the header one last time before the loop ends. That final check doesn't start an iteration, so it shouldn't be counted as one. It also handles `continue` (back to the header, then into the body: a new iteration) and `break` (straight out: loop exits) without special cases.

**Instances** matter for nested loops. The inner loop of bubble sort is entered once per outer iteration, and each entry is a separate instance with its own iteration count. State is tracked per frame, so recursion (the same loop running in several frames at once) works too.

Every step stores the active loops for all frames on the stack, as `{frame, loop, instance, iteration}`. That means when a loop calls a function, steps inside the function still know which iteration of the caller's loop they belong to. Loops in suspended frames are included too, so a loop inside a generator keeps its place while the generator is paused.

### Generators and coroutines in Python

`sys.settrace` doesn't announce "yield" or "resume", but they can be recognized from the events it does send:

- **A yield or await looks like a return.** When a generator yields, the interpreter sends a `return` event for its frame. The difference is visible in the bytecode: after a yield, the frame is parked on the yield itself (`YIELD_VALUE` in Python 3.12, which the browser runs) or on the `RESUME` after it (3.13), so `co_code[f_lasti]` is one of those. A real return isn't. Whether the frame is a generator or a coroutine (`co_flags`) decides whether the step is called `yield` or `await`.
- **A resume looks like a call.** When a paused frame continues, the interpreter sends a `call` event for that same frame object. The tracer keeps paused frames in a dictionary by frame id, so a `call` for a frame it already knows is a resume.
- **Exceptions need care.** Closing a generator (`gen.close()`, or the generator being garbage collected) raises `GeneratorExit` at the `yield`, which can also end with `RESUME` next. The tracer remembers frames an exception is passing through (`unwinding`), so their next `return` is a real exit, not a yield. Await's internal `StopIteration` plumbing isn't shown as an exception step.

`record()` then draws paused frames below the stack with `state: "suspended"`. It walks the whole stack and skips library frames rather than stopping at the first one, since under `asyncio` your coroutines are called from the event loop's code. Generator objects get a description of where they're paused, and the tracer doesn't keep generator objects alive the way it keeps other objects (see [stable identity](#2-tracing-python-with-syssettrace)); a `weakref.finalize` forgets a generator's id when it's collected. Otherwise holding on to it would stop a dropped generator from ever being closed.

## 5. Tracing JavaScript

JavaScript has no equivalent of `sys.settrace` inside a web page. Real debugging hooks only exist in Node or browser extensions. So instead, PR0L1NE **rewrites your program to report on itself**: [`instrument.ts`](../src/js/instrument.ts) parses the code with Babel, inserts calls to a recorder ([`analyze.ts`](../src/js/analyze.ts) works out what each statement can see, [`transform.ts`](../src/js/transform.ts) inserts the calls), and the rewritten program runs in the worker. The recorder, [`runtime.ts`](../src/js/runtime.ts), builds steps in exactly the format `tracer.py` produces, with [`sampling.ts`](../src/js/sampling.ts) deciding which steps of long loops to keep and [`inspector.ts`](../src/js/inspector.ts) turning values into the heap.

Here's a small example, as printed by `npm run instrument`:

```js
// Your code
let total = 0;
for (const x of [5, 6]) {
  total += x;
}
```

```js
// What actually runs
const __av_f = __av.enter("Global", 0, () => [["total", () => total]]);
try {
  __av.line(__av_f, 1, () => [["total", () => total]]);
  let total = 0;
  {
    __av.loopEnter(__av_f, "L2", 2, () => [["total", () => total]]);
    try {
      for (const x of [5, 6]) {
        __av.loopIter(__av_f, "L2");
        __av.line(__av_f, 3, () => [["total", () => total], ["x", () => x]]);
        total += x;
        __av.tail(__av_f, "L2", 2, () => [["total", () => total], ["x", () => x]]);
      }
    } finally {
      __av.loopExit(__av_f, "L2");
    }
  }
  __av.mainDone(__av_f, () => [["total", () => total]]);
} catch (__av_e) {
  __av.raise(__av_f, __av_e);
  throw __av_e;
}
```

`__av` is the runtime, passed in with `new Function("__av", "console", "setTimeout", ..., code)` along with a `console` and [virtual timers](#generators-and-async-in-javascript). Names starting with `__av` are reserved and hidden from the canvas. Every event names the frame it belongs to (`__av_f`), which is what lets a generator's events find their way back to its frame after it resumes. The `Global` frame isn't popped when the script ends (`mainDone`), because callbacks and `await`s may still run; the tracer pops it after the event loop is empty.

**Reading variables.** Python hands the tracer `frame.f_locals`. JavaScript has nothing like it, so the instrumenter works out which variables are visible at each statement using Babel's scope analysis, and passes a **getter**: a list of `[name, () => value]` pairs. The runtime calls these thunks when it takes a snapshot, so it always reads live values. Each thunk is called inside its own `try`, because reading a `let` or `const` before its declaration throws (the "temporal dead zone"). A variable that throws is simply left out of that snapshot. That's why block-scoped variables appear exactly when they're declared.

**The call stack.** There's no stack to inspect either, so the runtime keeps a **shadow stack**. Every instrumented function starts with `__av.enter(name, line, getter)` and ends with `__av.exit()` in a `finally`, which pops the frame however the function finishes. Each frame remembers its most recent getter, so when a callee is running, the caller's variables can still be read. `return x` becomes `return __av.ret(x)` to record the return value, and a final `__av.ret(void 0)` records falling off the end. The `catch` clause records an exception step in each frame the error passes through.

Class methods, object methods and constructors also get `this` in their getters. Calling `this` in a derived constructor before `super()` throws, which the per-thunk `try` handles like any other unreadable variable.

**Loops are reported explicitly**, which is simpler than Python's approach of inferring iterations from line numbers. `loopEnter` starts a new instance and records the "before" snapshot. `loopIter` starts each iteration. `tail` records the end-of-iteration snapshot, the equivalent of Python re-checking the loop header. `loopExit` runs in a `finally`. A `continue` also records a `tail` before jumping, including a labeled `continue outer` aimed at an enclosing loop. `break`, `return` and exceptions don't, which matches what the Python tracer sees. Bubble sort produces 41 steps in both languages.

**Closures.** Python exposes captured variables through `fn.__closure__`, but JavaScript functions are opaque. For each function, the instrumenter uses Babel's binding information to find variables it uses from enclosing functions. It then registers them with the runtime: function expressions and arrows are wrapped as `__av.fn(fn, name, getter)`, and function declarations are registered at the top of their block, since they're hoisted. When the heap view draws a function, it reads those captured values through the getter.

**Serialization** follows the same rules as Python, adapted to JavaScript's types. Arrays and typed arrays become lists, `Map` and plain objects become dicts, `Set` becomes a set, and class instances become objects named after their constructor. Functions record their parameter names (parsed from their source) and any captured variables. `Date`, `RegExp`, `Error` and `Promise` are drawn as single values. Object ids come from a `WeakMap`, since JavaScript has no `id()`.

Snapshots never run your code. Properties are read through `Object.getOwnPropertyDescriptor`, so a getter shows as `(getter)` instead of being called. The runtime also refuses to record while it's serializing, in case anything does slip through.

**Safety rails** mirror the Python ones:

- **Step budget.** After the budget, every event throws a `StepLimit` sentinel. User code can catch the first one, but the first statement inside any `catch` block is itself an event and throws again, so the program can never make progress past the limit.
- **Call depth.** More than 250 nested calls throws a `RangeError` explaining that a recursive function may be missing its base case, rather than overflowing the real stack.
- **`console`.** The program receives its own `console` whose `log`, `info`, `warn`, `error` and `debug` print into the trace's output, formatted roughly the way Node and browsers do (`[ 1, 'b' ]`, `Map(1) { 1 => 2 }`, `Node { val: 1 }`).
- **Watchdog.** Code stuck where no event fires, like an infinite loop inside an untraced generator, is stopped by the runner's 10-second watchdog, just like Python.

**How the instrumenter is structured.** It runs three passes:

1. **Normalize.** Single-statement bodies become blocks (`if (x) y()` becomes `if (x) { y() }`), and arrow functions with expression bodies get a block with a `return`. Afterward, every statement lives in a list that calls can be inserted into.
2. **Analyze.** One Babel traversal, with scope information, records what each statement can see, each function's name, parameters and captured variables, each loop's id and header, the target of every `continue`, and which names index which arrays (for [pointer detection](#pointer-detection)). Nothing is modified in this pass, so the scope information stays accurate.
3. **Transform.** A plain post-order walk inserts the calls, mutating nodes directly. Because it never asks Babel to re-visit replaced nodes, nothing gets instrumented twice.

### Generators and async in JavaScript

A shadow stack assumes a call ends before its caller carries on. Generators and `async` functions break that: they stop at a `yield` or `await`, their caller keeps running, and they continue later, from some other place in the program. So the runtime keeps a second collection beside the stack, **suspended frames**, and the instrumenter marks every point where a function can stop:

```js
// yield x                      becomes
__av.resumed(__av_f, yield __av.yielding(__av_f, x))

// await p                      becomes
__av.resumed(__av_f, await __av.awaiting(__av_f, p))
```

- `yielding` records the **yield** step (with the value) and `awaiting` the **await** step. Both then move the frame from the stack to the suspended set. `yield*` uses `delegating`, which hands over without a value.
- `resumed` runs when execution comes back. It records the **resume** step and puts the frame back on top of the stack. It passes through whatever the `yield` or `await` produced, so the program's behavior is unchanged.
- Because every event names its frame, an event from a frame that isn't on top of the stack can't be misattributed. If a suspended frame reports an event (which happens when a generator is resumed by `next()` and its first event is the line after the `yield`), the runtime resumes it first.
- `for await (x of source)` wraps `source` in `__av.asyncIter()`, so the hidden `await` on each iteration suspends and resumes the frame like a written one.
- A frame leaves the suspended set when its function returns or throws, the same `exit` that pops ordinary frames.

**The event loop.** `traceProgram()` is async. After the script's top level finishes, it repeatedly yields to the real event loop with a `MessageChannel` message (a macrotask, so every pending promise callback, and thus every `await` continuation, runs first), then runs the next due timer. `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval` passed to the program are the runtime's own: they put callbacks in a list ordered by due time and insertion order, and `nextTimer()` advances a virtual clock to the earliest. A run ends when no timers are left, after 10,000 turns (a `setInterval` that's never cleared), when the step budget runs out, or when an error escapes. Unhandled promise rejections are caught by listening for Node's `unhandledRejection` or the browser's `unhandledrejection` event during the run.

Generator objects are drawn as a box labeled "generator object". JavaScript doesn't expose a generator's state, so unlike Python's, it can't say where it's paused; the suspended frame shows that instead.

## 6. Tracing TypeScript

Types don't exist at runtime, so tracing TypeScript means tracing the JavaScript it compiles to. [`typescript.ts`](../src/js/typescript.ts) adds one step in front of the JavaScript instrumenter:

1. **Parse with types.** The same `parseProgram()` as JavaScript, with Babel's `typescript` parser plugin.
2. **Strip the types** with Babel's official TypeScript transform, [`@babel/plugin-transform-typescript`](https://babeljs.io/docs/babel-plugin-transform-typescript), run through `@babel/core`'s `transformFromAstSync`. Using the official transform rather than hand-written stripping means every TypeScript construct is handled the way the TypeScript team intends.
3. **Instrument and run** exactly as JavaScript, with `instrumentAst()`.

The key detail is line numbers. The transform works on the parsed tree rather than on text, so every statement you wrote keeps its original source location, and removing an `interface` on lines 1–3 doesn't shift anything below it.

**Generated code.** A few TypeScript constructs compile to new code rather than disappearing:

| You write | It becomes |
| --- | --- |
| `enum Light { Red, Green }` | `var Light = function (Light) { ... }(Light \|\| {})` |
| `namespace Geo { export const k = 1 }` | `let Geo;` plus a function that fills it in |
| `constructor(public x: number) {}` | `constructor(x) { this.x = x; }` |

Generated nodes have no source location, and the instrumenter treats that as "run this, but don't trace it". Generated statements get no step of their own, and generated functions run without a frame, so the enum helper never appears as a mysterious `anonymous()` call. The one thing `stripTypes()` adds back is the line of each enum and namespace declaration, matched by name, so declaring an enum still shows up as a step on its line.

**Running Babel's core in a browser.** `@babel/core` is mostly browser-ready (it ships browser versions of its config and file loaders), but it still calls Node's `path.resolve()` while setting up options. Vite replaces Node built-ins with empty stubs in browser builds, so `vite.config.ts` aliases `path` to [`path-browserify`](https://www.npmjs.com/package/path-browserify), and `stripTypes()` passes `cwd` and `envName` explicitly so Babel never reads `process.cwd()` or `process.env`. Babel's core adds about 300 kB, and only to the TypeScript worker.

## 7. The trace format

A trace looks like this (trimmed):

```json
{
  "version": 1,
  "language": "python",
  "loops": [{ "id": "L4", "kind": "for", "line": 4, "bodyStart": 5, "bodyEnd": 7, "header": "for j in range(n - i - 1)" }],
  "indexNames": { "arr": ["j"] },
  "steps": [
    {
      "event": "line",
      "line": 6,
      "stack": [{ "id": "f1", "func": "Global", "line": 6, "locals": [["arr", { "kind": "ref", "id": "o1407" }], ["j", { "kind": "prim", "type": "int", "repr": "0" }]] }],
      "heap": { "o1407": { "kind": "list", "id": "o1407", "typeName": "list", "items": [{ "kind": "prim", "type": "int", "repr": "5" }], "length": 1 } },
      "stdoutLength": 0,
      "loops": [{ "frame": "f1", "loop": "L4", "instance": 1, "iteration": 1 }]
    }
  ],
  "stdout": "",
  "error": null,
  "truncated": false
}
```

Each step is a complete snapshot, which keeps the renderer simple: any step can be drawn on its own, so scrubbing backward is free. Memory is kept down by sharing: an object that didn't change since the previous step is the same object in both steps' heaps (see [Sampling, strips and shared steps](#20-sampling-strips-and-shared-steps)), so nothing may change a trace's objects in place. To see the full trace for any program, run `npm run trace -- my_program.py` or `npm run trace:js -- my_program.js`.

A few optional fields cover the newer features:

- `event` can also be `"yield"`, `"await"` or `"resume"`. A yield step carries the yielded value in `returnValue`.
- `suspended` on a step lists paused frames, in the same shape as `stack` but with `"state": "suspended"`. `liveFrames(step)` in `types.ts` gives the stack plus the suspended frames, which is what anything that looks up a frame by id should use.
- `output` on a step says that a `print()` / `console.log()` ran since the previous step: `{ "line": 14, "refs": ["o18"] }`, the line that printed and the ids of printed objects drawn at this step. The text itself is `stdout` from the previous step's `stdoutLength` to this one's; `printedAt()` in [`trace/output.ts`](../src/trace/output.ts) puts the two together. Python gets this by giving the program its own `print`, which prints as usual and remembers what it was given; JavaScript's `console` already belongs to the runtime. Each tracer turns the remembered objects into ids when it records the next step, listing only objects that are in that step's heap.
- `skipped` on a step: events that ran just before it without being recorded (the middle of a sampled loop); `skippedAfter` on the last step, for events after it. `sampled` on the trace says some loop was sampled, `counts` holds every event, call and the deepest recursion per function, recorded or not, and `stoppedBy` (`"steps"` or `"time"`) says what stopped a truncated trace.
- `call` on a step's loop context: a counting loop's header with its values as this run started (`"range(0, 3)"`, `"j = 0; j < 3; j++"`).
- `offset` and `strip` on a long list: its `items` are a window of 60 starting at `offset`, and `strip` is 256 evenly spaced samples of the whole list, with their smallest and largest values.
- `heapDelta` on a trace from the Python tracer: each step's `heap` holds only the objects that changed, and `heapIds` lists every id in order. The worker rebuilds full heaps with `expandHeaps()` ([`trace/delta.ts`](../src/trace/delta.ts)) before the page sees the trace.
- `hints` on the trace lists the raw hint comments, as `{ "line": 3, "text": "hide temp" }`. The tracers only collect them. `applyHints()` adds the parsed result as `viz` before anything is drawn.

## 8. Diffing snapshots

[`trace/diff.ts`](../src/trace/diff.ts) compares step N-1 with step N. The key idea is that **every object is treated as a set of named slots**: a list's slots are its indices, a dict's slots are its keys, and an object's slots are its field names. Comparing slot by slot (by value for primitives, by id for references) gives:

- `changedLocals`: variables whose value or pointer changed,
- `changedSlots`: per object, which indices/keys/fields changed,
- `newObjects` and `newFrames`: things that didn't exist a step ago.

The renderers turn these into yellow cells, bold labels, and dashed outlines.

## 9. Drawing the memory view

**Scenes and renderers.** Drawing a step happens in two halves. First, [`scene/memoryScene.ts`](../src/scene/memoryScene.ts) works out *what* the step shows, from the trace: its frames and the objects reachable from them (each with its distance from the stack), which objects nest inside others, which are graphs or binary trees, every arrow between boxes (`links`), the index pointers and grid cell to mark, what was printed and whether the rest dims, sizes, and what changed since the step before. That's a `MemoryScene`. It holds no positions and no pixels, and builds without a DOM, so its tests ([`scene/memoryScene.test.ts`](../src/scene/memoryScene.test.ts)) hold for any renderer. Then a renderer decides *where* everything goes and *how* it looks. The layout is [`render/memory.ts`](../src/render/memory.ts) and its parts in [`render/memoryView/`](../src/render/memoryView/): `memoryDrawing(scene, layout)` lays the step out as a *drawing*, where `layout` holds only what the renderer remembers between steps (boxes the person dragged). Both renderers, SVG and Canvas 2D, draw from that drawing (see "The drawing model" and "The canvas renderer" below), so there's one layout and one arrow router. Layout and routing belong to the renderers, not the scene, since a future renderer may place things differently. `src/render/layout.test.ts` checks that for every example, step and mode, the SVG has exactly the scene's boxes and an arrow for each of its links.

**The renderer contract.** The app talks to each window's renderer only through [`scene/renderer.ts`](../src/scene/renderer.ts): `render(scene, previous)` draws a scene (with the one drawn before, to animate from), `showMessage(text)` draws nothing and says why, `setViewport()` pans, zooms and sets Auto-fit, `hitTest(x, y)` says which box (by its scene key) is under a point, `setAppearance()` sets the step animation, the refit glide and the graph-paper size, `addControl()` puts a button in the window's toolbar, `viewport` says where the window is looking, `toSVG()` gives the drawing as a standalone SVG file, `ready` (optional) settles once a renderer that starts up asynchronously can draw, and `dispose()` lets go. The memory renderer also owns the boxes the person has dragged (`resetLayout()`, `hasMovedBoxes`, `movedBoxes` / `moveBoxes()` to hand them to another renderer, and `onLayoutChange` when one moves) and what hovering highlights; the loop renderer takes `setLayout({ vertical })`. The controllers build scenes and call these, and never touch the drawing. `src/app/renderers.test.ts` runs both controllers against renderers that only record what they're asked.

**Switching renderers.** [`main.ts`](../src/main.ts) gives the controllers their renderers through a [`RendererSwitch`](../src/app/rendererSwitch.ts). Its factory hands each controller a stand-in that passes every call to the real renderer underneath and remembers what it needs to make another one look the same: the Style panel's settings, Auto-fit, the pan and zoom, the toolbar buttons (the very same button elements, which the controllers keep hold of), dragged boxes, the loop layout and the last scene or message. `use("canvas")` loads the canvas renderers (a dynamic `import()`, so PixiJS is its own chunk, downloaded only by people who pick it), swaps them in under every window, redraws the last scene without animating, and waits for them to be `ready`; if they can't start, it swaps SVG back and rejects, and the Style panel says so. Windows always start on SVG, which is ready at once, and switch when the canvas is, so a slow download never holds up the first drawing. `main.ts` is the only app code that imports from `src/render/`.

**The drawing model** ([`render/drawing.ts`](../src/render/drawing.ts)). The layout code (memory.ts and memoryView/, loopView.ts, graphView.ts, draw.ts) doesn't build DOM elements. Its `s("rect", {...}, ...children)` makes a `Mark`: the SVG element it means, as a plain object with the small part of the DOM's API the layout uses (`append`, `setAttribute`, `classList`, `style.setProperty`, and `querySelector` for simple selectors: tags, classes, ids, attributes, no combinators). `toSvg()` turns the tree into real SVG, and behaves exactly like building the elements directly: attributes keep the DOM's order, class lists are rewritten as the DOM rewrites them, inline styles land where the DOM puts them. A snapshot of every drawing of every example (about 32,000 of them, memory and loop views, every mode) came out byte for byte the same through the model. The canvas renderer paints the marks straight away (below), with no DOM in between.

**Redrawing SVG** ([`render/patch.ts`](../src/render/patch.ts)). The SVG renderer doesn't make a new SVG each step. Its `SvgPatcher` keeps the drawing on screen and which element each of its marks is, and compares each new drawing with it: where an attribute's value or a text differs, it changes that; children are matched by key where they have one (`data-node-key`, `data-flip`, `data-cell`: boxes, linked nodes, cells) and otherwise by position among siblings of the same tag, and the ones that are new, gone or out of place are added, removed or moved. Most of a step is the same as the last, so most elements are left alone and the browser restyles and repaints only what changed; a box being dragged moves without the rest of the drawing being rebuilt, and the box under the pointer keeps its hover. What it leaves is always exactly what `toSvg()` would make, down to attribute order (when the set of attributes changes, they're set again in order), so the CSS, Save SVG and every test see the same SVG; [`patch.test.ts`](../src/render/patch.test.ts) checks that for every step of the examples, memory and loop views, with boxes dragged and hovered. Two kinds of element are always made afresh, because a CSS animation plays when they appear: a changed cell (`.cell.is-changed`, the flash) and the printed-output card (`.node.is-output`), so both play every step as they did when every element was new. Hover focus is applied to the drawing before it's compared, and to both the drawing and the SVG when the pointer moves, so they never disagree. On the program with 300 linked nodes, a step was on screen in about 150 ms, against 315 ms when each step was a new SVG (95th percentile 265 ms against 515), and small programs went from about 47 ms to 28 (Dijkstra's example) and 34 to 24 (the route planner).

**The canvas renderer** ([`render/canvas/`](../src/render/canvas/)) draws each window with [PixiJS](https://pixijs.com) v8 on a plain 2D canvas (PixiJS's `canvas` renderer, not WebGL), one canvas the size of the window. It doesn't lay anything out itself. Each step, it takes the drawing the layout made and paints it:

1. **Styles from the real CSS** ([`styles.ts`](../src/render/canvas/styles.ts)). The diagrams are styled entirely by class in `styles.css`, through the Style panel's CSS variables. Rather than restating those rules in code, `ProbeStyles` keeps a tiny hidden `<svg>` in the window: for each distinct chain of tags, classes and presentation attributes in a drawing (`svg.memory-svg > g.boxes > g.node > rect.node-hit`), it builds the same chain there and reads `getComputedStyle` from its last element. The diagram CSS only uses class, descendant and child selectors, so the copy matches exactly the rules the real element would. Animations are switched off inside the probe, so a flash half-way through is never what's read. Results are kept per chain, so a step costs a lookup per element; they're dropped when an inline style above the window changes (the Style panel), checked on each draw and whenever the Style panel calls `setAppearance()`.
2. **A paint list** ([`paint.ts`](../src/render/canvas/paint.ts)): `paintDrawing()` walks the drawing and turns each element into a plain shape (rect, circle, path) or text run with its colors resolved ([`color.ts`](../src/render/canvas/color.ts) reads `rgb()`, hex and the `color(srgb ...)` that `color-mix()` computes to), opacity multiplied down, `marker-end` arrowheads turned into filled shapes pointing along the path's end ([`path.ts`](../src/render/canvas/path.ts)), `<tspan>`s laid out as runs, white space collapsed as SVG does, and `<title>`s kept as tooltips. Groups keep the `data-*` attributes that dragging and animation work from (node keys, positions, `data-flip`, `data-cell`), and their bounds. It has no PixiJS in it, so its tests run in jsdom. Most of a drawing paints the same as the step before (the boxes that didn't change, the loop rows already drawn), so `PaintCache` keeps each layer group's paint (a box, a loop row, a cell) under a signature of its marks and the style chain above it, as the probe numbers chains. While styles are read, a group found there is skipped, with everything inside it: its styles aren't read and it isn't painted again. Only its opacity is worked out afresh. The cache is dropped with the styles.
3. **PixiJS objects** ([`pixiScene.ts`](../src/render/canvas/pixiScene.ts)): shapes in a row share one `Graphics`; text is `Text`, whose textures PixiJS shares between equal strings in equal styles, snapped to whole pixels so it isn't blurred. Every group the animation moves, the person drags, or the culling skips gets its own `Container`; other groups are flattened. Those containers are kept from step to step (`SceneCache`). Each one holds a body with its `Graphics` and `Text`, remembered by a signature of what it draws, measured from its own top-left corner; when the next drawing has a group with the same signature, the body is moved into the new scene and shifted to where the group is now, so a box that moved, or a cell that slid along, isn't rebuilt either. Only what changed is built, and only what's left over is destroyed. A changed cell's flash overlay stays in its body and starts again from the top. [`keep.test.ts`](../src/render/canvas/keep.test.ts) steps through example programs and checks that, with both caches, every step draws exactly what building it from nothing draws. Two things PixiJS's canvas backend doesn't do are done here: dashed lines (paths are flattened and cut into dashes) and round corners on large radii (PixiJS rounds corners with quadratic curves, which makes a pill look squarish, so corners of 6 px and up are traced as circular arcs). Text is positioned from the font's em box, so `dominant-baseline: central` lands where SVG puts it.

Then [`canvasRenderers.ts`](../src/render/canvas/canvasRenderers.ts) draws it. The canvas sits over the viewport's graph paper; the viewport tells it where the view is (`ViewSurface.onView`) instead of moving an SVG with CSS, and the stage is translated and scaled to match, with boxes and loop rows outside the window skipped. Drawing happens on the next animation frame, so a burst of pointer moves draws once. Text is rasterized at the device's pixel ratio times the zoom (1×, 2× or 3×), redrawn a moment after zooming stops. What the SVG renderer gets from the DOM is done by hand: which box is under the pointer comes from the paint list's bounds (the viewport asks `ViewSurface.nodeAt` to start a drag), hovering runs the same `applyFocus()` on the drawing and paints it again (only the boxes and arrows whose classes changed are painted and built afresh), and tooltips come from the `<title>`s. The step animation is the same plan as the SVG renderer's (`plan()` in [`animate.ts`](../src/render/animate.ts): what slides from where, what arrives), played with tweens ([`motion.ts`](../src/render/canvas/motion.ts), which solves the CSS `cubic-bezier()` easings) instead of the Web Animations API. The effects `styles.css` plays with CSS animations are tweens too: the changed-cell flash (a white overlay, and a doubled border, fading over `--flash`'s duration), the printed-output card's entrance (from `--output-from-opacity` and `--output-from-x`), and the rest dimming in and out (each thing in the arrows layer is its own layer for this). All of them are skipped when the person prefers reduced motion, as the CSS does.

**What it's faster at, and what it isn't.** The canvas renderer saves the browser from styling, laying out and painting thousands of elements, and it draws only what's in view, so panning and zooming a big drawing stays smooth: on a program with 300 linked nodes, every frame took under 17 ms, where SVG's slowest took 100 to 150 ms (re-rasterizing as the zoom changed). Stepping, it keeps what didn't change (paint and PixiJS objects, above), so a step on that program is on screen in about 190 ms (median of 60 steps, headless Chromium, no GPU). The way there: painting from the drawing model rather than a hidden SVG took a step from about 425 ms to 335; keeping PixiJS objects took it to 225, halving the garbage collection; keeping paint, and looking for arrowheads only in `<defs>` rather than through the whole drawing, to 200. SVG, which now changes only the elements that changed (above), is still quicker to step: about 150 ms there, and 28 ms against 130 on Dijkstra's example, since the canvas is painted whole each frame while the browser repaints only what changed. What's left on the canvas is that painting (PixiJS's canvas backend draws each object in turn, about a third of a step), building the drawing, and garbage collection.

The two renderers' pictures are checked against each other in a browser: every example in every language, at a middle and the last step, screenshotted both ways and compared pixel by pixel. Apart from one-pixel shifts in antialiasing and text placement, they match.

**Saving SVG** ([`render/export.ts`](../src/render/export.ts)). `standaloneSvg()` copies a drawing and writes each element's computed style onto it (read through the same probe, with animations stopped), as hex colors with opacities, line widths, dashes and fonts, drops the `data-*` attributes, adds a `viewBox` and the window's paper color behind it. Both renderers export this way, so the file is the same whichever is on.

The SVG renderer works in three passes:

1. **Assign columns.** Each box goes in the column of its distance from the stack (the scene's `depth`): objects pointed at directly by a variable in column 0, objects they point at in column 1, and so on. The scene finds the distances with a breadth-first walk from the frames' variables, so every object is reached before its children.
2. **Measure.** Each object becomes a `Shape` that knows its width, its height, and where incoming arrows should land. All text inside cells uses a monospace font, where each character is exactly 0.6em wide, so sizes are pure arithmetic with no DOM measuring. Each column is as wide as its widest shape.
3. **Place and draw.** Frames go down the left side. Then objects are placed in BFS order. Each object tries to line up vertically with the first arrow pointing at it, but never overlaps the object above it in the same column. This simple rule is what makes linked lists come out as straight horizontal chains.

**Nested mode.** Anything that holds a value (a table row, a list cell) asks for a `View` of it. A plain value or a reference dot is a fixed-size cell. In nested mode, a reference to an object that should nest is the object's whole `Shape`, and rows and cells grow to fit it. Shapes are built recursively, so a nested object's own references nest or become arrows in turn.

Which objects nest is part of the scene, decided by `chooseNested()` ([`scene/nesting.ts`](../src/scene/nesting.ts)), a pure function with its own tests. It counts every reference to each object in the snapshot (from variables, fields, items and the return value), then walks out from the variables, nesting an object only if its count is exactly 1, it hasn't been placed yet, and it's no more than 6 levels deep. It then walks out from every object that stayed separate, so things inside a shared object can still nest inside it. Dict keys never nest, since they're labels.

The column walk then runs over separate boxes only. A reference from inside a nested object counts as coming from the box it's drawn in, so arrows still lead out of nested boxes to the right column.

**Printed output** is placed last, after every object, at the bottom of the stack column (moving down past anything in the way), so it never pushes a box to a new spot on the steps that print. It's exactly as wide as that column: the gap to the right of the column is where the router runs arrows, and a card reaching into it would sit across them. The column's width includes the widest printed line of the whole run (`outputWidth()`, cached per trace), so the layout doesn't shift between printing and non-printing steps. The card's arrows to printed objects are ordinary routed arrows with a `print-arrow` class. Dimming (with **Dim others** on, `dimForOutput` in the `MemoryLayout`) is CSS only: the SVG gets `has-output`, the card `is-output` and printed objects `is-printed`, and everything else drops to 28% opacity. The first printing step also gets `output-in`, and the step after the last gets `output-out`, which run a short fade (a CSS animation rather than a transition, which would need the SVG's earlier state to start from). The card's own entrance is a CSS animation whose starting opacity, starting offset and duration are variables (`--output-from-opacity`, `--output-from-x`, `--output-duration`, and `--output-dim-duration` for the dimming) that `applyAppearance()` sets from the Style panel. The card carries `data-no-fade`, so the step transition in `animate.ts` doesn't fade it in on top of that. [`layout.test.ts`](../src/render/layout.test.ts) draws the card on every printing step of every example and checks it like any box: no overlaps, and no arrows through it.

Each frame and object is drawn in its own `<g class="node">` carrying a key (`frame:2:factorial`, `obj:o4`) and its position. `renderMemory()` takes a `MemoryLayout`, a map from key to position for boxes the person has dragged. A dragged box is drawn at its saved position and leaves the automatic flow, so it doesn't push later boxes down. Arrows are routed using wherever boxes actually ended up, so they follow automatically. Each node group starts with an invisible rectangle covering the whole box, so a press anywhere on it, even in the gap between a list's index numbers and its cells, grabs the box rather than panning the canvas.

**Columns in arrow order.** Within a column, boxes go in the order their arrows arrive, top to bottom (`inArrowOrder()`), so arrows into a column don't cross on the way. Dragged boxes, tree nodes and boxes nothing earlier points to keep their places. The order depends only on the arrows, so a box only moves when an arrow does.

**Layers.** The drawing has three layers, back to front: arrows, boxes, and the parts of arrows that must stay visible. Each arrow is drawn whole, without an arrowhead, behind every box. Over the boxes go its *stub* (from the dot to where it leaves its own box, the one cut `arrowEnds()` makes, against the one rectangle it starts in), its last 10 pixels carrying the arrowhead, and an *x-ray* copy: invisible unless the Style panel's **Show arrows through boxes** is on (then faint and dashed, through `--xray-opacity`, so no redraw), and solid while its box is hovered. Layering is just drawing order, in SVG and on the canvas alike, so it costs nothing per frame, and a box sliding over an arrow during a step's animation covers it correctly with no recomputing.

**Placement never overlaps.** Boxes the person dragged are placed first, at their saved positions. Every automatically placed box then asks `findFreeY()` (in [`route.ts`](../src/render/route.ts)) for the first spot at or below where it wants to go that doesn't touch anything already placed, so it moves down past dragged boxes instead of hiding underneath them. A list whose arrows leave downward reserves room under itself for their turns, so the next box down doesn't sit on them.

**Arrow routing** happens after every box is placed, in `routeEdges()`, which is pure geometry with its own tests. Each arrow is classified by where its target is: to the right (*forward*), in the same column (*u-turn*), or in an earlier column (*corridor*). Then:

1. Arrows arriving at the same side of the same box are spread a few pixels apart, ordered by where they come from. An arrow already level with its target stays level and becomes a single straight line.
2. Each vertical segment gets a **lane** in its gap. Forward arrows use lanes just left of the target's column, counted leftward. U-turns and corridors use lanes just right of a column, with shorter loops nearer the column so loops nest instead of crossing. Forward lanes are ordered with a pairwise crossing count: lane A left of lane B costs a crossing when A's exit passes B's vertical span, or B's entry passes A's. A first order by pairs is then improved as a whole by sifting (`fewestCrossings()`): each lane moves to the place where the total is lowest, until nothing improves.
3. Corridors run above the boxes in their horizontal range when there's room (the diagram keeps 28 px free at the top for this), otherwise below. Since arrows are drawn behind boxes, a corridor can instead run **straight across behind** the boxes in between, when going around them is the long way (`cheapestTunnel()`): out to its lane, across at one height (level with where it arrives, or just above or below its own box, never back through it), into the lane right of the target's column, and in. Each box it passes behind costs 300 pixels of length (`BEHIND_COST`), and it's only used when that still beats going around. Such an arrow is marked `is-behind` in the drawing.
4. `roundedPath()` turns each list of points into an SVG path with rounded corners.

The automatic layout makes routing reliable: an object's column is its distance from the stack, so a forward arrow always goes to the very next column, and its horizontal runs only cross empty gap. [`layout.test.ts`](../src/render/layout.test.ts) checks this for real: it renders every example in every language at every step, in both modes, and fails if any two boxes overlap or any arrow passes through a box it doesn't start or end at (an arrow marked `is-behind` may pass behind others, never back through its own).

**Gaps between columns** are 64 px, or 96 px where more than four arrows turn in one (`gapBefore()`): two widths rather than one per arrow, so boxes don't shift sideways each time an arrow comes or goes. With the 28 px top margin, drawings are about 4% smaller (in area, over every step of every example) than with the old fixed 90 px gaps, with arrows 2% shorter. [`crossings.test.ts`](../src/render/crossings.test.ts) keeps arrow crossings from going up: every JavaScript example, at every step, against its count from before arrows could run behind boxes (`crossings.baseline.json`).

**Hover focus** is `applyFocus()`: each arrow carries `data-from` and `data-to` node keys, so highlighting a box's connections is a class toggle, re-applied after every render.

**Grids** in nested mode come from `gridRows()`: a list whose items are all lists nested inside it is drawn by `gridShape()` instead of as a row of cells. Its row and column markers use `ctx.pointersFor(id, level)`, where level 1 looks up the `grid[]` index names.

**Trees** are laid out as blocks. `findTreeBlocks()` runs the loop history's tree detection (`findLinkedTrack()` and `treeDepths()`, so hints apply) on the current step, treating every live frame's variables as one row. Each root with at least one child becomes a `TreeBlock`: its nodes in in-order, each with a depth. `measureBlock()` gives every slot the width of the widest node and every level the height of the tallest plus a gap. The rest of the layout then treats the block as one wide box:

- The column walk puts all of a tree's nodes in the column of the first one reached, so the whole block sits in one column (as wide as the block).
- The first node placed asks `findFreeY()` for a spot for the whole block, so trees never overlap other boxes, and every node goes to `origin + (in-order index × slot width, depth × level height)`.
- Parent-to-child arrows are routed as kind `"tree"`: down out of the `left`/`right` cell into the gap beneath the parent, across to above the child, then down into its top. Arrows into a tree node from a box to the left of the tree (a variable pointing at the root, or at `curr` partway down) use kind `"top"`: they come down beside the tree and also enter from above, so they don't run through the node's neighbors.

**Suspended frames** are drawn in the stack column below the active frames, with their own node key (`paused:<frame id>`), so dragging one keeps working while it's paused.

## 10. Panning, zooming and dragging

Both canvas sections are wrapped in a [`Viewport`](../src/render/viewport.ts). The diagram is drawn at its natural size, and the viewport applies a CSS `translate(...) scale(...)` to it, so panning and zooming never re-render anything. With the canvas renderer there's no SVG to move: the viewport is given a `surface` (see "The canvas renderer" above), tells it where the view is on every change, asks it which box is under the pointer, and runs Auto-fit's glide frame by frame instead of with the Web Animations API. The graph-paper background is on the viewport itself, and its `background-position` and `background-size` follow the same pan and zoom, which is what makes the paper move with the drawing.

All input goes through pointer events, so mouse, pen and touch share one code path:

- A press on an element with a `data-node-key` starts a **node drag**, but only after it moves 3 px, so a click isn't a drag. Each move reports the box's new position in diagram units (screen pixels divided by the zoom) through `onNodeMove`. The memory controller ([`app/memoryController.ts`](../src/app/memoryController.ts)) stores it and re-renders the memory view. That's fast because rendering is pure arithmetic, and it means arrows are always correct mid-drag.
- A press anywhere else starts a **pan**.
- A second pointer turns it into a **pinch**, which zooms around where the fingers started and pans with their midpoint. Lifting one finger carries on as a pan.
- The pointer is captured on the viewport rather than on the diagram, because the diagram is replaced on every re-render during a drag.

Wheel events pan, except with `Ctrl` or `Cmd` held, when they zoom. Browsers report trackpad pinches as `Ctrl` + wheel, so pinching works with no extra code. Panning is clamped so at least 60 px of the diagram stays on screen.

**Auto-fit** lives in the viewport too, so both sections have it. After `setContent()` puts in a new step's diagram, `refit()` computes the zoom that fits it from the cached view size and the diagram's `width`/`height` attributes, so it never measures the page. "Zoom out only" fits the largest diagram size seen since Auto-fit started, rather than remembering a zoom level, which keeps it right when the window is resized. When the view changes, `glide()` animates from the old transform to the new one with the Web Animations API, on both the diagram layer and the graph paper's `background-size`/`background-position`, so they move together. It uses the window's easing and duration (`setZoomAnimation()`), and a new fit cancels a glide that's still running, so fast playback never queues them up. Any manual pan, wheel, pinch, zoom button or zoom key goes through `manual()`, which switches Auto-fit off first.

### Arrows by kind

[`scene/arrowKinds.ts`](../src/scene/arrowKinds.ts) says what kind of link each memory arrow is. Each object's shape marks the arrows that start in its cells with its id (`OutRef.owner`; an arrow with none starts at a variable), and `linkKinds(step)` walks the links from the variables in order, as a depth-first search: a link to an object still being walked points back along the way it was reached. A link between two objects of the same class is `next`; a two-way link's way back is `back` (by its field's name, `parent`, `prev`..., when it has one, else by which way was walked first); a link pointing back that isn't two-way is `cycle`; anything else is `ref`, and the layout's tree edges are `tree`. Each arrow gets a `kind-...` class and a matching arrowhead marker, and styles.css colors them from the Style panel's variables (`--arrow-next`, `--dash-back`...). In the loop history, a list's link is a `cycle` when following its field from where it points comes back to it.

### Where the windows go

On a wide screen the three windows can go anywhere. [`app/arrangement.ts`](../src/app/arrangement.ts) describes where as a tree with three leaves, which only ever has two shapes: a row or column of three windows, or one window beside a pair of the others split the other way (`code | (memory over loop history)` is the default). Every arrangement of three windows is one of those, 36 in all, and a test checks each can be reached by dragging. Sizes are grid `fr` weights per item, plus the pair's split.

`tracks()` turns an arrangement into a CSS grid: tracks along the root's direction (each item, with a 6 px divider between), and across it (one track, or a pair's two with a divider), and each window's grid lines. A folded window's track becomes a 32 px bar, and a divider next to it shrinks to nothing. On a wide screen `.canvas-pane` and `.canvas` are `display: contents`, so the memory and loop sections are grid items of the workspace itself, beside the editor, while staying inside `#canvas` in the page, where the diagram colors are set (CSS variables still inherit through `display: contents`). [`app/layout.ts`](../src/app/layout.ts) writes the tracks and each window's place as CSS variables that styles.css reads only on a wide screen, so the phone layout is untouched. The workspace's first row is the banner's, across the page.

**Moving a window** ([`app/docking.ts`](../src/app/docking.ts)) takes it out of the tree, leaving the other two as a split of two, and puts it back: beside a window in the same direction makes a line of three, across it makes the two a pair, along an edge of the page puts it before or after the other two, and the middle of a window swaps the two (`moveWindow()`). `dropTargetAt()` picks the target from the pointer: an edge of the page within 28 px, else the window under it, its middle swapping and otherwise its nearest side. While dragging, the preview box goes to the rectangle the window would get, from `windowRects()`, which solves the same tracks the grid would (fixed pixels first, then the rest by weight) on the window rectangles measured when the drag began. The box's `left`, `top`, `width` and `height` have CSS transitions, so it glides from target to target. On drop, the windows' old rectangles are measured, the new arrangement applied, and each window animated from its old place and size to its new one (a FLIP: `translate` plus `scale`, from the top-left corner). A drag only goes anywhere once the pointer is 24 px from where it started, since a window's header is close to the page's edges. A drag starts anywhere on a header (`[data-dock]`) except its own controls (buttons, inputs, labels, tabs), so the header's tools work as usual.

The page's two dividers are the first and second boundary between windows, wherever those are. Each resizes the two things either side of it (two items, or the pair), dragging, with the arrow keys along its own axis, or back to the usual size with a double-click. Settings saved before windows could move (stacked or side by side, the swap, the three splits) become the first arrangement (`legacyArrangement()`).

## 11. Drawing the loop history

[`trace/loopHistory.ts`](../src/trace/loopHistory.ts) finds the steps belonging to one loop instance. Those steps are contiguous in time, so it scans outward from the current step. It then takes the *last* step of each iteration as that iteration's row. The last step of an iteration is usually the header check that starts the next one, which shows the state with all of that iteration's work done.

Then, as for the memory view, the work is split into a scene and a renderer. [`scene/loopScene.ts`](../src/scene/loopScene.ts) works out what the loop view shows, from the trace and the history: which containers and scalars to show and which containers are grids, the graph and the linked list or tree in each row, which rows changed something, the items to draw in order (rows, bands of quiet passes, gaps of unrecorded ones, run headers, at most 120 rows), and each row's label, nesting depth, pointers, sizes and focused grid cell. That's a `LoopScene` (tests in [`scene/loopScene.test.ts`](../src/scene/loopScene.test.ts)). [`render/loopView.ts`](../src/render/loopView.ts) and its parts in [`render/loopView/`](../src/render/loopView/) lay it out as a drawing, `loopDrawing(scene, { vertical })`: first a plan every row shares (`plan.ts`: the label gutter, each container's column, the graph's and the linked track's lanes, where variables go, how tall a row is), then each row in it (`row.ts`, with `grid.ts` and `linked.ts`) and the bands between rows (`bands.ts`). `renderLoopHistory()` makes that SVG; the canvas renderer paints it. Aligning columns, placing lanes and drawing change arrows are the renderer's; `src/render/loopView.test.ts` checks the drawing has exactly the scene's rows, bands and headers, for every JavaScript and TypeScript example.

What the scene decides:

- **What to show.** Containers (lists, tuples, sets, dicts) in the loop's frame are shown if they change during the loop or are indexed in the code. Scalars are shown if they change or are used as pointers. If nothing qualifies, everything in the frame is shown. This keeps unrelated variables out of the way.
- **Quiet rows** collapse, as described in [Loop history](user-guide.md#loop-history), and the view is capped at the latest 120 rows.

What the renderer does:

- **Aligns columns.** Every row shares the same cell width and x positions per container, so index 3 is directly below index 3 in every row and arrows can be vertical.
- **Draws change arrows.** For each changed cell, it looks for a different changed index whose *previous* value equals this cell's *new* value. If it finds one, the value moved, and the arrow starts there (that's a swap). Otherwise the arrow goes straight down from the same index.

**One above another** (`vertical` in `LoopViewOptions`): the layout pass records each lane it places (the graph, each container, the linked list) with its name's width and its own width. A linked lane is split into lines by the scene's `chains()` (`linkedChains()`): nodes joined by a link in any row of the loop's run (including the steps after the one on screen, so a node doesn't change lines when it's linked in) are one chain, and each chain gets its own line and its own columns from the left. Stacked, every lane starts at the same x after the widest name, and each gets a `dy` within the row, below the last plus a gap; the row's height is their sum, and its label and scalars are drawn at its vertical middle.

**All loops together** is `buildNestedHistory()`: from the outermost loop running in the frame of the innermost one, it takes the outermost loop's run, and for every step in it, every loop of that frame running at that step. A step belongs to the innermost one: the row for a pass is the last step of that pass at which no loop inside it was running, so an outer pass's row is its state after its inner loops, not a copy of their last row. Rows from every loop are then sorted by step, and each carries its loop, run and depth. The renderer indents labels by depth, starts a header at each run, and keeps collapsing and sampling gaps per run. **Loop headers with values** come from the tracers: Python's `__viz_len__` (see [Sampling](#20-sampling-strips-and-shared-steps)) records `repr()` of a `range` as a loop starts, and the JavaScript instrumenter adds `loopCall(id, "j", "<", "j++", A, B)` to a counted `for`'s initializer, evaluating its start and bound once more (only when both are simple enough to evaluate twice: names, numbers, `.length`, arithmetic). Each step's `LoopContext` carries it as `call`.

**Grid cells.** Each tracer records every `grid[a][b]` in the code with its line and the row and column expressions as written (`Trace.gridAccesses`: Python's `ast.get_source_segment`, the original source for JavaScript). [`trace/gridFocus.ts`](../src/trace/gridFocus.ts) picks the access on the line that just ran in the same frame, else the line about to run, and evaluates its expressions with a small evaluator (whole numbers, variables, `+ - * // % /`, parentheses; Python's negative indices wrap). Anything it can't evaluate (a call, an attribute) is skipped. A grid the code never indexes by name falls back to the first row and column pointers. In `pointersFor()`, a conventional index name (`left`, `hi`...) isn't added to a grid dimension when the code uses it only for the other one.

**Linked structures** come from [`trace/linked.ts`](../src/trace/linked.ts), which is pure and has its own tests:

- `findLinkedTrack()` walks every row from the loop's variables (and one level through other objects, for `self.head`). It records, per class, which fields point at objects of the same class. The class with links and the most nodes is the track. Its links are those fields, plus conventionally named ones (`next`, `left`...) that are always null or a node. Its value field is the first field that's usually a primitive.
- Column order follows the links from each row's variables in turn, so the first row's structure reads left to right, and nodes that appear later go on the end. For a tree, it's in-order instead.
- A track is a `"tree"` when it has exactly two links and no node in any row has more than one incoming link. `treeDepths()` then gives each node's depth in a row (roots, which nothing links to, are depth 0), and the loop view draws that row top-down.
- `linkedRow()` gives one row's view: each reachable node's value and link targets, and which names point at which column. `linkedSignature()` turns that into a string, so a row counts as "changed" for collapsing when any link or value changes.

The loop view adds space above each row for arcs (and below, for a second link field) and draws the track after the containers. Rows are as tall as their tallest content (a grid, a tree, or a single line of cells plus pointer markers), and every row in one loop uses the same height so they stack evenly.

**Grids** in the loop view come from `gridIn()`: a container drawn as a grid in every row where it has items. Its change detection looks one level deep (a list's signature includes the values of lists inside it), so an iteration that only writes `grid[i][j]` still counts as a change.

**Animated mode** passes `live: { prev, current }` to `renderLoopView()`: the loop's state at the current step and the step before, read straight from those steps rather than from iteration ends. It draws just that one row, comparing it with `prev` for highlights, but sizes columns, cells and trees from all of the stacked rows, so the layout is identical from step to step and only the contents change. The animation in the next section does the rest.

With nested loops drawn together, animated mode passes one live row per loop of the nest instead (`liveNestedRows()` in [`app/loopController.ts`](../src/app/loopController.ts)), outermost first: each loop running at this step gets its state now and a step before; one that isn't running (an inner loop between runs) gets its last row, marked `done` so it isn't drawn as the running one. The scene lays them out in order, each inner one after its run's header and indented by its depth, and each row compares with its own `prev` (`all` keeps every live row's `prev` just before its `current`).

## 12. Hints

Hints are split so that each language does as little as possible:

1. **The tracers collect comments.** Python's tracer runs `tokenize` over the source and keeps `COMMENT` tokens matching `# viz: ...` (tokenizing, rather than searching the text, is what keeps `"# viz:"` inside a string from counting). The JavaScript instrumenter reads `ast.comments`, which Babel fills in while parsing, for `//` and `/* */` comments starting with `viz:`. TypeScript keeps the comments through type stripping. Each produces `{ line, text }` pairs in `trace.hints`.
2. **One parser for every language.** [`trace/hints.ts`](../src/trace/hints.ts) turns those into a `VizHints` object: `hide`, `show`, `pointers` (container name to names), `linked` (class, shape and link fields) and `warnings`. Anything that doesn't parse becomes a warning with its line and the expected form, rather than an error.
3. **Applied before drawing.** `applyHints()` runs once per new trace, in the run controller (`app/runController.ts`). It removes hidden variables from every frame of every step (so diffing, the loop history and the memory view never see them), merges `pointers` into `trace.indexNames` (so they behave exactly like names found by static analysis), and stores the rest on `trace.viz`.
4. **Used by the renderers.** `findLinkedTrack(rows, hints)` lets a `tree` or `list` hint pick the class and its links, overriding detection, in both the memory view and the loop history. The loop view adds `show` names to what it picks. The run controller shows `warnings` in the banner, and `editor.setHintWarnings()` turns them into Monaco markers with severity Warning under their own owner, so they don't interfere with error markers.

This keeps every hint keyword in one TypeScript file with its own tests (`hints.test.ts`), and adding a hint never touches the tracers. (`pointers` and `window` are the exception, in a small way: both tracers add their names to the index names they follow, so a long list shows the part of it around them.)

**Sliding windows.** A `window` hint's ends are small sums of names and whole numbers (`WindowBound`), worked out at each step from that frame's variables by [`scene/windows.ts`](../src/scene/windows.ts), like pointers: `windowsFor()` gives the window as a start and an exclusive end, with `[` and `]` taken as including an end, `(` and `)` as leaving it out. The memory view and the loop history draw it with `windowBands()` in `render/draw.ts`: a rounded band behind the cells, appended before them so they sit on top, and an empty window as a thin bar where it starts. A string can't be drawn as cells, so `applyHints()` turns a string a window is over into a list of its characters on every step (`charsOf()` reads them back from the repr, escapes and all), with an id made from its frame and name, so it's one object from step to step and animates like any list. Ends that are a single name join the index names, so they're drawn as pointers; names only added to an end are lengths and are left out of them.

**Values drawn another way.** `chars`, `bits` and `format` change values before anything is drawn, in `applyHints()`, like `hide` does: on every step, a hinted string becomes a list of its characters, a hinted number a list of its bits (`typeName: "bits"`, as wide as the widest the number gets in the run, found first, so the row never changes width; the views number its cells from the right), and a formatted number's repr becomes the formatted text (`formatNumber()`), as do the numbers in a list or dict the variable holds. New lists get ids from their frame and name, so they're one object from step to step and animate like any list. Everything after (the diff, both views, Save SVG) just sees values.

**Regions and compares** are windows' relatives. A `region` is a `WindowHint` with a label and a place among its list's regions (for one of four colors); `windowBands()` draws it flatter and inside its cells' edges, so neighboring regions don't overlap, with its label on a row above the index numbers that only lists with labeled regions get (`REGION_H`). `compareMarks()` outlines the two cells a `compare` names, worked out like a window's ends; a CSS animation flashes them when either moves.

**Watch and check** use [`trace/expr.ts`](../src/trace/expr.ts): a small parser for arithmetic, comparisons, `and`/`or`/`not` (and `&&`, `||`, `!`), `in`, indexing, slices, `.length` and a few functions, and an evaluator over a row's variables, reading lists and dicts from the row's heap. It can only read: there's no assignment and no calls but its own functions. A `watch`'s value goes after the row's variables; a `check` that's false adds `is-failing` to the row, a red band under it, and `✗` with its text. Expressions are parsed once and kept (`compiled()`).

**Rows by, label and focus.** `rows by` changes the loop scene's `label()`: a row is labeled by the first named variable in its loop's header, or with one loop, any named variable it has. `label` gives `findLinkedTrack()` the field to show in a node, and the memory scene's `title()` adds that field's value to the box's title. `focus` is resolved against `trace.loops` (`focusedLoop()`): the loop controller uses it when no tab is picked and that loop is one of those running.

**Help in the editor.** [`hintAssist.ts`](../src/hintAssist.ts) is plain functions of a line of text, a column and a `HintContext`: the variables the last run had (what kinds of value each held) and its classes with their fields and links, read from the trace before hints are applied, so hidden variables still count. `completionsAt()` works out where in a hint the cursor is (the keyword, a container before `:`, names after it, a class's fields inside its parentheses, graph options) and offers what fits there; `nameProblems()` and `keywordProblem()` find names the run never had, with the closest one (an edit distance where swapping two letters is one slip); `suggestionsFor()` looks at a loop (by indentation in Python, braces otherwise) for a list or string read at two ends of a pair of names or sliced, and offers a window hint for the line above it. [`hintEditor.ts`](../src/hintEditor.ts) wires these into Monaco as a completion provider, a hover provider, a code action provider and Info markers, all registered once for Python, JavaScript and TypeScript.

## 13. Animation and playback

Every step still draws a fresh SVG, the same way as before. Animation is layered on top with the [FLIP](https://aerotwist.com/blog/flip-your-animations/) technique (First, Last, Invert, Play) in [`render/animate.ts`](../src/render/animate.ts):

1. **First.** Before re-rendering, `snapshot()` records where things are in the current drawing: every element with a `data-flip` key (boxes, pointer markers, linked nodes) and every `data-cell` (a list cell's container and slot, with the value it holds).
2. **Last.** The new step is rendered normally.
3. **Invert and play.** `transition()` looks up each new element's key in the snapshot and animates it from the old position to its new one with a `transform: translate(...)` that runs back to zero. A cell whose value was in a *different* slot of the same container a moment ago (a swap, a shift) slides from that slot. New elements, and cells in slots a list didn't have a moment ago, arrive as the window's `enterFade` and `enterSlide` settings say (passed in as `enter`): a fade over 60% of the duration, a 10px slide from the left with the window's easing, both or neither. Elements marked `data-no-fade` (the printed-output card) are skipped, since they animate in on their own. Arrows are deliberately left alone and appear at their final route immediately: fading every arrow on every step was more clutter than help, and a re-routed arrow can't be morphed meaningfully anyway. In the loop history's animated mode, nested loops each have a live row and can show the same list, so each row's keys are put under its loop's name (`scopeToLoop()` in `render/loopView/layout.ts`); otherwise the outer row's list would be matched with the inner row's and slide in from there on every step the inner loop takes.

**Why it's fast.** Positions come from `data-x`/`data-y` attributes the renderers write in diagram units, never from `getBoundingClientRect()`, so a step never forces the browser to compute layout before painting. Only `transform` and `opacity` are animated, with the Web Animations API (`element.animate`), so the browser can run them on the compositor without repainting the diagram. The viewport also caches its own size with a `ResizeObserver` instead of measuring, and its "keep the current iteration in view" scrolling works in diagram units. Together, rendering and starting the animations takes about 2 ms per step (10 ms at worst) on the examples, which keeps 16 steps per second at 60 fps.

**Playback** ([`app/playbackController.ts`](../src/app/playbackController.ts)) is a `setTimeout` chain at `1000 / speed` ms that calls `goTo(step + 1, { playing: true })`. `goTo()` animates only when it moves exactly one step. Each window then animates with its own easing and duration from the Style panel (`animationFor()` in `app/styleController.ts`), capped at `0.75 × interval` while playing, so an animation always ends before the next one starts. Every other kind of navigation calls `goTo()` without `playing`, which pauses. `prefersReducedMotion()` turns animation off entirely.

## 14. Styling

[`appearance.ts`](../src/appearance.ts) holds the settings: one `PaneStyle` per window (background, grid, easing, duration), a color per entry in `COLOR_FIELDS`, line weights, the font and the presets. Everything visual is a CSS custom property, so `applyAppearance()` only sets variables, with nothing re-rendered, which is why changes show up immediately:

- **Diagram colors and line weights** are set on the `#canvas` element, so they don't leak into the toolbar or the editor. The stylesheet draws everything in terms of them: `stroke-width: calc(1.5px * var(--arrow-width))`, `rx: var(--cell-radius)`, `fill: var(--paper-ink-soft)` for text on the background, and so on.
- **Each window's background** (`--paper`, `--paper-grid`, `--grid-image`) is set on its section, so the header strip and the viewport both inherit it. The header's tint and borders are `color-mix()`es of the background and ink, so they suit any background. The grid's square size isn't CSS, because the viewport scales it with the zoom, so `Viewport.setGridSize()` takes it.
- **Easing and duration** aren't CSS either. The style controller reads them for each window when it animates a step, and passes them to `transition()` in `animate.ts`.

Saved settings are read by `parseAppearance()`, which checks every field and falls back to the default for anything missing or invalid, so an old or hand-edited setting can't break the canvas. [`stylePanel.ts`](../src/stylePanel.ts) builds the panel from the same field lists. Each control registers a `sync()` that re-reads its value, so choosing a preset updates every control at once.

### Spacing (the Layout panel)

The layout's spacing (column gaps, lanes, row gaps...) lives in [`render/spacing.ts`](../src/render/spacing.ts): `DEFAULT_SPACING` with the designed values, and `SPACING_FIELDS` with each setting's label, help text, range and step, which the panel ([`spacingPanel.ts`](../src/spacingPanel.ts)) is built from. The layout modules keep their named constants (`LANE` in `route.ts`, `MIN_GAP` in `memoryView/layout.ts`, `ROW_GAP` in `loopView/shared.ts`...), but as `let`s that `onSpacingChange()` refreshes from the current spacing. An exported `let` is a live binding, so every module that imports `ROW_GAP` sees the new value, and the layout code reads exactly as it did with fixed numbers.

Unlike the Style panel, spacing can't be a CSS variable: it changes where everything goes. So [`app/spacingController.ts`](../src/app/spacingController.ts) calls `setSpacing()` and then redraws the step, without animation, once per frame however fast a slider moves. Saved spacing stores only what differs from the defaults, so a later change to a default still reaches anyone who never touched that setting. Saved layouts are a list of names and values beside it.

The ranges are what the layout handles, and `spacing.test.ts` checks them: with every setting at its minimum, at its maximum, and each memory setting alone at either end, every JavaScript example draws with no overlapping boxes, no arrow through a box and no `NaN`. Settings that are only safe together are made safe in the layout rather than by narrowing the sliders: a column gap is never narrower than its lanes need (`2 × inset + (lanes − 1) × lane spacing`), a tree's slots are never closer than the lane inset, and a tree keeps room above it and between its levels for arrows that turn in above a node (the tree turn-in). At the default spacing none of these apply, so the defaults draw exactly as before.

## 15. Graphs

[`trace/graph.ts`](../src/trace/graph.ts) is pure, like `linked.ts`, and has its own tests ([`graph.test.ts`](../src/trace/graph.test.ts)). It does four things.

**Finding graphs.** `findGraphs(trace, scopes, heap)` looks at the variables in view, and one level into objects, for `self.adj`. Hinted graphs come first. Then come dicts whose values are all collections of primitives, with 2 to 40 nodes, where at least half the neighbors are also keys. Then come classes whose objects hold a non-empty list, set or dict of objects of the same class (`linkClasses()`). Lists of lists are only read as graphs with a hint, since grids look the same.

**Node keys.** A node named by a dict key and by an item in a neighbor list has to compare equal, but the trace stores the two differently: Python's `'A'` keeps its quotes, a JavaScript object key `A` has none, and the JavaScript key `3` is the string `"3"`. `primNodeKey()` normalizes them all to `s:A` or `n:3`. Object nodes use their heap id.

**Reading the state.** `graphOverlay()` goes through every variable in view and asks two questions: does it hold nodes (directly, or in `(priority, node)` pairs), and what kind of container is it? The rules in [the table above](user-guide.md#your-algorithms-state-drawn-on-the-graph) come from that. Names only break ties, using the short regular-expression lists at the top of the overlay section (`VISITED_NAMES`, `PARENT_NAMES` and so on). For graphs whose nodes are exactly `0..n-1`, a list of length `n` is read as one value per node. Pointers are primitives that name a node, held by a conventional name, a name used as a subscript of the graph (`graph[node]`), or a name in a hint.

**Layout.** `layoutFor(trace, graph)` lays out a graph once per run, using every node and edge it has at any step. That takes one pass over the trace, cached per trace in a `WeakMap`, so nodes never move while the graph is built, and the memory view and loop history agree. The same pass finds where the algorithm starts: the first node it queues or visits. `computeLayout()` (in [`trace/graphLayout.ts`](../src/trace/graphLayout.ts), our own; no layout library) picks one of four layouts:

- **Layered** for trees, directed graphs without cycles, and directed graphs with a few cycles. It's the classic layered pipeline:
  1. *Tidy the edges.* Self-loops take no part; an undirected edge listed from both ends, a repeated edge and a two-way pair are one connection.
  2. *Break cycles.* A depth-first walk from the start (then from nodes nothing points to, in program order) turns each edge that leads back to a node still on the walk. Those are the back edges, drawn pointing up. Undirected graphs are layered by breadth-first distance from the start instead.
  3. *Layers.* Longest path from the top, then each node nothing points to moves down to just above its highest child, so its edges are short. The start stays on top.
  4. *Placeholders.* An edge spanning several layers gets an invisible point in each layer it crosses, so it bends around the nodes in between.
  5. *Order.* From a depth-first order (subtrees together, children in program order), sweeps down and up order each layer by the median position of its neighbors, and neighbors swap whenever that removes crossings. The order with the fewest crossings wins. A tree keeps its depth-first order, which has no crossings, so children stay left to right as the program has them.
  6. *Positions*, two ways, keeping whichever bends fewer long edges, then leans edges less:
     - *Brandes–Köpf* ("Fast and simple horizontal coordinate assignment"): each node lines up with a median neighbor, long edges first (a segment between two placeholders wins over any segment crossing it), so a long edge runs straight down. Four passes (aligning up or down, packing left or right) are balanced by averaging the middle two of each node's four positions. If the packing ever breaks a minimum gap (the original method can, rarely), this result is dropped.
     - *Least squares*: each node as close as it can be to the average of its neighbors above and below, keeping the order and a minimum gap, solved exactly per sweep (isotonic regression by pool adjacent violators).

  Separate pieces are laid out apart and put side by side, the start's first; nodes with no edges go in a block on the right. Layers are used when cycle breaking turns only a few edges, the graph isn't dense, and its edges don't mostly go both ways (that's really an undirected graph).
- **Circle** for a ring (every node linked to exactly two others, all in one loop), in ring order from the start, at the top. A small dense graph (4 to 8 nodes, most pairs linked) gets a circle too, in program order or breadth-first from the start, unless the stress layout crosses fewer edges.
- **Grid** (rows) for nodes with no edges at all.
- **Stress** for everything else (still called `force` in hints and in `GraphLayout.mode`). Each connected piece is laid out on its own:
  1. *Distances.* Breadth-first search from every node gives the hops between every pair; one hop is 1.2 units.
  2. *Stress majorization.* Each node in turn moves to where its distances to all the others fit best, near pairs mattering most (weights 1/d²), until nothing moves.
  3. *Several starts.* Stress has local minima, so it runs from classical scaling (the top two eigenvectors of the double-centered squared distances, by power iteration from a fixed vector) and from circles in program order and breadth-first order from the start, and keeps the result with the fewest crossings, then the least stress.
  4. *Turned.* When most edges share directions a right angle apart, they're lined up with the axes (a grid comes out square, not as a diamond); otherwise the long side goes horizontal. Then wider than tall, with the start at the top left.
  5. *Edges clear of nodes.* Nodes are nudged off straight edges that would pass through them, as long as that adds no crossings. An edge still in the way bends around the node: a route with one bend, on whichever side passes no node and crosses the fewest edges.

  The pieces are packed in rows about as wide as a square of them would be, the start's first; nodes with no edges go in a block last.

Nothing is random and every tie goes to program order, so the same graph gets the same picture every time, in every browser. `graphLayout.test.ts` checks each of these cases, that nothing overlaps and no edge runs through a node, that a grid comes out as a grid, that 150- and 200-node graphs lay out quickly, and that no example graph (nor a grid, a cube or the Petersen graph) has more crossings than the previous layouts (kept in `src/testing/legacyGraphLayout.ts` for that comparison).

The same pass records every kind of state the graph is ever drawn with, so its legend, and therefore its size, stays the same from the first step to the last.

**Drawing.** [`render/graphView.ts`](../src/render/graphView.ts) turns layout units into pixels: one unit is the widest node plus a gap. A layered graph can run left to right instead (`sidewaysFits()`): when a hint asks (`sideways`), or when a layer has eight nodes or more, the picture would be more than 2.5 times wider than tall, and the window is taller than wide (the controllers pass `tall` into the scenes). The layout is turned (x and y swapped, bends too); layers become columns the widest node plus 64 pixels apart, and angled edges cross between columns instead of between rows.

- **Edges** are shaped in [`render/graphEdges.ts`](../src/render/graphEdges.ts) (pure geometry, tested in `graphEdges.test.ts`), by the graph's edge style, a hint option:
  - *auto* (the default): straight lines, clipped to node outlines. A long edge in a layered layout runs through its placeholders as a smooth curve (Catmull-Rom, as cubic Béziers), and so does an edge the layout bent around a node.
  - *curved*: every other edge a gentle arc too, bowing by 12% of its length (10 to 26 pixels).
  - *straight*: straight lines only, bends ignored.
  - *angled*: horizontal and vertical lines with rounded corners. In layers, each step between two layers leaves a node straight down (or up), crosses its gap at a track, and arrives straight down; steps crossing the same gap get separate tracks where their spans overlap (greedy interval coloring), between the ▲ names under one layer and the badges over the next. Otherwise an edge is an L, across first or down first, whichever passes fewer nodes; when both run into one (a grid's corner), a straight line if that's clear. The layout helps: an angled graph that isn't in layers has its nodes lined up in rows and columns (coordinates within 0.4 units share one).

  An undirected edge (listed from both ends) is drawn once. Repeated edges get lanes side by side, a directed two-way pair two bowed curves, a back edge between neighboring layers a bow, and a self-loop a loop off the node's right side.
- **Weight labels** are placed last (`placeLabels()`): halfway along the edge if no node, legend or earlier label is there, else at the first clear spot from a few points along the edge (40%, 60%, 30%...), on it or just beside it; if none is clear, where it covers least. They have a halo.
- **Nodes** carry classes for their state, plus badges for queue order and labels.
- **▲ markers** carry `data-flip` keys, so they slide when animated.

In the memory view, a graph is one box drawn in place of its *host*: the dict or list, or for a graph of objects, its first node object. Every other node object and its neighbor list is an alias of that box, so an arrow from a variable lands on the box's left edge, level with the node it points at. The loop history caches each row's graphs for the run, so stepping through a long loop doesn't search for graphs again.

## Pointer detection

Pointer markers under a list are chosen in two ways. First, any name used as a subscript of that list anywhere in the code (found by the `ast` pass in Python, or the Babel analysis pass in JavaScript and TypeScript) is shown if it currently holds a whole number. So `arr[j]` makes `j` a pointer on `arr`. Second, for lists that the code indexes, a few conventional names are always considered: `lo`, `hi`, `low`, `high`, `left`, `right`, `l`, `r`, `start`, `end`, `mid`, `slow`, `fast`. That's how binary search gets `lo` and `hi` markers even though the code only ever writes `nums[mid]`. Third, a [`viz: pointers` hint](hints.md#hints-viz-comments) adds names explicitly, by merging them into the same index analysis. A marker for an index equal to the list's length (one past the end) is drawn hollow. The list is in [`render/draw.ts`](../src/render/draw.ts) (`CONVENTIONAL_POINTERS`).

## 16. The editor

The editor is Monaco, set up across two files.

**[`monaco.ts`](../src/monaco.ts) builds a lean Monaco.** The usual `import * as monaco from "monaco-editor"` pulls in every language Monaco knows plus the TypeScript, CSS, HTML and JSON language services, which comes to about 14 MB built. This file instead imports Monaco's core API, the same list of editor features that Monaco's own `editor.main.js` uses (find, multi-cursor, command palette, folding, line operations and so on), and only the Python, JavaScript and TypeScript tokenizers. The result is about 4 MB (about 1 MB gzipped), and each tokenizer loads lazily as a chunk of about 4 kB. This is syntax highlighting only. Monaco's JavaScript IntelliSense comes from its TypeScript language service, which is most of the 14 MB, so it's left out.

Each language has its own Monaco model, the equivalent of a separate open file in VS Code. Switching languages swaps models, so each keeps its own text, cursor and undo history. Python models use 4-space indentation, and JavaScript and TypeScript models use 2.

Two pieces of build configuration make this work, both in [`vite.config.ts`](../vite.config.ts):

- **The `monaco-esm/` alias** points at `node_modules/monaco-editor/esm/vs/`. It's needed because the package's `exports` map can't resolve the CSS files that Monaco's modules import. `tsconfig.json` has a matching `paths` entry so TypeScript finds the type declarations.
- **`optimizeDeps.exclude`** stops Vite from pre-bundling Monaco in dev, which would otherwise break the `?worker` import. The trade-off is that the dev server serves Monaco as about a thousand individual modules, so the first page load in dev takes a few seconds. Production builds are bundled normally.

`monaco.ts` also sets `self.MonacoEnvironment` so Monaco can run its background work (diffing, word-based suggestions, link detection) in its own worker. This is separate from the Pyodide worker.

**[`editor.ts`](../src/editor.ts) configures the editor.** It defines a theme matching the rest of the app, registers the PR0L1NE commands with `editor.addAction()` (which is what puts them in the `F1` command palette with their keybindings), and draws the execution markers with a decorations collection: each marker is a whole-line decoration with a class for the tint, a class for the gutter bar, and an overview ruler color. Errors are additionally set as model markers with `monaco.editor.setModelMarkers()`, which gives the squiggle, the hover message and `F8` navigation for free. The editor scrolls to follow execution only when it doesn't have text focus, so it never jumps while you type.

If you upgrade Monaco, the feature import list in `monaco.ts` may need regenerating. The command to do that is in the comment at the top of the file.

## 17. Memory sizes

Sizes are worked out in two places.

**Python's come from the tracer.** The serializer ([`serialize.py`](../src/worker/serialize.py)) records `size` on every container, instance, function and class, on strings and bytes (whose length the shortened repr can't tell), and on ints too big for 30 bits. Lists also get `capacity`, from `(getsizeof(list) - getsizeof([])) // pointer size`. Fixed sizes (a small int is always 28 bytes) aren't recorded, to keep traces small.

In the browser, `struct.calcsize("P")` is 4, so `size64()` ([`sizes.py`](../src/worker/sizes.py)) converts each size to its 64-bit equivalent: objects made of pointers double; ints and bools add 12 bytes (the header grows by 12, and the 30-bit digits stay 4 bytes); floats and complex add 8; strings add 20 (ASCII) or 28; bytes add 16; `None` is 16. Dicts don't scale evenly, because their index table's width depends on the table size, so `dict_size64()` solves for the number of slots and usable entries from the 32-bit size and rebuilds the 64-bit layout. An instance's size includes its attribute dict, as you'd count it by hand. These rules were checked against 64-bit CPython by running the tracer's tests in Pyodide (`npm run test:pyodide`).

**Everything else is [`trace/memory.ts`](../src/trace/memory.ts).** `stepSizes(step, model)` returns, for one step, each object's own size and total, each cell's size, each frame's total and the program total. Python's model reads the recorded sizes (and the fixed ones: int 28, float 24, `None` 16, and so on). The textbook and V8 models are formulas over the trace's own structure, so they need nothing from the tracer: a JavaScript string's real length comes along when its repr is shortened. Totals walk references with a `seen` set, so shared objects count once. A cell's size is its slot plus what it holds: 8 bytes for a textbook number; 8 + 28 for a Python int, since the slot points at a separate object.

Results are cached in a `WeakMap` keyed by step, so drawing both views, or stepping back and forth, computes each step once. The renderers only add text: a `<tspan class="mem-size">` in label lines, a `cell-size` row above the index row, a `box-size` in title bars and a `loop-size` under each row's name in the loop history. Cells widen to fit their size where needed, and [`layout.test.ts`](../src/render/layout.test.ts) renders every example with each model to check that sizes never make boxes overlap or arrows cross them.

## asyncio on a virtual clock

Pyodide's event loop is the browser's, and the browser's can't block. So Pyodide replaces `asyncio.run` with a version that hands the coroutine to that loop, which only works when WebAssembly stack switching is set up, and even then runs your coroutines from browser callbacks, outside `sys.settrace`. Instead, while a program that mentions `asyncio` is traced, the tracer installs the standard `asyncio.run`, clears Pyodide's running loop, and sets an event loop policy whose loops are the standard pure-Python `BaseEventLoop` with one change: where it would wait for I/O, it moves its clock forward to the next timer instead. Sleeps cost no time, and tasks still wake in the right order. If every task is waiting and no timer is due, which would hang forever, it stops with an error instead. Everything is put back after the run, by one context manager the tracer and Measure share ([`virtual_asyncio.py`](../src/worker/virtual_asyncio.py)). The same loop is used outside the browser, so traces match.

## 18. Complexity estimates

Three parts: each tracer describes the code's shape, [`trace/bigO.ts`](../src/trace/bigO.ts) does the arithmetic, and [`trace/complexity.ts`](../src/trace/complexity.ts) puts the two together with the run.

**The shape** (`Trace.cost`, a `CostInfo`) is a tree per function, written by `cost_analysis()` in [`shape.py`](../src/worker/shape.py) from Python's `ast` (with `shape_names.py`, `shape_loops.py` and `shape_costs.py`), and by [`js/cost.ts`](../src/js/cost.ts) from the Babel AST before instrumentation (with the files in [`js/costs/`](../src/js/costs): `sizes.ts`, `loops.ts` and `shape.ts` read the code, and `arrays.ts`, `strings.ts`, `maps.ts` and `builtins.ts` are tables of what each built-in costs), in the same language-neutral format:

- **loop** nodes, with the `LoopInfo` id when there is one, and a bound: `size` (a list of `SizeRef`s that add), `log`, `const`, or `unknown`. Comprehensions and array callbacks (`arr.map(x => ...)`) are loops too, with their body inside.
- **call** nodes for the program's own functions, with each argument as a `SizeRef` the callee's sizes can be renamed to, and for recursive calls, how the argument shrinks: `minus` (`n - 1`, `i + 1`, `items[1:]`), `half` (`n // 2`, `items[:mid]` where `mid` was assigned a halving), `child` (`node.left`), or `unknown`. A parameter that moves both ways across calls (`r + 1` and `r - 1`) is a search, so it's `unknown`. A call that's the whole of a `return` is marked `alt`: of `return f(a)` in one branch and `return f(b)` in another, only one runs.
- **op** nodes for built-ins that aren't O(1), with their size and, for `in` and friends, the container's name, so the run can say whether it was a list or a set.
- **alloc** nodes for memory: a sized creation (`[0] * n`, a comprehension, a slice) or one item `into` a collection that grows.

A `SizeRef` names a size the way the program does: `{ name: "nums", len: true }` is `len(nums)`; `{ name: "n" }` is the value of n; `inner` is one item's length (a node's neighbor list, a grid's row). Names are resolved through simple assignments (`n = len(nums)`, `hi = len(nums) - 1`, `left = merge_sort(items[:mid])` is as big as `items`) and loop variables (`range(i)` inside `for i in range(n)` is n). The analysis never stops a run: if it throws, the trace just has no `cost`.

**The algebra** in `bigO.ts` represents an expression as a sum of terms, each a product over sizes of a power, a log power, an exponential and a factorial. Adding drops terms another term dominates (n² + n is n²) but keeps terms in different sizes (V + E). A per-item size like "neighbors of one node" can be 0, so V·d doesn't swallow V. `format()` writes the textbook forms: superscripts, `n log n`, `n·m`, `2ⁿ`.

**Putting it together**, `estimateComplexity(trace)` (cached per trace, about 10 to 25 ms for a 3,000-step run, done after the step is drawn):

1. Turns each `SizeRef` into a symbol, by looking the name up in the run: a list's length, a number's value, an object's count of same-class objects reachable from it (a linked list's nodes). A dict whose values are lists is a graph, so its length is V and the sum of its lists is E.
2. Works out each function bottom-up. A loop's cost is its bound times its body. Calls substitute the callee's cost, renamed from its parameters to the caller's arguments. Recursion is solved from the number of self-calls `a`, how they shrink, and the work per call `f`: `half` uses the master theorem (with `a = 2` and linear `f`, n log n), `minus` gives n·f for one call and aⁿ for more, `child` gives (nodes)·f, and a memo gives (values)·f.
3. Checks against the run, honestly. Only loop runs and calls the trace finished count: when a trace stops early, a loop still running at its last step would look shorter than it is, so its partial count is left out, and a loop that depends on the data and never finished is noted ("the trace stopped before it finished") instead of being sized from part of a run. If Measure has run the same code, its full counts fill in (passes per entry, and calls per function, `(counted by Measure)`). In a sampled trace, an inner loop's total over the loop around it is scaled up by the passes that weren't recorded, and call counts come from the tracer's own counts, which include every call. `RunFacts` counts each loop's passes per run (from the steps' `LoopContext`s) and, for a nested loop, its total passes over each run of the loop around it; and each function's calls and deepest recursion. `match()` turns a count into a size by comparing it with the values of the inputs that existed when that code ran: close to a size, about log₂ of one (only for sizes of 16 or more, since small logs are indistinguishable from "a few"), about a square, or "at most" the next size up.
4. Names the sizes: graph sizes V, E and d; one-letter variables keep their names; everything else gets n, m, k... A grid's rows times columns is written n·m.

Explanations are written with placeholders for any Big-O they mention, filled in once the sizes have their letters. The editor labels are an `::after` per label with its text in a generated stylesheet, since the trimmed-down Monaco build doesn't draw injected text. [`complexityPanel.ts`](../src/complexityPanel.ts) draws the chip, the panel and the labels' hover text.

[`complexity.test.ts`](../src/trace/complexity.test.ts) pins the textbook answer for every algorithm example in all three languages (bubble sort O(n²), merge sort O(n log n), BFS O(V + E), Kruskal's O(E log E), and so on), plus amortization, recursion patterns and the notes.

## 19. Measuring

[`worker/measure.py`](../src/worker/measure.py) and [`js/measure.ts`](../src/js/measure.ts) run a program at full size and return a `Measurement` ([`trace/measurement.ts`](../src/trace/measurement.ts)): counts per line, passes per loop, work per line inside built-ins, the length of each loop as it started, times, memory and the output.

**Counting without tracing.** Tracing calls a function on every line, about 100 times slower than the program itself, so it couldn't run 400 million lines. Instead, each language's syntax tree is rewritten with counters ([`worker/counters.py`](../src/worker/counters.py) for Python):

- before every statement, `_mc[12] += 1` (Python) or `__m.c[__m.l = 12]++` (JavaScript, which also remembers the line running);
- first in every function, a call `_mf[3] += 1` (`__m.f[3]++`), by the line the function starts on;
- first in every loop body, a pass `_mp[5] += 1`, and in loop bodies and functions, a countdown that every 5,000 times checks the clock: it reports progress every quarter second and raises at the time limit. (Python's is a `BaseException`, so `except Exception` can't swallow it; JavaScript's keeps throwing at every check after.) Recursion without loops is caught by the check at the top of each function.
- a loop's length is noted as it starts: `for x in _miter(5, xs)` records `len(xs)` when it has one, and a JavaScript `for (let i = A; i < B; i++)` records `B - A` when both are simple. Progress, and the projection for a run stopped at the limit, use the outermost loop still running: passes done over its length, and the time so far over that fraction.

That costs 2 to 4 times the program's own time, against about 100 for tracing. Line numbers are kept, so errors still point at the right line.

**Work inside built-ins.** In Python, calls like `xs.insert(...)`, `xs.pop(i)`, `xs.index(...)`, `v in xs`, `xs[a:b]`, `sorted(xs)` and `sum(xs)` are rewritten to `(_mw(line, xs, kind) or <the call>)` when their container is a plain name or attribute, so it can be read first without side effects. `_mw` adds the container's length if it's a list, tuple, string or deque (sets and dicts are hashed, so they cost nothing extra), and returns None so the call itself still runs. In JavaScript, the `Array.prototype` methods that aren't O(1) (`shift`, `unshift`, `splice`, `indexOf`, `includes`, `slice`, `concat`, `sort`...) are wrapped for the run and put back after: each adds its array's length to the line in `__m.l`. Sorting counts n·log₂ n. Formatting `console.log` output and the event loop's own calls aren't counted.

**Times and memory.** If counting took under 5 seconds, the untouched program runs again for its time. Python's peak memory needs `tracemalloc`, which slows a program 25 to 80 times, so it's measured in a third run only for programs that took under a quarter of a second untouched. What the variables hold at the end is always added up, walking from the globals with the tracer's `size64()`.

**In the browser,** the workers answer a `measure` message with `measureProgress` messages and then `measured` ([`worker/protocol.ts`](../src/worker/protocol.ts)). The program stops itself at the limit; the runner only terminates the worker (and starts a fresh one) when the person presses Stop, or if the program is stuck past the limit inside a single built-in call. [`measurePanel.ts`](../src/measurePanel.ts) draws the panel and the editor's heat map: a tint per line on a log scale of its count plus work, and the count as an `::after` label like the complexity labels.

## 20. Sampling, strips and shared steps

**Sampling.** Both tracers ([`sampling.py`](../src/worker/sampling.py) for Python, [`sampling.ts`](../src/js/sampling.ts) for JavaScript) follow the rules in [`trace/policy.ts`](../src/trace/policy.ts), sent to both with each run; the numbers below are its. They keep a state per running loop: its pass, its length when it's known as it starts (a Python `for` over something with a `len()`, from a rewrite to `for x in __viz_len__(line, xs)`; a JavaScript `for...of` over an array, string, Map or Set, or a counted `for (let i = A; i < B; i++)`), and a mode decided after its first 5 passes. A loop of known length whose passes would use more than half the room left is `sampled`; one of unknown length is `watch`ed, and sampled once it has used a quarter. In a sampled loop, each pass is kept or not as it starts: the first 5, the last 5 when the length is known, and round numbers (10, 20 … 100, 200 …) while the loop's steps so far, plus room for its last passes, fit in 60% of its share. Every event is counted in `counts`; an event in a pass that isn't kept adds to the next recorded step's `skipped`.

A loop of unknown length can't know its last passes until it ends, so its passes go into a buffer of the latest 5 (each pass capped at a quarter of the budget). Kept passes that arrive meanwhile (round numbers) are pinned in the buffer, so the order stays right. When the loop ends, the buffer is saved; passes that fall out of it become `skipped`. "Loops" that aren't loop statements are sampled too, without the buffer: the same function called again and again from one line (a callback), and, in Python, the same line running again and again (a comprehension).

**Strips and windows.** Before serializing a step, each tracer looks at every list longer than 60 in the frames on the stack: the names it's indexed with (from the static analysis, `viz: pointers` hints and conventional names like `lo` and `hi`) that hold whole numbers in the same frame give the window, centered on them and rounded to a multiple of 10. A list of numbers also gets 256 samples, read by index, so it costs the same for 40,000 items as for 400. Slot keys in diffs are real indices, so highlights and arrows line up when the window moves.

**Shared steps.** The Python tracer compares each object with the previous recorded step's (`dict` equality, in C) and sends only the ones that differ, plus every id in order: the trace that crosses from the worker is 3 to 15 times smaller. The JavaScript runtime compares with `sameData()` and reuses the previous step's object when equal; `postMessage` keeps shared objects shared, so the page gets the same structure either way.

## 21. Growth runs

[`trace/growth.ts`](../src/trace/growth.ts) is the arithmetic, [`growthView.ts`](../src/growthView.ts) the panel section and charts, and `measureGrowth()` in [`app/measureController.ts`](../src/app/measureController.ts) runs the ladder.

- **Sizes.** `findSizes()` reads the `viz: size` hints straight from the code (no trace needed) and finds each name's top-level `name = <integer>` with a regular expression. Growth runs need that line: Measure rewrites it. Python's `apply_overrides()` replaces the value of a module-level `Assign` or `AnnAssign`; JavaScript's `applyOverrides()` replaces a top-level declarator's or assignment's numeric literal, in the counted run and the untouched one.
- **The ladder** is n/64, n/16, n/4 and n for the growing names (at least 1, with repeats dropped); other size names stay at their full size. Each size is an ordinary Measure run with `overrides` in its message.
- **Fitting** is least squares on a log scale: for each curve x^d (log x)^l, the best scale is the mean of log(y) − log(curve), and the error is what's left. A more complex curve has to fit clearly better (30% less error) to win, since four points with some constant overhead can't tell n from n log n by a hair. The slope on the log-log plot is reported too.
- **The code's estimate** is tied to the sizes by `staticGrowth()`: a size in the estimate grows if it's named like a growing variable (`k`), or if its value in the traced run equals that variable's (`len(nums)` was 40,000 when n was). Its degree is then the largest sum of those sizes' powers in any term. `compareGrowth()` says whether the two agree, differ by a log factor, or disagree, and how.
- **Charts** are hand-drawn SVG: log axes with ticks at powers of ten (and 2 and 5 between them for narrow ranges), points, a fitted curve per series, and the estimate dashed through the largest size. Kept series are stored per language in `localStorage`.

## 22. Tracing SQL

SQL is a different kind of language from the other three: a query doesn't run line by line, and has no variables or loops. It says what result it wants, and Postgres decides how to get it. So a SQL trace isn't a program's steps. It's a query's clauses, in the order they give it meaning (FROM, WHERE, SELECT, DISTINCT, ORDER BY, LIMIT), each step a table. The code is in [`src/sql/`](../src/sql/); see [SQL](sql.md) for what it looks like.

**The engine.** [`sql.worker.ts`](../src/sql/sql.worker.ts) runs in the runner like every language worker. It starts [PGlite](https://pglite.dev) (Postgres 18 compiled to WebAssembly: a real Postgres, so every value, error and rule is Postgres's own) and [libpg_query](https://github.com/pganalyze/libpg_query) (Postgres's own parser, also WebAssembly). [`engine.ts`](../src/sql/engine.ts) asks for every value as the text Postgres writes it, so what's drawn is exactly what `psql` would print.

**A run** ([`trace.ts`](../src/sql/trace.ts)) is one transaction, rolled back at the end, so nothing a program does outlives it. It loads the sample database the program names ([`databases.ts`](../src/sql/databases.ts)), then runs the script's statements in order, each in a savepoint so a failed step's query doesn't stop the run. A statement that isn't a query (CREATE TABLE, INSERT...) is one step, showing the table it changed ([`statements.ts`](../src/sql/statements.ts)): rows are told apart before and after by where Postgres keeps them (`ctid`).

**A query** ([`select.ts`](../src/sql/select.ts)) is run first as written, so its errors and its result are Postgres's own. Then it's stepped through, from its parse tree: a smaller query for each clause, written from the tree's own pieces with the deparser ([`pgsql-deparser`](https://www.npmjs.com/package/pgsql-deparser)):

| Step | The query it runs |
| --- | --- |
| FROM | `SELECT t.*, t.ctid FROM <from> ORDER BY t.ctid`: every row, and where Postgres keeps it, which is its id from here on |
| JOIN | For each table joined, the FROM up to that table (the join's own subtree, deparsed), with every joined table's columns and ids: a row's id is its rows' ids together (`c:0,8\|o:-`, `-` for the NULLs of an unmatched row), so the ids say which rows each pair came from, and which rows matched nothing |
| WHERE | The condition (and each part AND, OR and NOT join) as columns, for every row |
| GROUP BY | Which rows are in which group (`string_agg` of their ids, after the query's own SELECT list, so `GROUP BY 1` still means its first column), and what each is grouped by, worked out for each row. A group's id is its smallest row id (`min(id COLLATE "C")`), the id its row has from here on |
| Aggregates | The query's grouping again, with each aggregate, and the values each was given (`string_agg` of its argument, in row order) |
| HAVING | Its condition for each group |
| SELECT | The query's own select list, with the id, for the rows WHERE kept |
| DISTINCT | Worked out from SELECT's rows: the first of each set of identical rows stays |
| ORDER BY | The select list and the id, in the query's own ORDER BY, so `ORDER BY 2` and a name from SELECT mean what they mean in the query |
| LIMIT / OFFSET | The two numbers, worked out; the rows outside them dropped |

The id is what ties the steps together: it's how a row in the ORDER BY step is the same row as in FROM (and the same element on screen, which is why it slides). Rows keep the same place while a statement only reads, so the id stays put.

**The check.** The last step's rows must be the query's own result: in the same order when there's an ORDER BY without ties, and in any order otherwise. If they aren't (some corner of SQL the steps get wrong), the steps are dropped and the result is shown instead, saying it couldn't be stepped through. A wrong picture would be worse than none. Every SQL example's trace is a golden trace ([`src/examples/golden.test.ts`](../src/examples/golden.test.ts)), checked to be stepped through in full.

**A GROUP BY error** (a SELECT column that isn't grouped) runs the steps up to GROUP BY anyway, grouping by GROUP BY's own expressions, with the refused column worked out beside them, so the step can show a group where it has more than one value.

**Queries inside queries** ([`compose.ts`](../src/sql/compose.ts)) are stepped through first, as parts of the statement (`SqlStage.part`). A WITH query or a subquery in FROM is then made into a temporary table of its rows, under its name, and the outer query is stepped through reading that table, like any other, its rows followed by their place in it. The temporary tables are dropped after the statement. For UNION, INTERSECT and EXCEPT, the two sides are stepped through, then put together by their values, as the set operations do; an ORDER BY or LIMIT after them runs on a temporary table of the rows they made. A subquery in WHERE, SELECT or HAVING is first run on its own: if that works, it stands alone, and is stepped through first. If it fails for a column or table it can't find, it uses the outer row, and is shown as a step of what it gives for each row (the outer query's rows, with the subquery's expression as a column).

**Window functions** are a step each window, before SELECT: one query works out, for every row, its partition's key, the functions, and (for the functions that use a frame) `string_agg` of the row ids and the values, `OVER` the same window, so the frame listed is exactly the one Postgres used.

**WITH RECURSIVE** runs the recursive query by hand, pass by pass: the WITH query's name is a temporary table holding only the last pass's rows, the recursive query runs on it, and its new rows (with UNION, those not found already) are the next pass's. The main query then reads the table holding every pass's rows. The final check (the main query's own result) holds it to Postgres's own answer.

**UPDATE and DELETE** work out their WHERE for every row before they run, then show the table before and after ([`statements.ts`](../src/sql/statements.ts)). **A refused statement** (`refusedStage`) reads which rule and table from Postgres's error (`table`, `constraint`, and the key in its detail) and marks the rows involved.

**What isn't stepped through yet** (named windows, LATERAL...) is found from the parse tree by `unsupported()`, and the query is shown as its result, saying what it uses.

**Errors** keep Postgres's message, and [`explain.ts`](../src/sql/explain.ts) adds what usually causes it, by its SQLSTATE code, using what the run knows: the tables there are, their columns, and the names the query gives columns with AS.

**The trace.** A SQL trace is an ordinary trace (one step per stage, at the clause's line, so the timeline, the editor's marks, share links and the output all work as they do for any language), with the tables in `Trace.sql`. The two windows draw it with their own scenes ([`scene/sqlScene.ts`](../src/scene/sqlScene.ts)) and drawings ([`render/sqlView.ts`](../src/render/sqlView.ts)), through the same renderers as everything else: rows are groups keyed by their id, so the animation of section 13 slides them between steps.
