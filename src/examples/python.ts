import type { Example } from "./index";

const SORTING = "Sorting";
const SEARCHING = "Searching and two pointers";
const LINKED = "Linked lists and trees";
const GRAPHS = "Graphs";
const GRIDS = "Grids and dynamic programming";
const FUNCTIONS = "Functions, classes and generators";
const HINTS = "Hints, step by step";

export const PYTHON_EXAMPLES: Example[] = [
  // ------------------------------------------------------------- sorting
  {
    group: SORTING,
    name: "Bubble sort",
    code: `arr = [5, 2, 9, 1, 6]
n = len(arr)

for i in range(n):
    for j in range(n - i - 1):
        if arr[j] > arr[j + 1]:
            arr[j], arr[j + 1] = arr[j + 1], arr[j]

print(arr)
`,
  },
  {
    group: SORTING,
    name: "Insertion sort",
    code: `nums = [7, 3, 5, 1, 4]

for i in range(1, len(nums)):
    key = nums[i]
    j = i - 1
    # Shift bigger values right until key's spot opens up.
    while j >= 0 and nums[j] > key:
        nums[j + 1] = nums[j]
        j -= 1
    nums[j + 1] = key

print(nums)
`,
  },
  {
    group: SORTING,
    name: "Merge sort (recursion)",
    code: `def merge_sort(items):
    if len(items) <= 1:
        return items
    mid = len(items) // 2
    left = merge_sort(items[:mid])
    right = merge_sort(items[mid:])

    merged = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i])
            i += 1
        else:
            merged.append(right[j])
            j += 1
    merged.extend(left[i:])
    merged.extend(right[j:])
    return merged

print(merge_sort([5, 2, 7, 1, 3]))
`,
  },
  // ------------------------------------------------------------- searching
  {
    group: SEARCHING,
    name: "Binary search",
    code: `nums = [2, 5, 8, 12, 16, 23, 38, 56, 72]
target = 23
lo, hi = 0, len(nums) - 1
found = -1

while lo <= hi:
    mid = (lo + hi) // 2
    if nums[mid] == target:
        found = mid
        break
    elif nums[mid] < target:
        lo = mid + 1
    else:
        hi = mid - 1

print("found at", found)
`,
  },
  {
    group: SEARCHING,
    name: "Reverse a string (two pointers)",
    code: `chars = list("stressed")
left = 0
right = len(chars) - 1

while left < right:
    chars[left], chars[right] = chars[right], chars[left]
    left += 1
    right -= 1

print("".join(chars))
`,
  },
  {
    group: SEARCHING,
    name: "Two sum (hash map)",
    code: `nums = [3, 8, 11, 2, 7]
target = 9
seen = {}       # value -> index where we saw it
answer = None

for i, x in enumerate(nums):
    need = target - x
    if need in seen:
        answer = (seen[need], i)
        break
    seen[x] = i

print(answer)
`,
  },
  {
    group: SEARCHING,
    name: "Sliding window (best sum of k)",
    code: `nums = [2, 1, 5, 1, 3, 2]
k = 3
window = sum(nums[:k])
best = window

for right in range(k, len(nums)):
    # Slide: add the new value, drop the one that left the window.
    window += nums[right] - nums[right - k]
    best = max(best, window)

print(best)
`,
  },
  {
    group: SEARCHING,
    name: "Word frequency (dict)",
    code: `words = "the cat and the hat and the bat".split()
counts = {}

for word in words:
    counts[word] = counts.get(word, 0) + 1

print(counts)
`,
  },
  // ------------------------------------------------------------- linked lists and trees
  {
    group: LINKED,
    name: "Reverse a linked list",
    code: `class Node:
    def __init__(self, val, next=None):
        self.val = val
        self.next = next

head = Node(1, Node(2, Node(3)))

prev = None
curr = head
while curr:
    nxt = curr.next
    curr.next = prev
    prev = curr
    curr = nxt
head = prev
`,
  },
  {
    group: LINKED,
    name: "Find a cycle (fast and slow pointers)",
    code: `class Node:
    def __init__(self, val):
        self.val = val
        self.next = None

head = Node(1)
head.next = Node(2)
head.next.next = Node(3)
head.next.next.next = Node(4)
head.next.next.next.next = Node(5)
head.next.next.next.next.next = head.next.next   # 5 -> 3: a cycle

slow = fast = head
has_cycle = False
while fast and fast.next:
    slow = slow.next
    fast = fast.next.next
    if slow is fast:
        has_cycle = True
        break

print(has_cycle)
`,
  },
  {
    group: LINKED,
    name: "Binary search tree insert",
    code: `class TreeNode:
    def __init__(self, key):
        self.key = key
        self.left = None
        self.right = None

def insert(root, key):
    node = root
    while True:
        if key < node.key:
            if node.left is None:
                node.left = TreeNode(key)
                return
            node = node.left
        else:
            if node.right is None:
                node.right = TreeNode(key)
                return
            node = node.right

root = TreeNode(8)
for key in [3, 10, 1, 6, 14]:
    insert(root, key)
`,
  },
  {
    group: LINKED,
    name: "Tree traversal (in-order)",
    code: `class TreeNode:
    def __init__(self, key, left=None, right=None):
        self.key = key
        self.left = left
        self.right = right

root = TreeNode(4,
    TreeNode(2, TreeNode(1), TreeNode(3)),
    TreeNode(6, TreeNode(5), TreeNode(7)))
order = []

def inorder(node):
    if node is None:
        return
    inorder(node.left)
    order.append(node.key)
    inorder(node.right)

inorder(root)
print(order)
`,
  },
  {
    group: LINKED,
    name: "Trie (prefix tree)",
    code: `# Each node holds a dict of children, one per next letter. Classes
# whose objects hold dicts or lists of each other are drawn as a graph:
# the letters label the edges, and filled nodes end a word.
class TrieNode:
    def __init__(self):
        self.children = {}
        self.is_word = False

root = TrieNode()

def insert(word):
    node = root
    for ch in word:
        if ch not in node.children:
            node.children[ch] = TrieNode()
        node = node.children[ch]
    node.is_word = True

for word in ["car", "cat", "cart", "dog"]:
    insert(word)
`,
  },
  // ------------------------------------------------------------- graphs
  {
    group: GRAPHS,
    name: "Breadth-first search (shortest path)",
    code: `from collections import deque

# A dict of neighbor lists is drawn as a graph. The search's own
# variables are drawn on it: the queue's order, the parent links
# (the BFS tree), the current node, and finally the path.
graph = {
    "A": ["B", "C"],
    "B": ["A", "D", "E"],
    "C": ["A", "F"],
    "D": ["B"],
    "E": ["B", "F"],
    "F": ["C", "E"],
}

def shortest_path(start, goal):
    parent = {start: None}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        if node == goal:
            break
        for nb in graph[node]:
            if nb not in parent:
                parent[nb] = node
                queue.append(nb)

    path = []
    node = goal
    while node is not None:
        path.append(node)
        node = parent[node]
    return path[::-1]

route = shortest_path("A", "F")
print(route)
`,
  },
  {
    group: GRAPHS,
    name: "Depth-first search (recursion)",
    code: `# A directed graph with no cycles is drawn in layers.
graph = {
    1: [2, 3],
    2: [4],
    3: [4, 5],
    4: [6],
    5: [6],
    6: [],
}
visited = set()
order = []

def dfs(node):
    visited.add(node)
    order.append(node)
    for nxt in graph[node]:
        if nxt not in visited:
            dfs(nxt)

dfs(1)
print(order)
`,
  },
  {
    group: GRAPHS,
    name: "Dijkstra's shortest paths (weighted)",
    code: `import heapq

# A dict of {neighbor: distance} dicts is a weighted graph.
roads = {
    "home": {"park": 2, "shop": 5},
    "park": {"home": 2, "shop": 1, "school": 4},
    "shop": {"home": 5, "park": 1, "school": 1},
    "school": {"park": 4, "shop": 1},
}

dist = {place: float("inf") for place in roads}
dist["home"] = 0
heap = [(0, "home")]
done = set()

while heap:
    d, node = heapq.heappop(heap)
    if node in done:
        continue
    done.add(node)
    for nb, w in roads[node].items():
        if d + w < dist[nb]:
            dist[nb] = d + w
            heapq.heappush(heap, (dist[nb], nb))

print(dist)
`,
  },
  {
    group: GRAPHS,
    name: "Topological sort (getting dressed)",
    code: `from collections import deque

# What has to go on before what. Kahn's algorithm: repeatedly take
# something nothing else is waiting on.
needs = {
    "socks": ["shoes"],
    "pants": ["shoes", "belt"],
    "shirt": ["belt", "tie"],
    "tie": ["jacket"],
    "belt": ["jacket"],
    "shoes": [],
    "jacket": [],
}

indegree = {item: 0 for item in needs}
for item in needs:
    for after in needs[item]:
        indegree[after] += 1

ready = deque([item for item in needs if indegree[item] == 0])
order = []
while ready:
    item = ready.popleft()
    order.append(item)
    for after in needs[item]:
        indegree[after] -= 1
        if indegree[after] == 0:
            ready.append(after)

print(order)
`,
  },
  {
    group: GRAPHS,
    name: "Graph of objects (reachable cities)",
    code: `# Objects that hold lists of each other are drawn as a graph too.
class City:
    def __init__(self, name):
        self.name = name
        self.roads = []

def connect(a, b):
    a.roads.append(b)
    b.roads.append(a)

paris, lyon, nice, nantes, dijon = City("Paris"), City("Lyon"), City("Nice"), City("Nantes"), City("Dijon")
connect(paris, lyon)
connect(lyon, nice)
connect(paris, nantes)
connect(nantes, nice)
connect(lyon, dijon)

def reachable(start):
    seen = {start}
    stack = [start]
    while stack:
        city = stack.pop()
        for nxt in city.roads:
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return len(seen)

print(reachable(nice))
`,
  },
  // ------------------------------------------------------------- grids and DP
  {
    group: GRIDS,
    name: "Grid paths (dynamic programming)",
    code: `rows, cols = 3, 4
grid = [[0] * cols for _ in range(rows)]

for i in range(rows):
    for j in range(cols):
        if i == 0 or j == 0:
            grid[i][j] = 1
        else:
            grid[i][j] = grid[i - 1][j] + grid[i][j - 1]

print(grid[rows - 1][cols - 1], "paths")
`,
  },
  {
    group: GRIDS,
    name: "Longest common subsequence",
    code: `a = "BDCA"
b = "BCA"
rows, cols = len(a) + 1, len(b) + 1
table = [[0] * cols for _ in range(rows)]

for i in range(1, rows):
    for j in range(1, cols):
        if a[i - 1] == b[j - 1]:
            table[i][j] = table[i - 1][j - 1] + 1
        else:
            table[i][j] = max(table[i - 1][j], table[i][j - 1])

print(table[-1][-1])
`,
  },
  {
    group: GRIDS,
    name: "Coin change (fewest coins)",
    code: `coins = [1, 3, 4]
amount = 6
best = [0] + [float("inf")] * amount   # best[t]: fewest coins making t

for total in range(1, amount + 1):
    for coin in coins:
        if coin <= total and best[total - coin] + 1 < best[total]:
            best[total] = best[total - coin] + 1

print(best[amount])
`,
  },
  {
    group: GRIDS,
    name: "Number of islands (flood fill)",
    code: `grid = [
    [1, 1, 0, 0],
    [1, 0, 0, 1],
    [0, 0, 1, 1],
]
rows, cols = len(grid), len(grid[0])
islands = 0

def sink(r, c):
    if r < 0 or c < 0 or r >= rows or c >= cols or grid[r][c] == 0:
        return
    grid[r][c] = 0
    sink(r + 1, c)
    sink(r - 1, c)
    sink(r, c + 1)
    sink(r, c - 1)

for r in range(rows):
    for c in range(cols):
        if grid[r][c] == 1:
            islands += 1
            sink(r, c)

print(islands)
`,
  },
  {
    group: GRIDS,
    name: "Fibonacci with a memo",
    code: `memo = {}

def fib(n):
    if n in memo:
        return memo[n]
    if n < 2:
        return n
    memo[n] = fib(n - 1) + fib(n - 2)
    return memo[n]

print(fib(6))
`,
  },
  // ------------------------------------------------------------- functions
  {
    group: FUNCTIONS,
    name: "Recursion (factorial)",
    code: `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

result = factorial(4)
print(result)
`,
  },
  {
    group: FUNCTIONS,
    name: "Closures and scope",
    code: `def make_counter(start):
    count = start

    def increment():
        nonlocal count
        count += 1
        return count

    return increment

counter = make_counter(10)
counter()
counter()
`,
  },
  {
    group: FUNCTIONS,
    name: "A class with methods (stack)",
    code: `class Stack:
    def __init__(self):
        self.items = []

    def push(self, item):
        self.items.append(item)

    def pop(self):
        return self.items.pop() if self.items else None

def balanced(text):
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = Stack()
    for ch in text:
        if ch in "([{":
            stack.push(ch)
        elif ch in pairs and stack.pop() != pairs[ch]:
            return False
    return not stack.items

print(balanced("{[()]}"), balanced("(]"))
`,
  },
  {
    group: FUNCTIONS,
    name: "Generator (Fibonacci)",
    code: `def fibonacci():
    a, b = 0, 1
    while True:
        yield a
        a, b = b, a + b

fib = fibonacci()
first = []
for _ in range(6):
    first.append(next(fib))

print(first)
`,
  },
  {
    group: FUNCTIONS,
    name: "Async tasks (asyncio)",
    code: `import asyncio

# asyncio.sleep runs on a virtual clock here: no real waiting, but tasks
# still wake up in the order their timers would fire.
async def download(name, seconds):
    print("start", name)
    await asyncio.sleep(seconds)
    print("done", name)
    return len(name)

async def main():
    sizes = await asyncio.gather(
        download("photo.png", 3),
        download("notes.txt", 1),
    )
    print("sizes", sizes)

asyncio.run(main())
`,
  },
  // ------------------------------------------------------------- hints
  {
    group: HINTS,
    name: "1 · hide: leave out helper variables",
    code: `# viz: hide before, receipt
#
# A hint is a comment starting with "viz:". This one hides two helper
# variables, so the loop history only shows what matters: the running
# total. Delete the hint line to see the difference.
prices = [12, 7, 30, 5]
total = 0

for price in prices:
    before = total
    total += price
    receipt = f"{before} + {price} = {total}"

print(total)
`,
  },
  {
    group: HINTS,
    name: "2 · show: keep a variable that never changes",
    code: `# viz: show target
#
# The loop history leaves out variables that don't change during the
# loop. "target" never changes, but it's what we're looking for, so the
# hint keeps it in every row.
nums = [4, 9, 1, 7, 3]
target = 7
position = -1

for i in range(len(nums)):
    if nums[i] == target:
        position = i
        break

print(position)
`,
  },
  {
    group: HINTS,
    name: "3 · pointers: mark a position in a list",
    code: `# viz: pointers nums: read
#
# Remove duplicates from a sorted list, in place. "write" is used as
# nums[write], so it's drawn under the list automatically. "read" comes
# from enumerate() and is never written as nums[read], so the hint is
# what draws it.
nums = [1, 1, 2, 3, 3, 3, 4]
write = 1

for read, value in enumerate(nums):
    if read > 0 and value != nums[write - 1]:
        nums[write] = value
        write += 1

del nums[write:]
print(nums)
`,
  },
  {
    group: HINTS,
    name: "4 · pointers: rows and columns of a grid",
    code: `# viz: pointers grid: r
# viz: pointers grid[]: c
#
# The loops walk "for row in grid", so the code never writes grid[r][c].
# The hints draw r beside its row and c under its column ("grid[]"
# means the lists inside grid), and outline the cell where they meet.
grid = [
    [3, 0, 2],
    [1, 4, 1],
    [0, 2, 5],
]
col_sums = [0, 0, 0]

for r, row in enumerate(grid):
    for c, value in enumerate(row):
        col_sums[c] += value

print(col_sums)
`,
  },
  {
    group: HINTS,
    name: "5 · tree: a tree with parent links",
    code: `# viz: tree Node(left, right)
#
# Every node also links back to its parent. That's three links, so
# without the hint this is drawn as a list with arcs. The hint says
# which two links are the children, and it's drawn as a tree, in the
# memory view and the loop history.
class Node:
    def __init__(self, key, parent=None):
        self.key = key
        self.parent = parent
        self.left = None
        self.right = None

def insert(root, key):
    node = root
    while True:
        side = "left" if key < node.key else "right"
        child = getattr(node, side)
        if child is None:
            setattr(node, side, Node(key, node))
            return
        node = child

root = Node(50)
for key in [30, 70, 20, 40, 60]:
    insert(root, key)

# Climb back up from a leaf using the parent links.
node = root.left.right
while node:
    node = node.parent
`,
  },
  {
    group: HINTS,
    name: "6 · list: follow only one link",
    code: `# viz: list Item(next)
#
# Each item also has a "random" link to any other item, so the loop
# history would draw a tangle of arcs. The hint says to follow "next"
# only. The memory view still shows every field.
class Item:
    def __init__(self, val):
        self.val = val
        self.next = None
        self.random = None

a, b, c, d = Item("a"), Item("b"), Item("c"), Item("d")
a.next, b.next, c.next = b, c, d
a.random, b.random, c.random, d.random = c, a, d, b
head = a

values = []
item = head
while item:
    values.append(item.val)
    item = item.next

print(values)
`,
  },
  {
    group: HINTS,
    name: "7 · graph: neighbors by number",
    code: `# viz: graph adj
#
# A list of neighbor lists, where adj[3] lists node 3's neighbors. A
# grid looks the same, so this is only drawn as a graph when a hint
# says so. Then the search's variables show up on it: "seen" (one
# True/False per node) fills nodes in, "stack" numbers what's waiting,
# and u and v mark the current nodes.
adj = [
    [1, 2],
    [0, 3],
    [0, 3],
    [1, 2, 4],
    [3],
]
seen = [False] * len(adj)
seen[0] = True
stack = [0]

while stack:
    u = stack.pop()
    for v in adj[u]:
        if not seen[v]:
            seen[v] = True
            stack.append(v)

print(seen)
`,
  },
  {
    group: HINTS,
    name: "8 · graph options: a matrix, directed, in a circle",
    code: `# viz: graph flights matrix directed circle: reach, frontier, city, nxt
#
# flights[i][j] is 1 when there's a flight from city i to city j.
#  - "matrix" reads it as an adjacency matrix
#  - "directed" draws one-way arrows
#  - "circle" puts the cities in a ring
#  - after the colon: variables to draw on the graph
flights = [
    [0, 1, 0, 0],
    [0, 0, 1, 1],
    [1, 0, 0, 0],
    [0, 0, 0, 0],
]
n = len(flights)
reach = {0}
frontier = [0]

while frontier:
    city = frontier.pop(0)
    for nxt in range(n):
        if flights[city][nxt] and nxt not in reach:
            reach.add(nxt)
            frontier.append(nxt)

print(sorted(reach))
`,
  },
  {
    group: HINTS,
    name: "9 · graph edgelist: minimum spanning tree",
    code: `# viz: graph edges edgelist undirected: parent, mst, a, b
#
# Kruskal's algorithm. "edges" is a list of (a, b, weight) edges, read
# as a graph with "edgelist". Two of the variables on it:
#  - parent: a union-find forest. Its links are drawn in green, so you
#    can watch separate trees merge.
#  - mst: the edges chosen so far, drawn in purple.
edges = [(0, 1, 4), (0, 2, 1), (1, 2, 2), (1, 3, 5), (2, 3, 8), (3, 4, 3)]
parent = list(range(5))
mst = []

def find(x):
    while parent[x] != x:
        x = parent[x]
    return x

for a, b, w in sorted(edges, key=lambda e: e[2]):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[ra] = rb
        mst.append((a, b, w))

print(mst)
`,
  },
  {
    group: HINTS,
    name: "10 · all together: a route planner",
    code: `# viz: graph roads: best, frontier, came_from, here, there, route
# viz: plain closed
# viz: hide steps, new_cost
# viz: show goal
#
# Dijkstra on a road map, with one road closed. Every kind of hint:
#  - graph: draw "roads" with these variables on it. "best" labels each
#    place with its cost, "frontier" numbers the heap, "came_from" draws
#    the tree of best routes, "route" the final path.
#  - plain: "closed" is shaped like a graph, but it's just a lookup
#    table, so draw it as an ordinary dict.
#  - hide: "steps" and "new_cost" are bookkeeping.
#  - show: keep "goal" in the loop history, though it never changes.
import heapq

roads = {
    "A": {"B": 4, "C": 2},
    "B": {"A": 4, "C": 1, "D": 5},
    "C": {"A": 2, "B": 1, "D": 8, "E": 10},
    "D": {"B": 5, "C": 8, "E": 2},
    "E": {"C": 10, "D": 2},
}
closed = {"B": ["D"], "D": ["B"]}

def plan(start, goal):
    best = {start: 0}
    came_from = {start: None}
    frontier = [(0, start)]
    steps = 0
    while frontier:
        cost, here = heapq.heappop(frontier)
        steps += 1
        if here == goal:
            break
        for there, length in roads[here].items():
            if there in closed.get(here, []):
                continue
            new_cost = cost + length
            if new_cost < best.get(there, float("inf")):
                best[there] = new_cost
                came_from[there] = here
                heapq.heappush(frontier, (new_cost, there))

    route = [goal]
    while came_from[route[-1]] is not None:
        route.append(came_from[route[-1]])
    route.reverse()
    print(steps, "steps, cost", best[goal])
    return route

trip = plan("A", "E")
print(trip)
`,
  },
];
