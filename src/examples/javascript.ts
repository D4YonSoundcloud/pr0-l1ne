import type { Example } from "./index";

const SORTING = "Sorting";
const SEARCHING = "Searching and two pointers";
const LINKED = "Linked lists and trees";
const GRAPHS = "Graphs";
const GRIDS = "Grids and dynamic programming";
const FUNCTIONS = "Functions, classes and async";
const HINTS = "Hints, step by step";

export const JAVASCRIPT_EXAMPLES: Example[] = [
  // ------------------------------------------------------------- sorting
  {
    group: SORTING,
    name: "Bubble sort",
    code: `const arr = [5, 2, 9, 1, 6];
const n = arr.length;

for (let i = 0; i < n; i++) {
  for (let j = 0; j < n - i - 1; j++) {
    if (arr[j] > arr[j + 1]) {
      [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
    }
  }
}

console.log(arr);
`,
  },
  {
    group: SORTING,
    name: "Insertion sort",
    code: `const nums = [7, 3, 5, 1, 4];

for (let i = 1; i < nums.length; i++) {
  const key = nums[i];
  let j = i - 1;
  // Shift bigger values right until key's spot opens up.
  while (j >= 0 && nums[j] > key) {
    nums[j + 1] = nums[j];
    j--;
  }
  nums[j + 1] = key;
}

console.log(nums);
`,
  },
  {
    group: SORTING,
    name: "Merge sort (recursion)",
    code: `function mergeSort(items) {
  if (items.length <= 1) {
    return items;
  }
  const mid = Math.floor(items.length / 2);
  const left = mergeSort(items.slice(0, mid));
  const right = mergeSort(items.slice(mid));

  const merged = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] <= right[j]) {
      merged.push(left[i]);
      i++;
    } else {
      merged.push(right[j]);
      j++;
    }
  }
  return [...merged, ...left.slice(i), ...right.slice(j)];
}

console.log(mergeSort([5, 2, 7, 1, 3]));
`,
  },
  // ------------------------------------------------------------- searching
  {
    group: SEARCHING,
    name: "Binary search",
    code: `const nums = [2, 5, 8, 12, 16, 23, 38, 56, 72];
const target = 23;
let lo = 0;
let hi = nums.length - 1;
let found = -1;

while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (nums[mid] === target) {
    found = mid;
    break;
  } else if (nums[mid] < target) {
    lo = mid + 1;
  } else {
    hi = mid - 1;
  }
}

console.log("found at", found);
`,
  },
  {
    group: SEARCHING,
    name: "Reverse a string (two pointers)",
    code: `const chars = "stressed".split("");
let left = 0;
let right = chars.length - 1;

while (left < right) {
  [chars[left], chars[right]] = [chars[right], chars[left]];
  left++;
  right--;
}

console.log(chars.join(""));
`,
  },
  {
    group: SEARCHING,
    name: "Two sum (hash map)",
    code: `const nums = [3, 8, 11, 2, 7];
const target = 9;
const seen = new Map(); // value -> index where we saw it
let answer = null;

for (let i = 0; i < nums.length; i++) {
  const need = target - nums[i];
  if (seen.has(need)) {
    answer = [seen.get(need), i];
    break;
  }
  seen.set(nums[i], i);
}

console.log(answer);
`,
  },
  {
    group: SEARCHING,
    name: "Sliding window (best sum of k)",
    code: `const nums = [2, 1, 5, 1, 3, 2];
const k = 3;
let window = nums[0] + nums[1] + nums[2];
let best = window;

for (let right = k; right < nums.length; right++) {
  // Slide: add the new value, drop the one that left the window.
  window += nums[right] - nums[right - k];
  best = Math.max(best, window);
}

console.log(best);
`,
  },
  {
    group: SEARCHING,
    name: "Word frequency (object as a map)",
    code: `const words = "the cat and the hat and the bat".split(" ");
const counts = {};

for (const word of words) {
  counts[word] = (counts[word] ?? 0) + 1;
}

console.log(counts);
`,
  },
  // ------------------------------------------------------------- linked lists and trees
  {
    group: LINKED,
    name: "Reverse a linked list",
    code: `class Node {
  constructor(val, next = null) {
    this.val = val;
    this.next = next;
  }
}

let head = new Node(1, new Node(2, new Node(3)));

let prev = null;
let curr = head;
while (curr) {
  const next = curr.next;
  curr.next = prev;
  prev = curr;
  curr = next;
}
head = prev;
`,
  },
  {
    group: LINKED,
    name: "Find a cycle (fast and slow pointers)",
    code: `class Node {
  constructor(val) {
    this.val = val;
    this.next = null;
  }
}

const head = new Node(1);
head.next = new Node(2);
head.next.next = new Node(3);
head.next.next.next = new Node(4);
head.next.next.next.next = new Node(5);
head.next.next.next.next.next = head.next.next; // 5 -> 3: a cycle

let slow = head;
let fast = head;
let hasCycle = false;
while (fast && fast.next) {
  slow = slow.next;
  fast = fast.next.next;
  if (slow === fast) {
    hasCycle = true;
    break;
  }
}

console.log(hasCycle);
`,
  },
  {
    group: LINKED,
    name: "Binary search tree insert",
    code: `class TreeNode {
  constructor(key) {
    this.key = key;
    this.left = null;
    this.right = null;
  }
}

function insert(root, key) {
  let node = root;
  while (true) {
    if (key < node.key) {
      if (node.left === null) {
        node.left = new TreeNode(key);
        return;
      }
      node = node.left;
    } else {
      if (node.right === null) {
        node.right = new TreeNode(key);
        return;
      }
      node = node.right;
    }
  }
}

const root = new TreeNode(8);
for (const key of [3, 10, 1, 6, 14]) {
  insert(root, key);
}
`,
  },
  {
    group: LINKED,
    name: "Tree traversal (in-order)",
    code: `class TreeNode {
  constructor(key, left = null, right = null) {
    this.key = key;
    this.left = left;
    this.right = right;
  }
}

const root = new TreeNode(4,
  new TreeNode(2, new TreeNode(1), new TreeNode(3)),
  new TreeNode(6, new TreeNode(5), new TreeNode(7)));
const order = [];

function inorder(node) {
  if (node === null) {
    return;
  }
  inorder(node.left);
  order.push(node.key);
  inorder(node.right);
}

inorder(root);
console.log(order);
`,
  },
  {
    group: LINKED,
    name: "Trie (prefix tree)",
    code: `// Each node holds a Map of children, one per next letter. Classes
// whose objects hold Maps or arrays of each other are drawn as a graph:
// the letters label the edges, and filled nodes end a word.
class TrieNode {
  constructor() {
    this.children = new Map();
    this.isWord = false;
  }
}

const root = new TrieNode();

function insert(word) {
  let node = root;
  for (const ch of word) {
    if (!node.children.has(ch)) {
      node.children.set(ch, new TrieNode());
    }
    node = node.children.get(ch);
  }
  node.isWord = true;
}

for (const word of ["car", "cat", "cart", "dog"]) {
  insert(word);
}
`,
  },
  // ------------------------------------------------------------- graphs
  {
    group: GRAPHS,
    name: "Breadth-first search (shortest path)",
    code: `// An object of neighbor arrays is drawn as a graph. The search's own
// variables are drawn on it: the queue's order, the parent links (the
// BFS tree), the current node, and finally the path.
const graph = {
  A: ["B", "C"],
  B: ["A", "D", "E"],
  C: ["A", "F"],
  D: ["B"],
  E: ["B", "F"],
  F: ["C", "E"],
};

function shortestPath(start, goal) {
  const parent = { [start]: null };
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === goal) {
      break;
    }
    for (const nb of graph[node]) {
      if (!(nb in parent)) {
        parent[nb] = node;
        queue.push(nb);
      }
    }
  }

  const path = [];
  for (let node = goal; node !== null; node = parent[node]) {
    path.unshift(node);
  }
  return path;
}

const route = shortestPath("A", "F");
console.log(route);
`,
  },
  {
    group: GRAPHS,
    name: "Depth-first search (recursion)",
    code: `// A directed graph with no cycles is drawn in layers.
const graph = new Map([
  [1, [2, 3]],
  [2, [4]],
  [3, [4, 5]],
  [4, [6]],
  [5, [6]],
  [6, []],
]);
const visited = new Set();
const order = [];

function dfs(node) {
  visited.add(node);
  order.push(node);
  for (const next of graph.get(node)) {
    if (!visited.has(next)) {
      dfs(next);
    }
  }
}

dfs(1);
console.log(order);
`,
  },
  {
    group: GRAPHS,
    name: "Dijkstra's shortest paths (weighted)",
    code: `// An object of { neighbor: distance } objects is a weighted graph.
const roads = {
  home: { park: 2, shop: 5 },
  park: { home: 2, shop: 1, school: 4 },
  shop: { home: 5, park: 1, school: 1 },
  school: { park: 4, shop: 1 },
};

const dist = { home: 0, park: Infinity, shop: Infinity, school: Infinity };
const heap = [[0, "home"]]; // [distance, place], smallest first
const done = new Set();

while (heap.length > 0) {
  heap.sort((a, b) => a[0] - b[0]);
  const [d, node] = heap.shift();
  if (done.has(node)) {
    continue;
  }
  done.add(node);
  for (const [nb, w] of Object.entries(roads[node])) {
    if (d + w < dist[nb]) {
      dist[nb] = d + w;
      heap.push([dist[nb], nb]);
    }
  }
}

console.log(dist);
`,
  },
  {
    group: GRAPHS,
    name: "Topological sort (getting dressed)",
    code: `// What has to go on before what. Kahn's algorithm: repeatedly take
// something nothing else is waiting on.
const needs = {
  socks: ["shoes"],
  pants: ["shoes", "belt"],
  shirt: ["belt", "tie"],
  tie: ["jacket"],
  belt: ["jacket"],
  shoes: [],
  jacket: [],
};

const indegree = {};
for (const item in needs) {
  indegree[item] ??= 0;
  for (const after of needs[item]) {
    indegree[after] = (indegree[after] ?? 0) + 1;
  }
}

const ready = Object.keys(needs).filter((item) => indegree[item] === 0);
const order = [];
while (ready.length > 0) {
  const item = ready.shift();
  order.push(item);
  for (const after of needs[item]) {
    indegree[after]--;
    if (indegree[after] === 0) {
      ready.push(after);
    }
  }
}

console.log(order);
`,
  },
  {
    group: GRAPHS,
    name: "Graph of objects (reachable cities)",
    code: `// Objects that hold arrays of each other are drawn as a graph too.
class City {
  constructor(name) {
    this.name = name;
    this.roads = [];
  }
}

function connect(a, b) {
  a.roads.push(b);
  b.roads.push(a);
}

const paris = new City("Paris");
const lyon = new City("Lyon");
const nice = new City("Nice");
const nantes = new City("Nantes");
const dijon = new City("Dijon");
connect(paris, lyon);
connect(lyon, nice);
connect(paris, nantes);
connect(nantes, nice);
connect(lyon, dijon);

function reachable(start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const city = stack.pop();
    for (const next of city.roads) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen.size;
}

console.log(reachable(nice));
`,
  },
  // ------------------------------------------------------------- grids and DP
  {
    group: GRIDS,
    name: "Grid paths (dynamic programming)",
    code: `const rows = 3;
const cols = 4;
const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));

for (let i = 0; i < rows; i++) {
  for (let j = 0; j < cols; j++) {
    if (i === 0 || j === 0) {
      grid[i][j] = 1;
    } else {
      grid[i][j] = grid[i - 1][j] + grid[i][j - 1];
    }
  }
}

console.log(grid[rows - 1][cols - 1], "paths");
`,
  },
  {
    group: GRIDS,
    name: "Longest common subsequence",
    code: `const a = "BDCA";
const b = "BCA";
const rows = a.length + 1;
const cols = b.length + 1;
const table = Array.from({ length: rows }, () => new Array(cols).fill(0));

for (let i = 1; i < rows; i++) {
  for (let j = 1; j < cols; j++) {
    if (a[i - 1] === b[j - 1]) {
      table[i][j] = table[i - 1][j - 1] + 1;
    } else {
      table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
}

console.log(table[rows - 1][cols - 1]);
`,
  },
  {
    group: GRIDS,
    name: "Coin change (fewest coins)",
    code: `const coins = [1, 3, 4];
const amount = 6;
const best = [0, ...new Array(amount).fill(Infinity)]; // best[t]: fewest coins making t

for (let total = 1; total <= amount; total++) {
  for (const coin of coins) {
    if (coin <= total && best[total - coin] + 1 < best[total]) {
      best[total] = best[total - coin] + 1;
    }
  }
}

console.log(best[amount]);
`,
  },
  {
    group: GRIDS,
    name: "Number of islands (flood fill)",
    code: `const grid = [
  [1, 1, 0, 0],
  [1, 0, 0, 1],
  [0, 0, 1, 1],
];
const rows = grid.length;
const cols = grid[0].length;
let islands = 0;

function sink(r, c) {
  if (r < 0 || c < 0 || r >= rows || c >= cols || grid[r][c] === 0) {
    return;
  }
  grid[r][c] = 0;
  sink(r + 1, c);
  sink(r - 1, c);
  sink(r, c + 1);
  sink(r, c - 1);
}

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    if (grid[r][c] === 1) {
      islands++;
      sink(r, c);
    }
  }
}

console.log(islands);
`,
  },
  {
    group: GRIDS,
    name: "Fibonacci with a memo",
    code: `const memo = new Map();

function fib(n) {
  if (memo.has(n)) {
    return memo.get(n);
  }
  if (n < 2) {
    return n;
  }
  memo.set(n, fib(n - 1) + fib(n - 2));
  return memo.get(n);
}

console.log(fib(6));
`,
  },
  // ------------------------------------------------------------- functions
  {
    group: FUNCTIONS,
    name: "Recursion (factorial)",
    code: `function factorial(n) {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

const result = factorial(4);
console.log(result);
`,
  },
  {
    group: FUNCTIONS,
    name: "Closures and scope",
    code: `function makeCounter(start) {
  let count = start;

  return function increment() {
    count += 1;
    return count;
  };
}

const counter = makeCounter(10);
counter();
counter();
`,
  },
  {
    group: FUNCTIONS,
    name: "A class with methods (stack)",
    code: `class Stack {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
  }

  pop() {
    return this.items.pop();
  }
}

function balanced(text) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = new Stack();
  for (const ch of text) {
    if ("([{".includes(ch)) {
      stack.push(ch);
    } else if (ch in pairs && stack.pop() !== pairs[ch]) {
      return false;
    }
  }
  return stack.items.length === 0;
}

console.log(balanced("{[()]}"), balanced("(]"));
`,
  },
  {
    group: FUNCTIONS,
    name: "Array methods with callbacks",
    code: `const scores = [72, 95, 58, 88];

const passed = scores.filter((score) => score >= 60);
const curved = passed.map((score) => Math.min(100, score + 5));
const total = curved.reduce((sum, score) => sum + score, 0);

console.log(curved, total);
`,
  },
  {
    group: FUNCTIONS,
    name: "Generator (Fibonacci)",
    code: `function* fibonacci() {
  let a = 0;
  let b = 1;
  while (true) {
    yield a;
    [a, b] = [b, a + b];
  }
}

const fib = fibonacci();
const first = [];
for (let i = 0; i < 6; i++) {
  first.push(fib.next().value);
}

console.log(first);
`,
  },
  {
    group: FUNCTIONS,
    name: "Async tasks and timers",
    code: `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(name, ms) {
  console.log("start", name);
  await sleep(ms);
  console.log("done", name);
  return name.length;
}

async function main() {
  const sizes = await Promise.all([
    download("photo.png", 300),
    download("notes.txt", 100),
  ]);
  console.log("sizes", sizes);
}

main();
`,
  },
  // ------------------------------------------------------------- hints
  {
    group: HINTS,
    name: "1 · hide: leave out helper variables",
    code: `// viz: hide before, receipt
//
// A hint is a comment starting with "viz:". This one hides two helper
// variables, so the loop history only shows what matters: the running
// total. Delete the hint line to see the difference.
const prices = [12, 7, 30, 5];
let total = 0;

for (const price of prices) {
  const before = total;
  total += price;
  const receipt = before + " + " + price + " = " + total;
}

console.log(total);
`,
  },
  {
    group: HINTS,
    name: "2 · show: keep a variable that never changes",
    code: `// viz: show target
//
// The loop history leaves out variables that don't change during the
// loop. "target" never changes, but it's what we're looking for, so the
// hint keeps it in every row.
const nums = [4, 9, 1, 7, 3];
const target = 7;
let position = -1;

for (let i = 0; i < nums.length; i++) {
  if (nums[i] === target) {
    position = i;
    break;
  }
}

console.log(position);
`,
  },
  {
    group: HINTS,
    name: "3 · pointers: mark a position in an array",
    code: `// viz: pointers nums: read
//
// Remove duplicates from a sorted array, in place. "write" is used as
// nums[write], so it's drawn under the array automatically. "read"
// comes from entries() and is never written as nums[read], so the hint
// is what draws it.
const nums = [1, 1, 2, 3, 3, 3, 4];
let write = 1;

for (const [read, value] of nums.entries()) {
  if (read > 0 && value !== nums[write - 1]) {
    nums[write] = value;
    write++;
  }
}

nums.length = write;
console.log(nums);
`,
  },
  {
    group: HINTS,
    name: "4 · pointers: rows and columns of a grid",
    code: `// viz: pointers grid: r
// viz: pointers grid[]: c
//
// The loops use forEach on each row, so the code never writes
// grid[r][c]. The hints draw r beside its row and c under its column
// ("grid[]" means the arrays inside grid), and outline the cell where
// they meet.
const grid = [
  [3, 0, 2],
  [1, 4, 1],
  [0, 2, 5],
];
const colSums = [0, 0, 0];

grid.forEach((row, r) => {
  row.forEach((value, c) => {
    colSums[c] += value;
  });
});

console.log(colSums);
`,
  },
  {
    group: HINTS,
    name: "5 · tree: a tree with parent links",
    code: `// viz: tree Node(left, right)
//
// Every node also links back to its parent. That's three links, so
// without the hint this is drawn as a list with arcs. The hint says
// which two links are the children, and it's drawn as a tree, in the
// memory view and the loop history.
class Node {
  constructor(key, parent = null) {
    this.key = key;
    this.parent = parent;
    this.left = null;
    this.right = null;
  }
}

function insert(root, key) {
  let node = root;
  while (true) {
    const side = key < node.key ? "left" : "right";
    if (node[side] === null) {
      node[side] = new Node(key, node);
      return;
    }
    node = node[side];
  }
}

const root = new Node(50);
for (const key of [30, 70, 20, 40, 60]) {
  insert(root, key);
}

// Climb back up from a leaf using the parent links.
let node = root.left.right;
while (node) {
  node = node.parent;
}
`,
  },
  {
    group: HINTS,
    name: "6 · list: follow only one link",
    code: `// viz: list Item(next)
//
// Each item also has a "random" link to any other item, so the loop
// history would draw a tangle of arcs. The hint says to follow "next"
// only. The memory view still shows every field.
class Item {
  constructor(val) {
    this.val = val;
    this.next = null;
    this.random = null;
  }
}

const [a, b, c, d] = ["a", "b", "c", "d"].map((val) => new Item(val));
a.next = b;
b.next = c;
c.next = d;
a.random = c;
b.random = a;
c.random = d;
d.random = b;
const head = a;

const values = [];
for (let item = head; item !== null; item = item.next) {
  values.push(item.val);
}

console.log(values);
`,
  },
  {
    group: HINTS,
    name: "7 · graph: neighbors by number",
    code: `// viz: graph adj
//
// An array of neighbor arrays, where adj[3] lists node 3's neighbors.
// A grid looks the same, so this is only drawn as a graph when a hint
// says so. Then the search's variables show up on it: "seen" (one
// true/false per node) fills nodes in, "stack" numbers what's waiting,
// and u and v mark the current nodes.
const adj = [
  [1, 2],
  [0, 3],
  [0, 3],
  [1, 2, 4],
  [3],
];
const seen = new Array(adj.length).fill(false);
seen[0] = true;
const stack = [0];

while (stack.length > 0) {
  const u = stack.pop();
  for (const v of adj[u]) {
    if (!seen[v]) {
      seen[v] = true;
      stack.push(v);
    }
  }
}

console.log(seen);
`,
  },
  {
    group: HINTS,
    name: "8 · graph options: a matrix, directed, in a circle",
    code: `// viz: graph flights matrix directed circle: reach, frontier, city, next
//
// flights[i][j] is 1 when there's a flight from city i to city j.
//  - "matrix" reads it as an adjacency matrix
//  - "directed" draws one-way arrows
//  - "circle" puts the cities in a ring
//  - after the colon: variables to draw on the graph
const flights = [
  [0, 1, 0, 0],
  [0, 0, 1, 1],
  [1, 0, 0, 0],
  [0, 0, 0, 0],
];
const n = flights.length;
const reach = new Set([0]);
const frontier = [0];

while (frontier.length > 0) {
  const city = frontier.shift();
  for (let next = 0; next < n; next++) {
    if (flights[city][next] && !reach.has(next)) {
      reach.add(next);
      frontier.push(next);
    }
  }
}

console.log([...reach]);
`,
  },
  {
    group: HINTS,
    name: "9 · graph edgelist: minimum spanning tree",
    code: `// viz: graph edges edgelist undirected: parent, mst, a, b
//
// Kruskal's algorithm. "edges" is an array of [a, b, weight] edges,
// read as a graph with "edgelist". Two of the variables on it:
//  - parent: a union-find forest. Its links are drawn in green, so you
//    can watch separate trees merge.
//  - mst: the edges chosen so far, drawn in purple.
const edges = [[0, 1, 4], [0, 2, 1], [1, 2, 2], [1, 3, 5], [2, 3, 8], [3, 4, 3]];
const parent = [0, 1, 2, 3, 4];
const mst = [];

function find(x) {
  while (parent[x] !== x) {
    x = parent[x];
  }
  return x;
}

const byWeight = [...edges].sort((e1, e2) => e1[2] - e2[2]);
for (const [a, b, w] of byWeight) {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) {
    parent[ra] = rb;
    mst.push([a, b, w]);
  }
}

console.log(mst);
`,
  },
  {
    group: HINTS,
    name: "10 · all together: a route planner",
    code: `// viz: graph roads: best, frontier, cameFrom, here, there, route
// viz: plain closed
// viz: hide steps, newCost
// viz: show goal
//
// Dijkstra on a road map, with one road closed. Every kind of hint:
//  - graph: draw "roads" with these variables on it. "best" labels each
//    place with its cost, "frontier" numbers the queue, "cameFrom" draws
//    the tree of best routes, "route" the final path.
//  - plain: "closed" is shaped like a graph, but it's just a lookup
//    table, so draw it as an ordinary object.
//  - hide: "steps" and "newCost" are bookkeeping.
//  - show: keep "goal" in the loop history, though it never changes.
const roads = {
  A: { B: 4, C: 2 },
  B: { A: 4, C: 1, D: 5 },
  C: { A: 2, B: 1, D: 8, E: 10 },
  D: { B: 5, C: 8, E: 2 },
  E: { C: 10, D: 2 },
};
const closed = { B: ["D"], D: ["B"] };

function plan(start, goal) {
  const best = { [start]: 0 };
  const cameFrom = { [start]: null };
  const frontier = [[0, start]];
  let steps = 0;
  while (frontier.length > 0) {
    frontier.sort((x, y) => x[0] - y[0]);
    const [cost, here] = frontier.shift();
    steps++;
    if (here === goal) {
      break;
    }
    for (const [there, length] of Object.entries(roads[here])) {
      if ((closed[here] ?? []).includes(there)) {
        continue;
      }
      const newCost = cost + length;
      if (newCost < (best[there] ?? Infinity)) {
        best[there] = newCost;
        cameFrom[there] = here;
        frontier.push([newCost, there]);
      }
    }
  }

  const route = [goal];
  while (cameFrom[route[0]] !== null) {
    route.unshift(cameFrom[route[0]]);
  }
  console.log(steps, "steps, cost", best[goal]);
  return route;
}

const trip = plan("A", "E");
console.log(trip);
`,
  },
];
