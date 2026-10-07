# PR0L1NE

PR0L1NE is a split-screen tool for seeing your code's data while you write it. Python, JavaScript or TypeScript goes in the editor. Next to it, a graph-paper canvas draws every variable, list, dict, object, function and scope as SVG. When your code is inside a loop, each iteration is stacked under the last one with red arrows showing exactly what changed.

![Bubble sort: each pass of the outer loop stacked, swaps drawn as crossing arrows](docs/bubble-loop.png)

It runs entirely in your browser, so there's no server to set up. Python executes in a real CPython interpreter compiled to WebAssembly ([Pyodide](https://pyodide.org)). JavaScript runs in the browser's own engine, after PR0L1NE rewrites it to report on itself as it runs. TypeScript has its types removed and then runs the same way.

---

## Contents

1. [Quick start](#quick-start)
2. [Using it](#using-it)
3. [How it works](#how-it-works)
4. [Project structure](#project-structure)
5. [Development workflow](#development-workflow)
6. [Extending it](#extending-it)
7. [Limitations](#limitations)
8. [Troubleshooting](#troubleshooting)
9. [Roadmap ideas](#roadmap-ideas)

---

## Quick start

### Requirements

- **Node.js 20 or newer** and npm (check with `node --version`).
- **An internet connection** the first time you use Python. The page downloads Pyodide (about 10 MB) from the jsDelivr CDN, and your browser caches it after that. JavaScript and TypeScript need no download.
- **A modern browser**: recent Chrome, Edge, Firefox or Safari. Code runs in ES module workers, which need Firefox 114+ or Safari 15+.
- **Optional: Python 3.12** if you want to run the Python tracer's tests or inspect Python traces from the command line. The app itself doesn't need Python installed, because Python runs inside the browser.

### Install and run

```bash
cd PR0L1NE
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). Pick **Python**, **JavaScript** or **TypeScript** in the toolbar. With Python, the status in the top-right corner reads "Loading Python…" for a few seconds on the first visit, then shows the Python version. JavaScript and TypeScript are ready immediately. The bubble sort example runs automatically.

### Other commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the dev server with hot reload. |
| `npm run build` | Type-checks, then builds a static site into `dist/`. |
| `npm run preview` | Serves the built `dist/` folder locally. |
| `npm run typecheck` | Runs the TypeScript compiler without building. |
| `npm test` | Runs all tests: the TypeScript ones, then the Python tracer's. |
| `npm run test:js` | Runs the Vitest suites: the JavaScript and TypeScript tracers, nesting, linked structures and saved programs. |
| `npm run test:tracer` | Runs the Python tracer's unit tests (needs Python 3.12). |
| `npm run trace -- file.py` | Prints the JSON trace for a Python file (needs Python 3.12). |
| `npm run trace:js -- file.js` | Prints the JSON trace for a JavaScript or TypeScript file (`.ts` files are treated as TypeScript). |
| `npm run instrument -- file.js` | Prints the instrumented version of a JavaScript or TypeScript file. |

The output of `npm run build` is plain static files. You can host `dist/` anywhere that serves static content (GitHub Pages, Netlify, an S3 bucket, `python3 -m http.server`).

---

## Using it

### Choosing a language

The menu at the left of the toolbar switches between **Python**, **JavaScript** and **TypeScript**. Each language keeps its own code, undo history, saved programs and examples, so switching back and forth doesn't lose anything. Python's runtime is only downloaded the first time you pick Python.

The visuals are the same for every language, but JavaScript's semantics show through in a few places (all of these apply to TypeScript too):

- **Block scoping is visible.** A `let` or `const` declared inside a loop or block only appears while that block is running. In the bubble sort, the inner loop's `j` shows up in the inner loop's history but not in the outer loop's, because it doesn't exist there.
- **Variables appear when they're declared.** A `let` or `const` isn't shown until its declaration has run, since reading it earlier is an error in JavaScript. A `var` appears from the start of its function as `undefined`, because that's how hoisting works.
- **Plain objects are drawn as dictionaries.** `{}` is JavaScript's everyday map, so `counts[word]++` gets the same growing-dictionary loop view as a Python dict, with keys shown unquoted. A `Map` is drawn the same way. Instances of your own classes are drawn as objects with fields.

  ![JavaScript word count: a plain object growing as a dictionary](docs/js-freq-loop.png)
- **Methods show `this`.** Inside a class method or object method, `this` appears as a variable on every step, the way Python shows `self`. Arrow functions inside a method show it too, since they share the method's `this`.
- **Function names come from where they're defined.** `const double = (x) => x * 2` appears as `double()` on the call stack, and class methods appear as `ClassName.method()`.

### TypeScript

TypeScript is traced as the JavaScript it compiles to, so everything in the previous section applies, and types themselves never appear on the canvas. That's not a shortcut: types don't exist while a program runs, so there's nothing to draw. A few things are worth knowing:

- **Types aren't checked.** PR0L1NE removes types without checking them, the way esbuild, Vite and `tsc --noCheck` do. Code with type errors still runs, and you'll see what it actually does. Syntax errors are still reported.
- **Your line numbers are exact.** Removing an `interface` or `type` doesn't shift anything, so the highlighted line is always the one you wrote.
- **Enums are real objects.** An `enum` compiles to an object, so it appears in the heap. Numeric enums map both ways (`Light.Red` is `0` and `Light[0]` is `"Red"`), which you'll see as both kinds of key.
- **Parameter properties work as expected.** `constructor(public val: T, public next: ListNode<T> | null = null) {}` sets the fields without producing extra steps for the generated `this.val = val`.
- **Compiler-generated code is hidden.** The helper functions behind enums and namespaces run without being traced, so they don't clutter the call stack. That also means code *inside* a `namespace` block runs untraced, though its exports work normally.

### Saving programs

Press **Save** or `Ctrl/Cmd + S` to keep the program you're working on. The first time, you're asked for a name. After that, `Ctrl/Cmd + S` saves over it, the way it does in VS Code. `Ctrl/Cmd + Shift + S` always asks for a name, so you can save a copy under a new one.

The program's name sits in the toolbar next to the **Open…** menu. A yellow dot after it means there are unsaved changes, and the dot disappears when you save. A program that hasn't been saved yet is shown as *Untitled*.

**Open…** lists your saved programs for the current language, most recently saved first, followed by the examples. If the program you're leaving has unsaved changes, you're asked before they're discarded. **Delete** appears while a saved program is open. Deleting it keeps the code in the editor as an untitled program, so nothing disappears from the screen until you open something else.

Saved programs are stored in your browser (in `localStorage`), separately for each language. They survive reloads and restarts, but they belong to this browser on this machine, and clearing the site's data removes them. Separately from saving, PR0L1NE always keeps whatever is in the editor, saved or not, so a reload never loses work in progress.

### The editor

The editor on the left is [Monaco](https://microsoft.github.io/monaco-editor/), the editor component VS Code is built on, so VS Code's editing and navigation keys work as you'd expect: multi-cursor (`Ctrl/Cmd + D`, `Alt + Click`), move and copy lines (`Alt + ↑/↓`, `Shift + Alt + ↑/↓`), toggle comments (`Ctrl/Cmd + /`), go to line (`Ctrl + G`), find and replace, bracket jumping, folding, and the command palette (`F1`).

With **Live** checked, the program re-runs 600 ms after you stop typing. Otherwise, press **Run** or `Ctrl/Cmd + Enter`. Your code is saved in the browser, so it survives a reload. The **Open…** menu has your [saved programs](#saving-programs) and starter examples that each exercise a different part of the canvas. Opening a program or an example is a normal edit, so `Ctrl/Cmd + Z` brings the previous code back.

PR0L1NE adds a few commands of its own, borrowing VS Code's debugger keys for stepping:

| Keys | Command |
| --- | --- |
| `Ctrl/Cmd + Enter` | Run |
| `Ctrl/Cmd + S` | Save (asks for a name the first time) |
| `Ctrl/Cmd + Shift + S` | Save as a new program |
| `F10` | Next step |
| `Shift + F10` | Previous step |
| `F1`, then type "PR0L1NE" | All PR0L1NE commands, including first and last step and swapping the panels |

While you step through a run, the editor marks lines with a tint and a bar in the gutter (and a matching mark in the scrollbar):

- **Yellow**: the line that's about to run.
- **Blue**: the line that just ran.
- **Red**: where an error happened (shown once you reach the last step). The error is also a real diagnostic with a squiggle, so hovering shows the message and `F8` jumps to it.

If you're mid-edit and the code has a syntax error, the canvas keeps showing the last version that ran (dimmed), a banner explains what's wrong, and the line is marked in the editor.

### Layout

The **⇄** button at the right end of the toolbar swaps the editor and canvas, so the canvas can be on the left if you prefer. It's also in the command palette as "PR0L1NE: Swap Editor and Canvas". Your choice is remembered.

Drag the divider between the panels to resize them, or focus it with `Tab` and use the arrow keys. Double-click it to go back to the default size. The editor keeps its width when you swap sides, and the width is remembered too. On narrow screens the panels stack vertically, and swapping puts the canvas on top.

Inside the canvas, **Memory** and **Loop history** are separate sections with a divider of their own. It works the same way: drag it, use `↑`/`↓` when it's focused, or double-click to reset. Its position is remembered.

### Moving around the canvas

Each canvas section is its own sheet of graph paper that you can move around independently:

| To | Do this |
| --- | --- |
| Pan | Drag an empty part of the paper, or scroll (two fingers on a trackpad, `Shift` + scroll to go sideways) |
| Zoom | `Ctrl/Cmd` + scroll, pinch on a trackpad or touch screen, or the **−** / **+** buttons |
| Reset the view | Click the zoom percentage, or press `0` with the section focused |
| See everything | **Fit** shrinks the diagram until it all fits (it never enlarges) |

With a section focused (click it or `Tab` to it), `+` and `−` zoom too. The arrow keys still step through the program.

Zooming centers on the pointer, so you can zoom into the part you're looking at. Each section keeps its own position and zoom as you step and as your code re-runs. While you step through a loop, the loop history pans just enough to keep the running iteration in view.

### Rearranging the memory view

Drag any box in the memory view, whether a frame or a heap object, to put it somewhere else. Arrows follow it.

A box stays where you put it as you step through the program, and through live re-runs as you edit, so you can arrange a linked list or a tree the way you think about it and then step through the algorithm. Boxes you've placed are drawn on top of the automatically placed ones, and the boxes you haven't touched keep their usual places.

**Reset layout** (next to the zoom controls, shown once you've moved something) puts every box back. Opening a different program or switching language also starts from a fresh layout.

How a box is recognized from one step, or one run, to the next:

- **Frames** by their position on the call stack and function name, so "the third `factorial()` call" keeps its place.
- **Objects** by their id. Ids are numbered in the order objects are first seen (`o1`, `o2`, ...), in every language, so the same program gives the same ids every run. If an edit changes the order objects are created in, a moved position can end up on a different object. **Reset layout** fixes that.

### The timeline

The bar at the bottom moves through the recorded steps. Use the buttons, drag the slider, or use the keyboard: `F10` / `Shift + F10` work everywhere, and `←` / `→` / `Home` / `End` work when the editor doesn't have focus (inside the editor those keys move the cursor). A step is one of:

- **About to run line N**: the state just before that line executes.
- **Called f()**: a new function call started, so a new frame appears.
- **f() returns X**: the function is about to return; its frame shows a `returns` row.
- **Error raised on line N**: an exception is propagating.

When you edit code while sitting on the last step, the view stays on the last step of the new run, so you always see the end result of what you just typed.

### The memory view

![Reversing a linked list, mid-way through](docs/ll-memory.png)

- **Frames** (scopes) are stacked on the left: `Global`, then one box per active function call. The frame that's currently executing has a dark title bar.
- **Primitives** (numbers, strings, booleans, `None`) are drawn inside the variable's cell.
- **Everything else** lives in the heap to the right and is connected by a blue arrow. Lists and tuples are rows of cells with indices above. Dicts, objects and functions are tables. Functions show the variables they've captured from an enclosing scope (closures).
- **Heap objects are arranged in columns by distance from the stack.** Things your variables point at directly sit in the first column, things those point at sit in the second, and so on. That's why a linked list or tree reads left to right.
- **Yellow** means "changed since the previous step." A dashed blue outline means "this object was just created."
- **Index pointers**: small markers under a list show where variables like `i`, `j`, `lo` and `hi` point. See [pointer detection](#pointer-detection) for how these are chosen.

![Recursion: one frame per call](docs/fact-memory.png)

### Arrows or nested boxes

The **Arrows | Nested** switch in the Memory header changes how references are drawn. Your choice is remembered, and `F1` → "PR0L1NE: Toggle Nested Memory View" switches it too.

- **Arrows** (the default) draws every object as its own box, with an arrow for every reference.
- **Nested** draws an object *inside* the thing that refers to it, as long as nothing else refers to it. A list in a variable sits right in the variable's row, an object's fields hold their sub-objects, and a list of lists looks like a grid of rows.

![A binary search tree in nested mode](docs/nested-memory.png)

Nesting can only show "this belongs to that", so anything with more than one reference stays a separate box connected by arrows. That covers objects two variables share (aliasing), nodes that `curr` points at while they're also in a list, and cycles. In the tree above, node 10 stays separate because both `root.right` and the variable `node` point at it. That's often exactly what you want to notice: in nested mode, an arrow means "shared".

Nesting stops 6 levels deep. A deeper chain continues in a new box joined by an arrow, and nesting starts again inside it, so a long linked list becomes a few readable boxes rather than a tower.

Boxes still drag the same way in nested mode. Nested objects move with the box they're in.

### Loop history

![Reversing a string with two pointers](docs/rev-loop.png)

When the current step is inside a loop, the bottom section stacks the state at the end of every iteration so far, starting with a **before** row for the state when the loop was entered. Between rows:

- **Yellow cells** changed during that iteration.
- **Red arrows** connect each changed cell to its previous row. When a value moved from one index to another (a swap), the arrow starts at the index it came from, so swaps show as crossing arrows.
- **Variables to the right** (`i = 2`, `left = 3`) are the scalars that change during the loop. The ones that changed in that iteration are red.
- **The current iteration** is highlighted while the loop is still running.

If there are several active loops (nested loops, or a loop inside a function called from a loop), tabs above the history let you pick which one to show. The innermost loop is selected by default while running, and once a loop finishes its full history stays visible until the program enters another loop.

#### Linked lists and trees

Linked nodes don't have indices, so the loop history gives them some. If the loop's variables lead to objects that link to objects of the same class (a `next`, or `left` and `right`), every node gets a fixed column, the same in every row, and each row shows where the links point at that moment:

![Reversing a linked list: the nodes stay put while the next arrows turn around](docs/linked-loop.png)

- Each node is its **value** (the first plain field, like `val` or `key`) followed by a **slot per link**. A slash in a slot means `null`/`None`.
- A link to the next column is a short straight arrow. Other links arc over the row. A second link field, like `right` in a tree, arcs underneath.
- A link that changed in that iteration is **red** and its slot is highlighted. A changed value is yellow, like a changed list cell.
- **Variables pointing at nodes** (`head`, `prev`, `curr`) are markers under the node, like `i` and `j` under a list. Inside a method, nodes reached through an object are found too, labeled `self.head` or `this.head`.
- Columns follow the links from the start of the loop, so the starting list reads left to right. Trees with two links use in-order, so a binary search tree reads sorted:

![Inserting into a binary search tree: node walks down from the root](docs/tree-loop.png)

Nodes the code can no longer reach (say, the old head after it's dropped) leave the row. Plain JavaScript objects like `{ val: 1, next: null }` count as nodes too.

**Collapse iterations with no changes** folds runs of iterations that didn't modify any container or linked node into a single "#4 to #6: nothing changed" line. This only applies to loops that modify data somewhere. In a loop that only reads (like binary search), the moving indices are the interesting part, so every row is kept:

![Binary search: the lo/hi window narrowing](docs/bsearch-loop.png)

---

## How it works

### The big picture

```
┌──────────── main thread ─────────────┐        ┌────────── Web Worker ──────────┐
│                                       │        │                                │
│  editor.ts ──code──▶ runner.ts ───────┼─run───▶│  pyodide.worker.ts   (Python)  │
│  (Monaco)            (watchdog,       │        │    └─ Pyodide (CPython/WASM)   │
│                       one per         │        │         └─ tracer.py           │
│                       language)       │        │            sys.settrace + ast  │
│                      ◀────────────────┼─trace──┤                                │
│                                       │  JSON  │  javascript.worker.ts  (JS)    │
│  main.ts holds { trace, stepIndex }   │        │    ├─ instrument.ts  (Babel)   │
│                                       │        │    └─ runtime.ts  (recorder)   │
│                                       │        │                                │
│                                       │        │  typescript.worker.ts  (TS)    │
│                                       │        │    ├─ typescript.ts  (strip)   │
│                                       │        │    └─ then same as JS          │
│                                       │        └────────────────────────────────┘
│     │                                 │
│     ├─ trace/diff.ts         what changed between step N-1 and N
│     ├─ trace/loopHistory.ts  which steps are which loop iteration
│     ├─ render/memory.ts      snapshot ─▶ SVG (frames, heap, arrows)
│     └─ render/loopView.ts    loop rows ─▶ SVG (stacked iterations)
└───────────────────────────────────────┘
```

The design rule that holds this together: **each layer only talks to the next through data.** The tracers know nothing about drawing. The renderer knows nothing about Python or JavaScript. The contract between them is the trace format in [`src/trace/types.ts`](src/trace/types.ts). That's why adding JavaScript didn't require any new rendering code, only two small tweaks (JavaScript's primitive type names, and `function` instead of `def` in function titles), and why TypeScript needed none at all.

### 1. Running code without freezing the page

User code runs in a **Web Worker**, a separate thread, so even a `while True:` can't lock up the editor.

There's one worker per language, and both speak the same small protocol, defined in [`protocol.ts`](src/worker/protocol.ts): the page sends `run` with the source code, and the worker answers with `ready`, then a `result` holding a trace.

- [`pyodide.worker.ts`](src/worker/pyodide.worker.ts) imports Pyodide from jsDelivr, loads the tracer's Python source into it (Vite bundles `tracer.py` as a string through its `?raw` import), and then answers runs.
- [`javascript.worker.ts`](src/js/javascript.worker.ts) and [`typescript.worker.ts`](src/js/typescript.worker.ts) are one-line entry points into [`serve.ts`](src/js/serve.ts), which handles the protocol. They're ready immediately, and call `traceJavaScript()` or `traceTypeScript()` for each run. Keeping them as separate workers means only the TypeScript one contains Babel's core.

[`languages.ts`](src/languages.ts) lists each language's worker, Monaco language mode and examples, so everything language-specific in the UI comes from one place.

[`runner.ts`](src/worker/runner.ts) is the main-thread side. There's one runner per language, created the first time that language is used, so someone writing JavaScript never downloads Python. It keeps one run in flight at a time, and `main.ts` drops intermediate edits so only the newest code runs after the current run finishes. It also has a **watchdog**: if a run takes longer than 10 seconds, it terminates the worker and starts a fresh one. (The tracer's own step budget, below, catches almost every runaway loop first. The watchdog is the fallback for code stuck inside a single long C call, like `sum(range(10**12))`, which never produces a trace event.)

### 2. Tracing Python with `sys.settrace`

[`tracer.py`](src/worker/tracer.py) is plain CPython, and the core trick fits in a few lines. Python lets you install a function that the interpreter calls on every event:

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

**Serialization** ([`Serializer`](src/worker/tracer.py)) turns Python values into two kinds of trace value:

- primitives (`int`, `float`, `str`, `bool`, `None`, ...) become `{"kind": "prim", "type": "int", "repr": "42"}`,
- everything else becomes a reference `{"kind": "ref", "id": "o140..."}`, and the object itself goes into the step's `heap` dictionary, recursively.

**Stable identity** is what makes "this is the same list as one step ago" possible, which every highlight and arrow depends on. The tracer numbers objects in the order it first sees them (`o1`, `o2`, ...), using Python's `id()` to recognize an object it has seen before. That makes ids the same on every run of the same program, which is how a box you've [dragged](#rearranging-the-memory-view) keeps its place through live re-runs. `id()` is only unique while an object is alive, and CPython can reuse it after an object is garbage collected. To prevent two objects sharing an id, the tracer keeps a reference to every object it has seen (`keepalive`) until the run ends.

**Safety rails:**

- **Step budget.** After `maxSteps` events (3,000 by default, set in `main.ts`), the trace function raises `StepLimitExceeded`. It subclasses `BaseException` rather than `Exception`, so user code with `except Exception:` can't swallow it.
- **Size caps.** Containers show at most 60 items and primitives at most 48 characters, so a 10,000-element list doesn't produce a huge trace.
- **Output capture.** `sys.stdout` is swapped for a `StringIO` during the run. Each step records how many characters had been printed so far, so the output panel shows exactly what was printed up to the step you're on.
- **No `input()`.** There's no keyboard in a worker, so `input()` raises an error asking you to hard-code test data.

### 3. Static analysis of Python with `ast`

Before running anything, `analyze()` parses the code with Python's own `ast` module to learn two things the runtime trace can't tell us.

**Where the loops are.** For each `for` and `while`, it records the header line and the body's line range. Each loop gets an id from its header line (`L4`).

**Which names index which containers.** Every `Subscript` node whose target is a plain name is recorded, along with the names used inside the brackets. So `arr[j + 1]` produces `{"arr": ["j"]}`. This drives [pointer detection](#pointer-detection).

### 4. Detecting loop iterations in Python

`sys.settrace` reports lines, not iterations, so iterations are inferred from line transitions inside each frame (see `update_loops`):

- **Loop entered**: execution reaches a loop's header line while the loop isn't active in this frame. A new *instance* starts at iteration 0.
- **New iteration**: execution moves *from the header line into the body*. The iteration counter goes up by one.
- **Loop exited**: execution reaches a line that's neither the header nor inside the body. The instance ends.

Counting header-to-body transitions, rather than header visits, matters because Python re-checks the header one last time before the loop ends. That final check doesn't start an iteration, so it shouldn't be counted as one. It also handles `continue` (back to the header, then into the body: a new iteration) and `break` (straight out: loop exits) without special cases.

**Instances** matter for nested loops. The inner loop of bubble sort is entered once per outer iteration, and each entry is a separate instance with its own iteration count. State is tracked per frame, so recursion (the same loop running in several frames at once) works too.

Every step stores the active loops for all frames on the stack, as `{frame, loop, instance, iteration}`. That means when a loop calls a function, steps inside the function still know which iteration of the caller's loop they belong to.

### 5. Tracing JavaScript

JavaScript has no equivalent of `sys.settrace` inside a web page. Real debugging hooks only exist in Node or browser extensions. So instead, PR0L1NE **rewrites your program to report on itself**: [`instrument.ts`](src/js/instrument.ts) parses the code with Babel, inserts calls to a recorder, and the rewritten program runs in the worker. The recorder, [`runtime.ts`](src/js/runtime.ts), builds steps in exactly the format `tracer.py` produces.

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
  __av.line(1, () => [["total", () => total]]);
  let total = 0;
  {
    __av.loopEnter("L2", 2, () => [["total", () => total]]);
    try {
      for (const x of [5, 6]) {
        __av.loopIter("L2");
        __av.line(3, () => [["total", () => total], ["x", () => x]]);
        total += x;
        __av.tail("L2", 2, () => [["total", () => total], ["x", () => x]]);
      }
    } finally {
      __av.loopExit("L2");
    }
  }
  __av.ret(void 0, () => [["total", () => total]]);
} catch (__av_e) {
  __av.raise(__av_e);
  throw __av_e;
} finally {
  __av.exit(__av_f);
}
```

`__av` is the runtime, passed in with `new Function("__av", "console", code)`. Names starting with `__av` are reserved and hidden from the canvas.

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

### 6. Tracing TypeScript

Types don't exist at runtime, so tracing TypeScript means tracing the JavaScript it compiles to. [`typescript.ts`](src/js/typescript.ts) adds one step in front of the JavaScript instrumenter:

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

### 7. The trace format

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

Each step is a complete snapshot, which keeps the renderer simple: any step can be drawn on its own, so scrubbing backward is free. The cost is memory, which is fine at algorithm-sized programs and the 3,000-step budget. To see the full trace for any program, run `npm run trace -- my_program.py` or `npm run trace:js -- my_program.js`.

### 8. Diffing snapshots

[`trace/diff.ts`](src/trace/diff.ts) compares step N-1 with step N. The key idea is that **every object is treated as a set of named slots**: a list's slots are its indices, a dict's slots are its keys, and an object's slots are its field names. Comparing slot by slot (by value for primitives, by id for references) gives:

- `changedLocals`: variables whose value or pointer changed,
- `changedSlots`: per object, which indices/keys/fields changed,
- `newObjects` and `newFrames`: things that didn't exist a step ago.

The renderers turn these into yellow cells, bold labels, and dashed outlines.

### 9. Drawing the memory view

[`render/memory.ts`](src/render/memory.ts) works in three passes:

1. **Assign columns.** A breadth-first walk starts from the frames' variables. Objects pointed at directly by a variable get column 0, objects they point at get column 1, and so on. BFS guarantees every object is assigned a column before its children.
2. **Measure.** Each object becomes a `Shape` that knows its width, its height, and where incoming arrows should land. All text inside cells uses a monospace font, where each character is exactly 0.6em wide, so sizes are pure arithmetic with no DOM measuring. Each column is as wide as its widest shape.
3. **Place and draw.** Frames go down the left side. Then objects are placed in BFS order. Each object tries to line up vertically with the first arrow pointing at it, but never overlaps the object above it in the same column. This simple rule is what makes linked lists come out as straight horizontal chains.

**Nested mode.** Anything that holds a value (a table row, a list cell) asks for a `View` of it. A plain value or a reference dot is a fixed-size cell. In nested mode, a reference to an object that should nest is the object's whole `Shape`, and rows and cells grow to fit it. Shapes are built recursively, so a nested object's own references nest or become arrows in turn.

Which objects nest is decided first, by `chooseNested()`, a pure function with its own tests. It counts every reference to each object in the snapshot (from variables, fields, items and the return value), then walks out from the variables, nesting an object only if its count is exactly 1, it hasn't been placed yet, and it's no more than 6 levels deep. It then walks out from every object that stayed separate, so things inside a shared object can still nest inside it. Dict keys never nest, since they're labels.

The column walk then runs over separate boxes only. A reference from inside a nested object counts as coming from the box it's drawn in, so arrows still lead out of nested boxes to the right column.

Each frame and object is drawn in its own `<g class="node">` carrying a key (`frame:2:factorial`, `obj:o4`) and its position. `renderMemory()` takes a `MemoryLayout`, a map from key to position for boxes the person has dragged. A dragged box is drawn at its saved position and leaves the automatic flow, so it doesn't push later boxes down. Arrows are routed using wherever boxes actually ended up, so they follow automatically. Each node group starts with an invisible rectangle covering the whole box, so a press anywhere on it, even in the gap between a list's index numbers and its cells, grabs the box rather than panning the canvas.

Arrows are drawn last, on top. A normal arrow is a horizontal S-curve into the target's left edge. A **back edge** (a target that isn't to the right, like a cycle or a half-reversed linked list) swings out to the right and enters the target's right edge, so it doesn't cut through other boxes.

### 10. Panning, zooming and dragging

Both canvas sections are wrapped in a [`Viewport`](src/render/viewport.ts). The diagram is drawn at its natural size, and the viewport applies a CSS `translate(...) scale(...)` to it, so panning and zooming never re-render anything. The graph-paper background is on the viewport itself, and its `background-position` and `background-size` follow the same pan and zoom, which is what makes the paper move with the drawing.

All input goes through pointer events, so mouse, pen and touch share one code path:

- A press on an element with a `data-node-key` starts a **node drag**, but only after it moves 3 px, so a click isn't a drag. Each move reports the box's new position in diagram units (screen pixels divided by the zoom) through `onNodeMove`. `main.ts` stores it and re-renders the memory view. That's fast because rendering is pure arithmetic, and it means arrows are always correct mid-drag.
- A press anywhere else starts a **pan**.
- A second pointer turns it into a **pinch**, which zooms around where the fingers started and pans with their midpoint. Lifting one finger carries on as a pan.
- The pointer is captured on the viewport rather than on the diagram, because the diagram is replaced on every re-render during a drag.

Wheel events pan, except with `Ctrl` or `Cmd` held, when they zoom. Browsers report trackpad pinches as `Ctrl` + wheel, so pinching works with no extra code. Panning is clamped so at least 60 px of the diagram stays on screen.

The dividers in [`main.ts`](src/main.ts) share one helper, `makeDivider()`, which handles dragging, arrow keys, double-click to reset, the `aria-valuenow` for screen readers, and remembering the position.

### 11. Drawing the loop history

[`trace/loopHistory.ts`](src/trace/loopHistory.ts) finds the steps belonging to one loop instance. Those steps are contiguous in time, so it scans outward from the current step. It then takes the *last* step of each iteration as that iteration's row. The last step of an iteration is usually the header check that starts the next one, which shows the state with all of that iteration's work done.

[`render/loopView.ts`](src/render/loopView.ts) then:

- **Picks what to show.** Containers (lists, tuples, sets, dicts) in the loop's frame are shown if they change during the loop or are indexed in the code. Scalars are shown if they change or are used as pointers. If nothing qualifies, everything in the frame is shown. This keeps unrelated variables out of the way.
- **Aligns columns.** Every row shares the same cell width and x positions per container, so index 3 is directly below index 3 in every row and arrows can be vertical.
- **Draws change arrows.** For each changed cell, it looks for a different changed index whose *previous* value equals this cell's *new* value. If it finds one, the value moved, and the arrow starts there (that's a swap). Otherwise the arrow goes straight down from the same index.
- **Collapses quiet rows**, as described in [Loop history](#loop-history), and caps the view at the latest 120 rows.

**Linked structures** come from [`trace/linked.ts`](src/trace/linked.ts), which is pure and has its own tests:

- `findLinkedTrack()` walks every row from the loop's variables (and one level through other objects, for `self.head`). It records, per class, which fields point at objects of the same class. The class with links and the most nodes is the track. Its links are those fields, plus conventionally named ones (`next`, `left`...) that are always null or a node. Its value field is the first field that's usually a primitive.
- Column order follows the links from each row's variables in turn, so the first row's structure reads left to right, and nodes that appear later go on the end. With exactly two links, it's in-order instead.
- `linkedRow()` gives one row's view: each reachable node's value and link targets, and which names point at which column. `linkedSignature()` turns that into a string, so a row counts as "changed" for collapsing when any link or value changes.

The loop view adds space above each row for arcs (and below, for a second link field) and draws the track after the containers.

### Pointer detection

Pointer markers under a list are chosen in two ways. First, any name used as a subscript of that list anywhere in the code (found by the `ast` pass in Python, or the Babel analysis pass in JavaScript and TypeScript) is shown if it currently holds a whole number. So `arr[j]` makes `j` a pointer on `arr`. Second, for lists that the code indexes, a few conventional names are always considered: `lo`, `hi`, `low`, `high`, `left`, `right`, `l`, `r`, `start`, `end`, `mid`, `slow`, `fast`. That's how binary search gets `lo` and `hi` markers even though the code only ever writes `nums[mid]`. A marker for an index equal to the list's length (one past the end) is drawn hollow. The list is in [`render/draw.ts`](src/render/draw.ts) (`CONVENTIONAL_POINTERS`).

### 12. The editor

The editor is Monaco, set up across two files.

**[`monaco.ts`](src/monaco.ts) builds a lean Monaco.** The usual `import * as monaco from "monaco-editor"` pulls in every language Monaco knows plus the TypeScript, CSS, HTML and JSON language services, which comes to about 14 MB built. This file instead imports Monaco's core API, the same list of editor features that Monaco's own `editor.main.js` uses (find, multi-cursor, command palette, folding, line operations and so on), and only the Python, JavaScript and TypeScript tokenizers. The result is about 4 MB (about 1 MB gzipped), and each tokenizer loads lazily as a chunk of about 4 kB. This is syntax highlighting only. Monaco's JavaScript IntelliSense comes from its TypeScript language service, which is most of the 14 MB, so it's left out.

Each language has its own Monaco model, the equivalent of a separate open file in VS Code. Switching languages swaps models, so each keeps its own text, cursor and undo history. Python models use 4-space indentation, and JavaScript and TypeScript models use 2.

Two pieces of build configuration make this work, both in [`vite.config.ts`](vite.config.ts):

- **The `monaco-esm/` alias** points at `node_modules/monaco-editor/esm/vs/`. It's needed because the package's `exports` map can't resolve the CSS files that Monaco's modules import. `tsconfig.json` has a matching `paths` entry so TypeScript finds the type declarations.
- **`optimizeDeps.exclude`** stops Vite from pre-bundling Monaco in dev, which would otherwise break the `?worker` import. The trade-off is that the dev server serves Monaco as about a thousand individual modules, so the first page load in dev takes a few seconds. Production builds are bundled normally.

`monaco.ts` also sets `self.MonacoEnvironment` so Monaco can run its background work (diffing, word-based suggestions, link detection) in its own worker. This is separate from the Pyodide worker.

**[`editor.ts`](src/editor.ts) configures the editor.** It defines a theme matching the rest of the app, registers the PR0L1NE commands with `editor.addAction()` (which is what puts them in the `F1` command palette with their keybindings), and draws the execution markers with a decorations collection: each marker is a whole-line decoration with a class for the tint, a class for the gutter bar, and an overview ruler color. Errors are additionally set as model markers with `monaco.editor.setModelMarkers()`, which gives the squiggle, the hover message and `F8` navigation for free. The editor scrolls to follow execution only when it doesn't have text focus, so it never jumps while you type.

If you upgrade Monaco, the feature import list in `monaco.ts` may need regenerating. The command to do that is in the comment at the top of the file.

---

## Project structure

```
PR0L1NE/
├── index.html                  Page layout: toolbar, editor, canvas, timeline
├── package.json
├── tsconfig.json               TypeScript config for the app
├── tsconfig.node.json          ...and for the Node-only CLI
├── vite.config.ts
├── docs/                       Images used in this README
└── src/
    ├── main.ts                 App state, run scheduling, rendering, controls
    ├── languages.ts            Per-language worker, Monaco mode and examples
    ├── programs.ts             Saved programs (localStorage)
    ├── programs.test.ts        Saved program tests
    ├── monaco.ts               Lean Monaco build: editor features + 2 languages
    ├── editor.ts               Monaco setup, theme, commands and line markers
    ├── examples.ts             Starter programs for both languages
    ├── styles.css              All styles, including the SVG diagram styles
    ├── trace/
    │   ├── types.ts            The trace format (the tracer/renderer contract)
    │   ├── diff.ts             What changed between two steps
    │   ├── loopHistory.ts      Group steps into loop iterations
    │   ├── linked.ts           Linked lists and trees in loop history
    │   └── linked.test.ts      Linked structure tests
    ├── render/
    │   ├── draw.ts             SVG helpers, metrics, cells, arrows, pointers
    │   ├── memory.ts           The memory view (arrows or nested, draggable boxes)
    │   ├── memory.test.ts      Tests for choosing what to nest
    │   ├── loopView.ts         The stacked loop history view
    │   └── viewport.ts         Pan, zoom and node dragging for both sections
    ├── js/
    │   ├── instrument.ts       Rewrites JavaScript to report on itself (Babel)
    │   ├── typescript.ts       Strips TypeScript types, then instruments as JS
    │   ├── runtime.ts          Records steps: shadow stack, loops, serialization
    │   ├── trace.ts            traceJavaScript(): instrument, run, return a Trace
    │   ├── serve.ts            Worker side of the protocol, shared by JS and TS
    │   ├── javascript.worker.ts  Entry point for the JavaScript worker
    │   ├── typescript.worker.ts  Entry point for the TypeScript worker
    │   ├── cli.ts              npm run instrument / trace:js
    │   ├── trace.test.ts       JavaScript tracer tests (Vitest)
    │   └── typescript.test.ts  TypeScript tracer tests (Vitest)
    └── worker/
        ├── protocol.ts         Message types between page and workers
        ├── runner.ts           Starts a worker, runs code, watchdog
        ├── pyodide.worker.ts   Loads Pyodide and the tracer, answers runs
        ├── tracer.py           The Python tracer (settrace + ast)
        └── test_tracer.py      Python tracer tests
```

The diagram styling lives in the `/* diagrams */` section of `styles.css`. Colors are CSS custom properties on `:root`, so retheming the canvas is a matter of changing a handful of variables.

---

## Development workflow

**Changing the tracer.** `tracer.py` is ordinary Python, so the fastest loop is outside the browser:

```bash
# See the trace for a program
npm run trace -- path/to/program.py | python3 -m json.tool | less

# Run the tests
npm run test:tracer
```

Use Python 3.12 locally to match Pyodide 0.27's interpreter. Line-event behavior (which lines fire, and when) can differ slightly between Python versions, and loop detection depends on it. Vite reloads the worker when `tracer.py` changes, so the browser picks up edits automatically.

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

1. **Tracers**: add a branch to `Serializer.describe()` in `tracer.py` (Python) and in `runtime.ts` (JavaScript) that returns a new `kind`.
2. **Types**: add the shape to the `HeapObject` union in `trace/types.ts`. TypeScript will then point out every `switch` that needs a case.
3. **Diff**: teach `slotsOf()` in `diff.ts` what the object's slots are, so changes get highlighted.
4. **Render**: add a shape builder in `memory.ts` (and, if it's a container, handle it in `cellsOf()` in `loopView.ts`).

### Add a structure-specific layout

In the memory view, trees and graphs currently use the generic column layout (or nesting), which works but isn't a classic top-down tree drawing. A good extension point is `renderMemory()`: detect a shape (objects of one class with `left`/`right` fields, say) and lay those objects out with a tree algorithm before the generic placement runs. For general graphs, a layout library such as [ELK.js](https://github.com/kieler/elkjs) or [dagre](https://github.com/dagrejs/dagre) can compute positions that you then draw with the existing shape and arrow code.

### Let the code give hints

The `ast` pass is the natural place for annotations. For example, a comment like `# viz: tree` above an assignment could be parsed in `analyze()` (comments aren't in the AST, but `tokenize` can find them) and passed to the renderer through the trace, the same way `indexNames` is today.

### Add another language

Everything after the worker only depends on the trace format, so any language works if something can produce that JSON. The tracers here show the three main strategies. If the language's runtime has a tracing hook, like Python's `sys.settrace`, use it. If not, rewrite the program to report on itself, like the JavaScript tracer does. And if the language compiles to one that's already supported, compile it first and keep the line numbers, like the TypeScript tracer does. The language also needs to run in the browser, either natively or compiled to WebAssembly, unless you add a server.

---

## Limitations

**Both languages**

- **Big programs.** Each step is a full snapshot, so traces grow with steps times data size. The step budget (3,000) and container cap (60 items) keep it manageable. Raise `MAX_STEPS` in `main.ts` if you need longer runs.
- **Strings** are drawn as single values. A list or array of characters (`list("hello")`, `"hello".split("")`) is drawn as cells.
- **Nested lists** (matrices) are a list of references to row lists in arrows mode. Nested mode draws each row inside its cell, which reads much more like a grid.
- **Loop history doesn't nest.** Lists inside lists show a dot in the loop view, in either mode.
- **One linked class per loop.** If a loop works with two different linked classes, the loop history shows the one with more nodes. Graphs with cycles work, but large ones get crowded with arcs.
- **Moving boxes needs a pointer.** Boxes can be dragged with a mouse, pen or finger, but not moved with the keyboard. Zooming works from the keyboard, but panning doesn't, since the arrow keys step through the program.
- **Loop history rows can't be rearranged.** Rows are aligned so changes line up vertically, so the loop view pans and zooms but has no draggable boxes.

**Python**

- **No `input()`.** Hard-code your test data.
- **Imported packages.** The standard library works. Third-party packages would need loading through Pyodide's `micropip` first, which isn't wired up.
- **One-line loops** like `for x in xs: total += x` put the header and body on the same line, so iterations can't be told apart. Put the body on its own line.
- **Code that hangs inside a single C call** is stopped by the 10-second watchdog, which restarts the worker. The next run then waits a few seconds while Pyodide reloads (from the browser cache). A faster alternative is Pyodide's interrupt buffer, which needs a `SharedArrayBuffer` and therefore cross-origin isolation headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`) on the server. It's a worthwhile upgrade, but it makes hosting and CDN loading fussier, so it's left out of this version.

**JavaScript**

- **Generators and `async` functions run untraced.** They can pause in the middle and resume later, which a shadow stack can't follow. They still run correctly, and their results show up in the calling code. Everything inside them is invisible.
- **Scripts, not modules.** `import` and `export` aren't supported, and there's no top-level `await`.
- **Method closures aren't shown.** Variables captured by object and class *methods* don't appear on the function in the heap view, since methods can't be wrapped. Captures by ordinary functions and arrow functions do.
- **`fn.name` can change.** A function expression or arrow that captures variables is wrapped in a call, so JavaScript can no longer infer its name from the variable it's assigned to (`const inc = () => ++count` gives `inc.name === ""`). The canvas still shows the right name. This only matters if your code reads `.name`.
- **Names starting with `__av` are reserved** for the instrumentation and hidden from the canvas.
- **Recursion depth is capped at 250 calls**, to fail with a clear message rather than overflowing the browser's stack.

**TypeScript**

Everything listed for JavaScript applies, plus:

- **No type checking.** Types are removed without being checked. Use your editor or `tsc` if you want type errors reported.
- **No JSX or TSX**, and no decorators.
- **Namespace bodies run untraced**, along with the other compiler-generated code. Their exports work normally.

---

## Troubleshooting

**I can't find my diagram.** Click **Fit**, or click the zoom percentage to go back to 100% at the top-left corner. Panning always leaves part of the diagram on screen, so it can't be lost completely.

**A box I moved is somewhere strange after editing.** Your edit probably changed the order objects are created in, so its saved position now belongs to a different object (see [Rearranging the memory view](#rearranging-the-memory-view)). Click **Reset layout**.

**Stuck on "Loading Python…"** The page can't reach `cdn.jsdelivr.net`. Check your connection, and check whether a corporate proxy or content blocker is blocking it. The browser's developer tools (Network tab, filtered to the worker) show the failing request. If you need to work offline, you can download the `pyodide` npm package, serve its files from your own server or Vite's `public/` folder, and point `INDEX_URL` in `pyodide.worker.ts` at that location.

**"Couldn't load the language runtime: …" in the status bar (Python).** Usually a failed or partial download. Reload the page. If it persists, try another browser to rule out an extension.

**The page takes a while to load in dev.** That's Monaco being served as individual modules (see [The editor](#12-the-editor)). Later loads are faster because the browser caches them, and production builds don't have this cost.

**A keyboard shortcut does something different from VS Code.** Monaco includes VS Code's editor keybindings, but not workbench-level ones (like `Ctrl/Cmd + P` for quick open or `Ctrl/Cmd + B` for the sidebar), since there's no workbench. A few shortcuts can also be taken by the browser before the page sees them, such as `Ctrl/Cmd + W` and `Ctrl/Cmd + T`.

**My saved programs are gone.** They're stored in the browser, per site. A different browser, a private window, a different port or hostname in dev (`localhost:5173` and `127.0.0.1:5173` count as different sites), or clearing site data will each show a different, possibly empty, list.

**"Couldn't save: the browser's storage for this site is full or unavailable."** Browsers allow about 5 MB per site, which is a lot of source code. Delete programs you no longer need. Some privacy modes disable storage entirely. In that case programs still save, but only until the page is closed.

**Nothing happens when I type.** Check that **Live** is ticked, or press `Ctrl/Cmd + Enter`. A banner at the top of the canvas shows syntax errors, and the canvas dims while it's showing the last version that ran.

**"Stopped after 3,000 steps."** The program hit the step budget. Usually that's an infinite loop, but a correct program on bigger input can hit it too. Use a smaller input, or raise `MAX_STEPS` in `main.ts`.

**The loop history shows a different loop than I expected.** Click the loop you want in the tabs above it. Your choice sticks while that loop is active.

---

## Roadmap ideas

- Grid drawing for matrices (lists whose items are all lists).
- A tree layout for node-like objects, and ELK.js for general graphs.
- An animated mode alongside the stacked view, tweening cells between steps.
- `# viz:` comment hints read by the `ast` pass (and `// viz:` for JavaScript).
- Type checking for TypeScript, by running the TypeScript compiler in a worker (it's large, so probably loaded on demand).
- Tracing into generators and `async` functions, by giving each one its own frame that's suspended and resumed rather than pushed and popped.
- Cross-origin isolation plus Pyodide's interrupt buffer for instant stops.
- Delta-encoded steps (store only what changed) for much longer traces.
- Exporting and importing saved programs as files, to move them between browsers or share them.
- Saving the memory layout with a saved program, so a carefully arranged tree comes back when you reopen it.
- Nested lists (matrices) in the loop history, drawn as grids.
- A top-down tree layout for the loop history's linked track, for trees deeper than a few levels.
- Moving boxes with the keyboard.
- The TypeScript tracer.
