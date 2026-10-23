[← Docs index](README.md)

# Limitations and troubleshooting

## Limitations

**Python, JavaScript and TypeScript**

- **Printed output is shown in the memory window only.** The loop history isn't dimmed or labeled with what each iteration printed. Output written another way (`sys.stdout.write`, `print(..., file=sys.stderr)`) shows in the card when it reaches the output pane, but without arrows to objects; output to stderr doesn't appear at all.

- **Big programs.** A trace keeps up to 20,000 steps and 6 seconds (1.5 while typing), with long loops sampled and lists capped at 60 cells plus a strip. A sampled loop's skipped passes can't be stepped through, and a program that does a lot outside loops (deep recursion, many separate statements) can still reach the budget. Measure runs any size, without the step-by-step view. A dict or object that changes one entry per step is still stored whole at each step, so programs that update a big dict in a long loop use the most memory.
- **Strips** are for lists of numbers (and booleans). Lists of strings or objects show their 60-cell window without one. Sets aren't windowed: they show their first 60 items.
- **Growth runs** need the size set by a number at the top level (`n = 40000`), not computed (`n = len(data)`) or read from a file. Sizes below 64 can't be divided by 64, so small sizes give fewer points. Times of runs under about 0.1 ms can't be measured in a browser.
- **Strings** are drawn as single values. A list or array of characters (`list("hello")`, `"hello".split("")`) is drawn as cells.
- **Nested lists** (matrices) are a list of references to row lists in arrows mode. Nested mode and the loop history draw them as grids.
- **Grids are two levels.** A list of lists is a grid. Deeper nesting (a 3D list) shows a grid of dots in the loop history, and nested boxes in nested mode.
- **One linked class per loop.** If a loop works with two different linked classes, the loop history shows the one with more nodes. Graphs with cycles work, but large ones get crowded with arcs.
- **Trees with parent pointers** (`left`, `right` and `parent`) have three links, so they're drawn as a list with arcs unless you add a [`viz: tree` hint](hints.md#hints-viz-comments).
- **Graph size.** Graphs are found automatically up to 40 nodes, and drawn up to 60 with a hint. Big, dense graphs get busy, since edges are straight lines that can cross.
- **Graph state is read from types and names.** A variable whose meaning doesn't show in its type or name may be drawn the wrong way, or not at all. For example, a plain list of nodes is numbered as a queue, front first. List names in the graph hint to include them. In a heap of `(priority, node)` pairs where nodes are numbers too, the node is taken to be the last element.
- **One graph in the loop history.** If a loop works with several graphs, the loop history draws the first one found (hinted ones first). The memory view draws them all.
- **Arrows into a graph of objects** end at the edge of the graph's box, level with the node, rather than at the node itself. The ▲ marker under the node says which one.
- **Graph nodes can't be dragged** one at a time. The whole graph box can.
- **Trees with more than two children** (`children` lists or dicts) are drawn as [graphs](user-guide.md#graphs), in layers from the root down, rather than with the binary tree layout. That's still top-down, but without in-order positions.
- **Only single steps animate.** Jumping with the slider or `Home`/`End` redraws without tweening. Arrows don't animate at all; they jump to their new route, which can briefly look detached while a box is still sliding into place.
- **Hints apply to the whole program.** There's no way yet to scope a hint to one function or loop, so `hide x` hides every `x`.
- **Arrows assume the automatic layout.** Once you drag boxes around, arrows still route through the gaps they'd normally use, so they can cross boxes you've moved. They always reach the right box.
- **Styles can't change text size.** Layout is computed from fixed text metrics, so sizes are fixed, and the code font must be monospace (the font list only offers monospace fonts). Zoom in for bigger text.
- **Styles belong to this browser.** Like saved programs, they're stored in `localStorage`.
- **Moving boxes needs a pointer.** Boxes can be dragged with a mouse, pen or finger, but not moved with the keyboard. Zooming works from the keyboard, but panning doesn't, since the arrow keys step through the program.
- **Loop history rows can't be rearranged.** Rows are aligned so changes line up vertically, so the loop view pans and zooms but has no draggable boxes.

**Python**

- **No `input()`.** Hard-code your test data.
- **Imported packages.** The standard library works. Third-party packages would need loading through Pyodide's `micropip` first, which isn't wired up.
- **One-line loops** like `for x in xs: total += x` put the header and body on the same line, so iterations can't be told apart. Put the body on its own line.
- **`asyncio` runs on a virtual clock.** Sleeps cost no time, so code that measures elapsed time with `time.time()` sees almost none. There's no real I/O: sockets, subprocesses and `run_in_executor` aren't available in the browser.
- **Code that hangs inside a single C call** is stopped by the 10-second watchdog, which restarts the worker. The next run then waits a few seconds while Pyodide reloads (from the browser cache). A faster alternative is Pyodide's interrupt buffer, which needs a `SharedArrayBuffer` and therefore cross-origin isolation headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`) on the server. It's a worthwhile upgrade, but it makes hosting and CDN loading fussier, so it's left out of this version.

**Measure**

- **Counts are exact; times aren't portable.** Times depend on the machine, the browser and what else it's doing, and include the counters unless the program was quick enough to time again untouched.
- **The projection for a stopped run assumes every pass of the outermost loop takes about as long as the ones so far.** For a loop whose passes grow (an inner loop over `range(i)`), the real total is longer. And it needs a loop whose length is known when it starts: `for` over a list, a `range`, or a simple counting `for`. A `while` loop has none, so a run stopped inside one can't be projected.
- **Work inside built-ins is counted for common list and array operations**, on containers named directly (`nums.insert(0, x)`, not `get_list().insert(0, x)`). Others count as one line each: string building, `[...spread]`, `Array.from`, dict and set operations (which are O(1) anyway), and your own classes' methods (whose lines are counted themselves).
- **No memory figures for JavaScript**, since browsers don't let a page measure its own memory use. Python's peak needs a third, much slower run, so it's only shown for quick programs.
- **Stop restarts the language's worker**, since it's busy running the program. For Python that means reloading Pyodide from the browser's cache, which takes a few seconds; the counts from a stopped run are lost (a run that reaches the time limit keeps them).

**Complexity estimates**

- **They're estimates.** Complexity in general can't be computed from code (it's undecidable), so this reads common patterns and checks them against one run. Unusual code can fool it, and a loop sized from the run is only as good as the run: with tiny inputs, n and log n, or V and E, can be hard to tell apart. The panel says which parts came from the run.
- **One run, one input.** Loops the code doesn't bound are sized from this run's counts. Best and worst cases (an already-sorted list, a lucky search) aren't separated: the code's shape gives the worst case, and the run gives what happened.
- **Worst case, not average.** An early `break` doesn't make a loop count for less, and a hash lookup is O(1) (its average), not O(n).
- **Your own data structures** count as their operations' cost in your code: a heap you wrote yourself is as fast as its loops say. Library internals are the standard costs (`heapq` is log n, `deque.popleft` is 1, `list.pop(0)` and `array.shift()` are n).
- **Mutual recursion** (f calls g calls f) is counted at the first function's call site, not solved.
- **Space** counts the extra memory the code builds, not the input. Structures that grow and shrink (a stack that's pushed and popped) count at their largest.

**Memory sizes**

- **Small ints and short strings are counted every time they're used.** CPython shares one object for each int from -5 to 256 (and some strings), so a list of zeros really holds eight-byte pointers to a single `0`. Sizes count the int in every cell anyway, and so do totals, since that's the cost of numbers in general and sharing is an optimization you can't rely on. Shared lists, dicts and objects are counted once.
- **V8 sizes are estimates.** JavaScript has no `getsizeof`, and V8's real layout depends on how objects were built (hidden classes, in-object versus out-of-object properties, array element kinds), so they're marked `≈`. Python's are exact for containers and strings, and within a few percent for instances.
- **Library internals aren't counted.** A class's methods, the interpreter's own bookkeeping and memory the allocator keeps spare are left out, as is anything the trace doesn't show (containers beyond the 60-item cap are sized from their length).

**JavaScript**

- **Scripts, not modules.** `import` and `export` aren't supported, and there's no top-level `await` (wrap it in an `async` function).
- **Timers are virtual.** `setTimeout` callbacks run in the right order but without the delay, and `Date.now()` doesn't move with the virtual clock. Code that measures elapsed time sees almost none.
- **Generator objects don't say where they're paused.** JavaScript keeps that hidden. The paused frame below the stack shows it instead.
- **An event loop that never empties** (a `setInterval` that's never cleared) stops after 10,000 turns or the step budget, whichever comes first.
- **Method closures aren't shown.** Variables captured by object and class *methods* don't appear on the function in the heap view, since methods can't be wrapped. Captures by ordinary functions and arrow functions do.
- **`fn.name` can change.** A function expression or arrow that captures variables is wrapped in a call, so JavaScript can no longer infer its name from the variable it's assigned to (`const inc = () => ++count` gives `inc.name === ""`). The canvas still shows the right name. This only matters if your code reads `.name`.
- **Names starting with `__av` are reserved** for the instrumentation and hidden from the canvas.
- **Recursion depth is capped at 250 calls**, to fail with a clear message rather than overflowing the browser's stack.

**TypeScript**

Everything listed for JavaScript applies, plus:

- **No type checking.** Types are removed without being checked. Use your editor or `tsc` if you want type errors reported.
- **No JSX or TSX**, and no decorators.
- **Namespace bodies run untraced**, along with the other compiler-generated code. Their exports work normally.

**The canvas renderer**

- **Stepping is a little slower than with SVG.** Both keep what didn't change from step to step, but the canvas is then painted whole, while the browser only redraws the SVG elements that changed. On a program with 300 linked nodes, a step was on screen in about 190 ms against SVG's 150 ms in our tests (Chromium without a GPU); what the canvas saves is panning and zooming, where every frame took under 17 ms, against SVG's slowest frames of 100 to 150 ms.
- **Screen readers can't read the diagram** with Canvas 2D on: it's a picture, not elements of the page. The windows' names are still announced. SVG (the default) can be read.
- **No hover shadow, and dimming fades each part.** Hovering a box doesn't give it a soft shadow on the canvas. With Dim others on, a dimmed box fades each of its parts rather than the box as a whole, so its outline can show faintly through its cells.
- **Text sharpens a moment after zooming.** While you zoom in, text is scaled from how it was last drawn; it's redrawn sharp once you stop.
- **Fonts in saved SVG files.** A saved file names the diagram font from the Style panel. If the computer opening it doesn't have that font, text falls back to another monospace font and can be a little wider or narrower.

**SQL**

- **Not every query is stepped through yet.** Queries on one table and joins are stepped through clause by clause. GROUP BY and aggregates, subqueries, WITH, UNION and window functions run, but are shown as their result in one step (see [SQL](sql.md#not-stepped-through-yet)).
- **A join's result can be wide.** Its rows have every column of every table joined, so a join of wide tables is drawn small: zoom in, or SELECT fewer columns to see them later on.
- **Up to a hundred rows a step.** A table with more is drawn to its hundredth row, with the rest counted. The output pane prints up to 200 rows of a result.
- **UPDATE moves rows.** Postgres keeps an updated row in a new place, so after an UPDATE the row has a new number (`#4`) and isn't followed from its old one.
- **A query that never finishes** (a huge `generate_series`, say) is stopped by the same time limit as a program, and Postgres starts again.
- **No files, no transactions.** `COPY` can't read or write files, and `BEGIN`, `COMMIT` and `ROLLBACK` aren't allowed: each run starts from a fresh database and is thrown away at the end.

---

## Troubleshooting

**I can't find my diagram.** Click **Fit**, or click the zoom percentage to go back to 100% at the top-left corner. Panning always leaves part of the diagram on screen, so it can't be lost completely.

**A box I moved is somewhere strange after editing.** Your edit probably changed the order objects are created in, so its saved position now belongs to a different object (see [Rearranging the memory view](user-guide.md#rearranging-the-memory-view)). Click **Reset layout**.

**Stuck on "Downloading Python (6 MB)…", or "couldn't load … the code runner didn't answer".** Programs run on PR0L1NE's code runner, `pr0l1ne-run.pages.dev`, which the page loads in a hidden frame (see [Security](how-it-works.md#security-running-other-peoples-code)); Python also downloads from there. Check your connection, and whether a corporate proxy, content blocker or privacy extension blocks that address or frames from other sites. The browser's developer tools (Network tab) show the failing request.

**"Couldn't load the language runtime: …" in the status bar (Python).** Usually a failed or partial download. Reload the page. If it persists, try another browser to rule out an extension.

**The page takes a while to load in dev.** That's Monaco being served as individual modules (see [The editor](how-it-works.md#16-the-editor)). Later loads are faster because the browser caches them, and production builds don't have this cost.

**A keyboard shortcut does something different from VS Code.** Monaco includes VS Code's editor keybindings, but not workbench-level ones (like `Ctrl/Cmd + P` for quick open or `Ctrl/Cmd + B` for the sidebar), since there's no workbench. A few shortcuts can also be taken by the browser before the page sees them, such as `Ctrl/Cmd + W` and `Ctrl/Cmd + T`.

**My saved programs are gone.** They're stored in the browser, per site. A different browser, a private window, a different port or hostname in dev (`localhost:5173` and `127.0.0.1:5173` count as different sites), or clearing site data will each show a different, possibly empty, list.

**"Couldn't save: the browser's storage for this site is full or unavailable."** Browsers allow about 5 MB per site, which is a lot of source code. Delete programs you no longer need. Some privacy modes disable storage entirely. In that case programs still save, but only until the page is closed.

**Nothing happens when I type.** Check that **Live** is ticked, or press `Ctrl + '`. A banner at the top of the canvas shows syntax errors, and the canvas dims while it's showing the last version that ran.

**"Traced for 6 seconds and stopped" or "Stopped after 20,000 recorded steps."** The trace hit its time or step budget (the banner says how many steps ran in all). Usually that's an infinite loop, but a correct program on a big input can hit it too: what's shown is the start of the run. Press **Measure** to run all of it with counters, use a smaller input, or raise `MAX_STEPS` / `RUN_SECONDS` in [`src/app/runController.ts`](../src/app/runController.ts). A Live run while typing stops after 1.5 seconds; **Run** gives it 6.

**"#6 to #9: 4 passes like these ran, not recorded" in the loop history.** The loop was long, so it was [sampled](user-guide.md#big-inputs). Those passes ran; they just weren't kept.

**"How it grows" says there's no `n = <number>` at the top level.** Growth runs change that line, so the size has to be set by a plain number outside any function: `n = 40000`, `const n = 40_000;`. Put the hint's name on that variable.

**A dict is drawn as a graph, but I want to see the dict.** Add `viz: plain name`, using the variable's name (or the class name, for a graph of objects).

**My graph isn't drawn as a graph.** Lists of lists, matrices and edge lists need a hint: `viz: graph adj`. A dict is only recognized automatically when most of the neighbors are also keys. If your nodes are spelled differently in the keys and the lists (`"1"` and `1` in Python), they're different nodes.

**The loop history shows a different loop than I expected.** Click the loop you want in the tabs above it, or **All loops** for every loop in the function together. Your choice sticks while that loop is active.

**Nothing animates.** Animation only happens when moving one step at a time, and it's turned off when your operating system's "reduce motion" setting is on (on macOS: System Settings → Accessibility → Display; on Windows: Settings → Accessibility → Visual effects → Animation effects).

**`Space` doesn't play.** It types a space when the editor has focus. Click the canvas or the timeline first, use the **Play** button, or bind "AlgoViz: Play / Pause" from the command palette.

**My hint does nothing.** If it's underlined in yellow, hover it to see why. If not, check that the names match exactly what the canvas shows (case matters for names), and that it's a comment rather than text in a string.
