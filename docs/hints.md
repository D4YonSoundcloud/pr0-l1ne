[← Docs index](README.md)

# Hints: `viz:` comments

PR0L1NE chooses what to draw automatically, but sometimes its guesses aren't what you want: a helper variable clutters the loop history, `cur` isn't recognized as a position in a list, a tree with parent pointers comes out as a list, or a list of lists is really a graph. A **hint** is a comment that tells it what you meant.

The quickest way to learn them is the **Hints, step by step** group in the Open… menu: [fifteen examples](#learning-hints-with-the-examples), from one hint to all of them together.

```python
# viz: hide temp
# viz: pointers nums: first, last
def rotate(nums):
    first, last = 0, len(nums) - 1
    while first < last:
        temp = nums[first]
        nums[first] = nums[last]
        nums[last] = temp
        first += 1
        last -= 1
```

A hint is a comment whose text starts with `viz:`:

| Language | Hint comments |
| --- | --- |
| Python | `# viz: ...` |
| JavaScript and TypeScript | `// viz: ...` or `/* viz: ... */` |

- **It can go anywhere**: on a line of its own, at the end of a line of code, at the top of the file. Hints apply to the **whole program**, not just the code near them. Putting each one just above the code it's about (a window hint above its loop) keeps the reason for it in view, and it's where the editor puts the hints it suggests. A hint in a string (`"# viz: hide x"`) isn't a comment, so it's ignored.
- **One hint per comment.** Write several comments for several hints.
- **Keywords aren't case sensitive**, and spacing is flexible: `# VIZ:  Hide a ,b` works.

## The hints

| Hint | What it does |
| --- | --- |
| `viz: hide temp, scratch` | Never draws these variables, in any frame, in the memory view or the loop history. Objects only they point at disappear too. Useful for helper variables, or `self`/`this` when it's noise. |
| `viz: show total, seen` | Always includes these variables in the loop history, even when PR0L1NE would leave them out because they don't change during the loop. |
| `viz: pointers nums: lo, hi` | Draws `lo` and `hi` as [pointer markers](how-it-works.md#pointer-detection) under `nums` whenever they hold a whole number, for names the code never writes as `nums[lo]`. |
| `viz: pointers grid[]: col` | The same, for a **grid**'s columns: `col` is marked under a column of `grid`. (Use `pointers grid: row` for its rows.) |
| `viz: window nums: [left, right]` | Draws the part of a list from `left` to `right` as a band over its cells: a **sliding window**. Both ends are in the window. Write `)` to leave the end out, `[i, i + k)`, or `(` to leave the start out. An end can add and take away names and whole numbers (`[r - k + 1, r]`). A **string** with a window is drawn as a row of its characters, so `viz: window s: [left, right]` works for substrings. Ends that are just a name are drawn as pointers too; a name only added to an end (`k` in `[i, i + k)`) is a length, so it isn't. |
| `viz: region nums: [0, i) "sorted"` | Marks part of a list with a band in its own color, and the label (optional) above it. A list can have several regions, like insertion sort's sorted and unsorted parts or quicksort's partitions, each in the next of four colors. The ends work as in `window`. A label too long for its region is shortened, with all of it in the tooltip. |
| `viz: compare nums: j - 1, j` | Outlines the two cells being compared, on every step, and flashes them when they move. Each can add and take away names and numbers, like a window's ends. |
| `viz: chars word` | Draws a string as a row of its characters, with index numbers and pointers, like a list. (A string with a `window`, `region` or `compare` is drawn this way already.) |
| `viz: bits mask 8` | Draws a whole number as its binary digits, bit 0 on the right, so you can see which bits are set. The number is how many digits; without it, as many as the number ever needs during the run, so the row doesn't change width. Negative numbers stay numbers. |
| `viz: format price .2f` | Shows numbers in a format: `hex`, `bin`, `oct`, `,` (thousands: 1,234,567), `.2f` (2 decimals), `.3e` (exponent), `.1%` (percent), or `,` with decimals (`,.2f`). It applies to the variable, and to the numbers in a list or dict it holds. `viz: hex flags, mask` is the same as `format ... hex`. |
| `viz: label Node by val` | Names a class's boxes by one of its fields (`Node 5`), and shows that field in its nodes in the loop history. |
| `viz: rows by i` | Labels the loop history's rows by a variable's value (`i = 3`) instead of `#3`. With several names, each loop uses the one in its own header; with nested loops together, a loop that has none of them keeps its usual labels. |
| `viz: focus` | Opens the loop history on the loop just below the hint, instead of the innermost one running. Or `focus line 12`, `focus while` (the first while loop), `focus for`, `focus all` (nested loops together). Picking a tab still wins. |
| `viz: watch right - left + 1` | Shows an expression's value in every loop row, after the variables (`right - left + 1 = 3`), marked when it changed. See [expressions](#expressions). |
| `viz: check total == sum(nums[0:i])` | Something that should be true in every loop row. A row where it's false turns red, with `✗` and the expression beside it. A row where it can't be worked out (a name isn't set yet) is left alone. |
| `viz: tree Node(left, right)` | Draws objects of class `Node` as a binary tree, using `left` and `right` as the children, in both the memory view and the loop history. Other fields, like `parent`, are drawn as plain fields. |
| `viz: list Node(next)` | Draws objects of class `Node` as a linked list in the loop history, using `next` as the link. Other fields, like `prev` or `random`, aren't drawn as links. |
| `viz: graph adj` | Draws `adj` as a [graph](user-guide.md#graphs): a dict, a list of neighbor lists, an adjacency matrix or an edge list. `self.adj` or `this.adj` work too, or just the field name. |
| `viz: graph adj: seen, todo, here` | The same, and also draws these variables on the graph, whatever they're called. Each is drawn by its type: a set fills nodes in, a list numbers them, a dict of numbers labels them, a variable holding a node gets a ▲ marker. |
| `viz: graph Node(neighbors)` | Draws objects of class `Node` as a graph, with `neighbors` as the edges. It can be a list, a set, a dict (its keys label the edges) or a direct link. List several fields to use them all. |
| `viz: plain graph` | Never draws `graph` as a graph, even though it looks like one. It's drawn as an ordinary dict or list instead. Takes variable or class names. |
| `viz: size n` | Marks `n` as the input size, for [growth runs](user-guide.md#how-it-grows). `n` must be set to a number at the top level of the program (`n = 40000`). `viz: size n = 40000, k` names several, with an optional full size to grow to. |

Names are the variable or field names as written in your code. Class names in `tree`, `list` and `graph` are what the canvas shows as the box title (a Python class name, or a JavaScript constructor name). If two hints name the same class or variable, the later one wins.

### Expressions

`watch` and `check` take a small expression, worked out at each loop row with that row's variables. It only reads values: nothing in it can change your program. Both languages' spellings work:

- Numbers, strings in quotes, `True`/`true`, `False`/`false`, `None`/`null`, and lists like `[1, 2]`.
- `+ - * / // % **`, comparisons `== != < <= > >=` (and `===`, `!==`), `and`/`&&`, `or`/`||`, `not`/`!`, and `in`, `not in`.
- Indexing and slices: `nums[i]`, `nums[lo:hi]`, `s[1:]`, a dict's `d["key"]`, and `.length`.
- `len`, `sum`, `min`, `max`, `abs`, `round`, `int`.

A list only partly recorded (a very long one) can't be summed, so an expression that needs all of it shows `?`.

### Graph options

Words between a graph hint's target and its colon change how the graph is read or drawn. Any number of them can be combined:

| Option | Effect |
| --- | --- |
| `directed`, `undirected` | Draw arrowheads, or don't. Without either, a graph is undirected when every edge goes both ways. |
| `matrix` | Read a list of lists as an adjacency matrix: `m[i][j]` is the edge from `i` to `j`. `0`, `False`, `None`, `-1` and infinity mean no edge. Other numbers are weights, and are shown unless every edge is `1` or `True`. |
| `edgelist` | Read a list of `(a, b)` or `(a, b, weight)` as edges. Python tuples are read this way without the option. |
| `layered`, `force`, `circle` | Lay it out in layers from top to bottom, spread out by distance (`force`: nodes a few edges apart sit about that far apart), or in a ring. Without one, it's layered when that reads well (trees, and directed graphs with no or few cycles), a circle for a ring (or a small dense graph, when that crosses fewer edges), and spread out by distance otherwise. `layered` works for any graph: edges that close a cycle point up. |

| `sideways` | Draw a layered graph left to right: each layer a column. Without it, a layered graph with a very wide layer runs left to right only in a window taller than it is wide. |
| `straight`, `curved`, `angled` | How edges are drawn: straight lines, gentle curves, or right angles (horizontal and vertical lines with rounded corners). Without one, edges are straight, curving only to go around a node or through the layers a long edge crosses. With `angled`, a graph that isn't in layers has its nodes lined up in rows and columns. |

```python
# viz: graph flights matrix directed circle: reach, city
# viz: graph roads angled
```

## Writing hints in the editor

The editor helps with hints as you type them:

- **Completions.** Type `viz:` in a comment and the list of hints opens. Pick one and the list goes on to what comes next, with your program's own names from its last run: lists and strings for a window, whole numbers for its ends (and whole windows, like `[left, right]`, when your program has a pair of names like that), classes for `tree` and `list` with their links filled in, the options a graph hasn't used yet.
- **Hovers.** Hover a hint's name to see what it does, with an example. Hover a graph option for what that one does.
- **Names that aren't in the program.** A name a hint uses that never appeared in the last run gets a dotted underline. Click the lightbulb (or press `Ctrl` + `.`) to change it to the likely one: `nmus` to `nums`. A misspelled hint (`windw`) gets the same fix.
- **Hints worth adding.** On the first line of a loop that reads a list or a string from two ends (`s[left]` and `s[right]`) or slices it (`nums[i:i + k]`, `s.slice(left, right + 1)`), the lightbulb offers a window hint for it, put on its own line just above the loop.
- **Add a hint above this line**, in the lightbulb, the right-click menu and the command palette (`F1`), starts a `viz:` comment above the line, indented like it, with the list of hints open.

## When a hint is wrong

A hint that PR0L1NE can't understand doesn't stop your program. It's ignored, and you're told why in two places: a yellow banner at the top of the canvas (`Hint on line 3: Unknown hint "colour blue". Hints are: hide, show, pointers, window, region, compare, chars, bits, format, hex, label, rows, focus, watch, check, tree, list, graph, plain, size.`) and a yellow squiggle under the comment in the editor, which you can hover. Each message shows the form the hint should take, such as `viz: tree Node(left, right)`.

A hint that's well-formed but names something that doesn't exist (`hide nmus`) does nothing, since it may refer to a variable that only exists in some runs.

## Learning hints with the examples

The **Hints, step by step** group has the same fifteen examples in every language. Each has its hints and a comment explaining what they change. Deleting a hint line and watching the canvas change is a good way to see what it does.

| Example | Hints | What it shows |
| --- | --- | --- |
| 1 · hide | `hide before, receipt` | A running total, without the helper variables cluttering the loop history |
| 2 · show | `show target` | A linear search that keeps the value it's looking for in every row, though it never changes |
| 3 · pointers | `pointers nums: read` | Removing duplicates in place: `read` comes from `enumerate()`, so only the hint can mark it |
| 4 · grid pointers | `pointers grid: r`, `pointers grid[]: c` | Column sums: marking a grid's row and column when the code walks rows with `for row in grid` |
| 5 · tree | `tree Node(left, right)` | A binary search tree with parent links, drawn top-down instead of as a list |
| 6 · list | `list Item(next)` | A list whose items also have `random` links, followed along `next` only |
| 7 · graph | `graph adj` | A depth-first search over neighbor lists by number, with `seen`, `stack`, `u` and `v` drawn on it |
| 8 · graph options | `graph flights matrix directed circle: reach, frontier, city, nxt` | An adjacency matrix, read as a directed graph and drawn in a ring |
| 9 · edge list | `graph edges edgelist undirected: parent, mst, a, b` | Kruskal's algorithm: the union-find forest in green and the chosen edges in purple |
| 10 · all together | `graph`, `plain`, `hide` and `show` | Dijkstra on a road map with a closed road: costs, the frontier, the tree of best routes and the final route all on the graph |
| 11 · window | `window s: [left, right]` | The longest substring without a repeated letter: a string drawn as letters, with the window growing on the right and shrinking from the left |
| 12 · window | `window nums: [i, i + k)` | The best sum of k numbers in a row: a window of exactly k sliding along a list |
| 13 · region, compare, rows | `region nums: [0, i) "sorted"`, `region nums: [i, 6) "to do"`, `compare nums: j - 1, j`, `rows by i` | Insertion sort: the sorted part growing, the two cells being compared, and rows labeled by `i` |
| 14 · watch, check, focus | `focus`, `watch total - seen`, `check total == sum(nums[0:i])` | Running totals, with an invariant to break and watch fail |
| 15 · chars, bits, format, label | `chars word`, `bits mask 5`, `format share .1%`, `label Node by val` | A palindrome check with its letters, a bitmask, a percentage and named nodes |

![Kruskal's algorithm: the union-find forest's links dashed in green, the spanning tree's edges in purple](graph-kruskal.png)
