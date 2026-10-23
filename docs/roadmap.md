[← Docs index](README.md)

# Roadmap ideas

SQL, the next steps (see [SQL](sql.md) for what's there now):

- GROUP BY and aggregates: rows gathering into their groups, then each group folding into one row, its aggregates written out (`SUM(3, 5, 2) = 10`). HAVING dropping whole groups.
- Subqueries and WITH as nested steps; recursive WITH drawn like loop passes.
- Window functions, with each row's frame highlighted.

Everything else:

- Dragging single nodes of a graph to rearrange it, remembered like dragged boxes.
- Grids drawn as graphs (a maze search over a 2D grid), with the path through the cells highlighted.
- ELK.js layouts for large graphs, routing edges around nodes.
- Hints scoped to a function or a loop, and more hint kinds (`viz: graph`, `viz: matrix`).
- Morphing arrows between steps, by matching routes point by point.
- Exporting a played run as a GIF or video, rendered off-screen frame by frame (double-buffered) rather than recorded live: each frame of the memory view and the loop history is drawn to a hidden buffer at a fixed frame rate and only then encoded, so effects too costly to run live (morphing arrows, longer easings) can be used in the export without slowing down stepping.
- Type checking for TypeScript, by running the TypeScript compiler in a worker (it's large, so probably loaded on demand).
- Cross-origin isolation plus Pyodide's interrupt buffer for instant stops.
- Exporting and importing saved programs as files, to move them between browsers or share them.
- Saving the memory layout with a saved program, so a carefully arranged tree comes back when you reopen it.
- Moving boxes with the keyboard.
- Exporting and importing styles, to share a theme.
- Routing arrows around boxes you've dragged, not just the automatic layout.
- Best and worst cases for complexity: growth runs over inputs of several shapes (sorted, reversed, random) as well as sizes, each with its own curve.
- Per-entry deltas for dicts and objects, so a big dict updated once per step costs one entry per step.
- Stepping into a sampled loop's skipped passes on demand, by re-running up to that pass.
- A `viz: complexity n = len(nums)` hint to name the input size when the estimate picks the wrong one.
