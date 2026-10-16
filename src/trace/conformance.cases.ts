/**
 * Small programs written twice, in Python and in JavaScript, doing the same
 * thing. src/trace/conformance.test.ts traces both and checks the traces
 * have the same shape (src/trace/shape.ts): the same output, loops, passes,
 * objects and links. When the two tracers drift apart, a case here fails.
 *
 * Writing a case:
 * - Keep both programs line-for-line equivalent where the languages allow.
 * - Print only ints and strings (Python prints True and 1.0, JavaScript
 *   true and 1).
 * - `ignore` lists globals only one language keeps by its own rules, such
 *   as a Python loop variable after its loop (JavaScript's `let i` is gone).
 * - `skip` leaves out a part of the shape that differs by design, with the
 *   reason next to it.
 */
import type { TraceShape } from "./shape";

export interface ConformanceCase {
  name: string;
  python: string;
  javascript: string;
  ignore?: string[];
  skip?: (keyof TraceShape)[];
  /** A time budget for this case, when it's meant to run out of time. */
  maxSeconds?: number;
}

export const CASES: ConformanceCase[] = [
  {
    name: "numbers, strings, booleans and nothing",
    python: `count = 3
ratio = 1.5
name = "ada"
done = True
missing = None
print(name, count)
`,
    javascript: `let count = 3;
let ratio = 1.5;
let name = "ada";
let done = true;
let missing = null;
console.log(name, count);
`,
  },
  {
    name: "building a list with append",
    python: `squares = []
for n in range(5):
    squares.append(n * n)
print(len(squares))
`,
    javascript: `const squares = [];
for (let n = 0; n < 5; n++) {
  squares.push(n * n);
}
console.log(squares.length);
`,
    ignore: ["n"],
  },
  {
    name: "swapping list items",
    python: `arr = [5, 2, 9, 1]
arr[0], arr[3] = arr[3], arr[0]
`,
    javascript: `const arr = [5, 2, 9, 1];
[arr[0], arr[3]] = [arr[3], arr[0]];
`,
  },
  {
    name: "bubble sort",
    python: `arr = [5, 2, 9, 1, 6]
n = len(arr)
for i in range(n):
    for j in range(n - i - 1):
        if arr[j] > arr[j + 1]:
            arr[j], arr[j + 1] = arr[j + 1], arr[j]
`,
    javascript: `const arr = [5, 2, 9, 1, 6];
const n = arr.length;
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n - i - 1; j++) {
    if (arr[j] > arr[j + 1]) {
      [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
    }
  }
}
`,
    ignore: ["i", "j"],
  },
  {
    name: "counting words in a dict",
    python: `words = ["a", "b", "a", "c", "a"]
counts = {}
for w in words:
    counts[w] = counts.get(w, 0) + 1
`,
    javascript: `const words = ["a", "b", "a", "c", "a"];
const counts = {};
for (const w of words) {
  counts[w] = (counts[w] ?? 0) + 1;
}
`,
    ignore: ["w"],
  },
  {
    name: "a grid of lists",
    python: `grid = []
for r in range(3):
    grid.append([r * 3 + c for c in range(3)])
`,
    javascript: `const grid = [];
for (let r = 0; r < 3; r++) {
  grid.push([0, 1, 2].map((c) => r * 3 + c));
}
`,
    ignore: ["r"],
    skip: ["loops"], // the inner comprehension is a loop in Python, a map() call in JavaScript
  },
  {
    name: "a set of numbers",
    python: `seen = set()
for v in [3, 1, 3, 2, 1]:
    seen.add(v)
`,
    javascript: `const seen = new Set();
for (const v of [3, 1, 3, 2, 1]) {
  seen.add(v);
}
`,
    ignore: ["v"],
  },
  {
    name: "an object with fields",
    python: `class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

p = Point(2, 3)
p.x = 10
`,
    javascript: `class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

const p = new Point(2, 3);
p.x = 10;
`,
  },
  {
    name: "building a linked list",
    python: `class Node:
    def __init__(self, val):
        self.val = val
        self.next = None

head = Node(1)
tail = head
for v in [2, 3, 4]:
    tail.next = Node(v)
    tail = tail.next
`,
    javascript: `class Node {
  constructor(val) {
    this.val = val;
    this.next = null;
  }
}

const head = new Node(1);
let tail = head;
for (const v of [2, 3, 4]) {
  tail.next = new Node(v);
  tail = tail.next;
}
`,
    ignore: ["v"],
  },
  {
    name: "reversing a linked list",
    python: `class Node:
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
    javascript: `class Node {
  constructor(val, next = null) {
    this.val = val;
    this.next = next;
  }
}

let head = new Node(1, new Node(2, new Node(3)));
let prev = null;
let curr = head;
while (curr) {
  const nxt = curr.next;
  curr.next = prev;
  prev = curr;
  curr = nxt;
}
head = prev;
`,
    ignore: ["nxt"],
  },
  {
    name: "a binary search tree",
    python: `class Tree:
    def __init__(self, val):
        self.val = val
        self.left = None
        self.right = None

def insert(node, val):
    if node is None:
        return Tree(val)
    if val < node.val:
        node.left = insert(node.left, val)
    else:
        node.right = insert(node.right, val)
    return node

root = None
for v in [5, 3, 8, 1, 4]:
    root = insert(root, v)
`,
    javascript: `class Tree {
  constructor(val) {
    this.val = val;
    this.left = null;
    this.right = null;
  }
}

function insert(node, val) {
  if (node === null) {
    return new Tree(val);
  }
  if (val < node.val) {
    node.left = insert(node.left, val);
  } else {
    node.right = insert(node.right, val);
  }
  return node;
}

let root = null;
for (const v of [5, 3, 8, 1, 4]) {
  root = insert(root, v);
}
`,
    ignore: ["v"],
  },
  {
    name: "a cycle of references",
    python: `class Node:
    def __init__(self, val):
        self.val = val
        self.next = None

a = Node(1)
b = Node(2)
a.next = b
b.next = a
`,
    javascript: `class Node {
  constructor(val) {
    this.val = val;
    this.next = null;
  }
}

const a = new Node(1);
const b = new Node(2);
a.next = b;
b.next = a;
`,
  },
  {
    name: "two names for one list",
    python: `first = [1, 2]
second = first
second.append(3)
`,
    javascript: `const first = [1, 2];
const second = first;
second.push(3);
`,
  },
  {
    name: "summing a list",
    python: `nums = [4, 8, 15, 16, 23, 42]
total = 0
for x in nums:
    total += x
print(total)
`,
    javascript: `const nums = [4, 8, 15, 16, 23, 42];
let total = 0;
for (const x of nums) {
  total += x;
}
console.log(total);
`,
    ignore: ["x"],
  },
  {
    name: "a while loop counting down",
    python: `n = 5
steps = 0
while n > 0:
    n -= 1
    steps += 1
`,
    javascript: `let n = 5;
let steps = 0;
while (n > 0) {
  n -= 1;
  steps += 1;
}
`,
  },
  {
    name: "break out of a loop",
    python: `found = -1
for i in range(10):
    if i * i > 20:
        found = i
        break
`,
    javascript: `let found = -1;
for (let i = 0; i < 10; i++) {
  if (i * i > 20) {
    found = i;
    break;
  }
}
`,
    ignore: ["i"],
  },
  {
    name: "continue in a loop",
    python: `odds = []
for i in range(8):
    if i % 2 == 0:
        continue
    odds.append(i)
`,
    javascript: `const odds = [];
for (let i = 0; i < 8; i++) {
  if (i % 2 === 0) {
    continue;
  }
  odds.push(i);
}
`,
    ignore: ["i"],
  },
  {
    name: "recursion: factorial",
    python: `def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

result = fact(6)
print(result)
`,
    javascript: `function fact(n) {
  if (n <= 1) {
    return 1;
  }
  return n * fact(n - 1);
}

const result = fact(6);
console.log(result);
`,
  },
  {
    name: "recursion: fibonacci with a memo",
    python: `memo = {}

def fib(n):
    if n < 2:
        return n
    if n in memo:
        return memo[n]
    memo[n] = fib(n - 1) + fib(n - 2)
    return memo[n]

answer = fib(10)
`,
    javascript: `const memo = new Map();

function fib(n) {
  if (n < 2) {
    return n;
  }
  if (memo.has(n)) {
    return memo.get(n);
  }
  memo.set(n, fib(n - 1) + fib(n - 2));
  return memo.get(n);
}

const answer = fib(10);
`,
  },
  {
    name: "a function that returns a new list",
    python: `def doubled(xs):
    out = []
    for x in xs:
        out.append(x * 2)
    return out

values = doubled([1, 2, 3])
`,
    javascript: `function doubled(xs) {
  const out = [];
  for (const x of xs) {
    out.push(x * 2);
  }
  return out;
}

const values = doubled([1, 2, 3]);
`,
  },
  {
    name: "building a string",
    python: `word = ""
for ch in ["c", "o", "d", "e"]:
    word = word + ch
print(word)
`,
    javascript: `let word = "";
for (const ch of ["c", "o", "d", "e"]) {
  word = word + ch;
}
console.log(word);
`,
    ignore: ["ch"],
  },
  {
    name: "a stack",
    python: `stack = []
for v in [1, 2, 3]:
    stack.append(v)
top = stack.pop()
`,
    javascript: `const stack = [];
for (const v of [1, 2, 3]) {
  stack.push(v);
}
const top = stack.pop();
`,
    ignore: ["v"],
  },
  {
    name: "breadth-first search",
    python: `graph = {"a": ["b", "c"], "b": ["d"], "c": ["d"], "d": []}
order = []
queue = ["a"]
seen = {"a"}
while queue:
    node = queue.pop(0)
    order.append(node)
    for nxt in graph[node]:
        if nxt not in seen:
            seen.add(nxt)
            queue.append(nxt)
print(" ".join(order))
`,
    javascript: `const graph = { a: ["b", "c"], b: ["d"], c: ["d"], d: [] };
const order = [];
const queue = ["a"];
const seen = new Set(["a"]);
while (queue.length) {
  const node = queue.shift();
  order.push(node);
  for (const nxt of graph[node]) {
    if (!seen.has(nxt)) {
      seen.add(nxt);
      queue.push(nxt);
    }
  }
}
console.log(order.join(" "));
`,
    ignore: ["node", "nxt"],
  },
  {
    name: "a list of records",
    python: `people = []
for name, age in [("ada", 36), ("alan", 41)]:
    people.append({"name": name, "age": age})
`,
    javascript: `const people = [];
for (const [name, age] of [["ada", 36], ["alan", 41]]) {
  people.push({ name: name, age: age });
}
`,
    ignore: ["name", "age"],
  },
  {
    name: "transposing a matrix",
    python: `m = [[1, 2, 3], [4, 5, 6]]
t = []
for c in range(3):
    row = []
    for r in range(2):
        row.append(m[r][c])
    t.append(row)
`,
    javascript: `const m = [[1, 2, 3], [4, 5, 6]];
const t = [];
for (let c = 0; c < 3; c++) {
  const row = [];
  for (let r = 0; r < 2; r++) {
    row.push(m[r][c]);
  }
  t.push(row);
}
`,
    ignore: ["c", "r", "row"],
  },
  {
    name: "returning early from a loop",
    python: `def index_of(xs, target):
    for i in range(len(xs)):
        if xs[i] == target:
            return i
    return -1

where = index_of([7, 3, 9], 9)
`,
    javascript: `function indexOf(xs, target) {
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === target) {
      return i;
    }
  }
  return -1;
}

const where = indexOf([7, 3, 9], 9);
`,
  },
  {
    name: "two pointers",
    python: `s = ["r", "a", "c", "e", "c", "a", "r"]
lo, hi = 0, len(s) - 1
same = True
while lo < hi:
    if s[lo] != s[hi]:
        same = False
    lo += 1
    hi -= 1
`,
    javascript: `const s = ["r", "a", "c", "e", "c", "a", "r"];
let lo = 0;
let hi = s.length - 1;
let same = true;
while (lo < hi) {
  if (s[lo] !== s[hi]) {
    same = false;
  }
  lo += 1;
  hi -= 1;
}
`,
  },
  {
    name: "a long loop is sampled the same way",
    python: `total = 0
for i in range(5000):
    total += i
`,
    javascript: `let total = 0;
for (let i = 0; i < 5000; i++) {
  total += i;
}
`,
    ignore: ["i"],
  },
  {
    name: "an endless loop is stopped",
    python: `x = 0
while True:
    x += 1
`,
    javascript: `let x = 0;
while (true) {
  x += 1;
}
`,
    // Long loops are sampled, so an endless one records few steps and is
    // stopped by the clock. How far each language gets in that time
    // differs, so x and the loop's passes aren't compared.
    maxSeconds: 1,
    skip: ["globals", "loops"],
  },
  {
    name: "an error stops the program",
    python: `done = []
for v in [1, 2, 3]:
    if v == 3:
        raise ValueError("three is too many")
    done.append(v)
`,
    javascript: `const done = [];
for (const v of [1, 2, 3]) {
  if (v === 3) {
    throw new Error("three is too many");
  }
  done.push(v);
}
`,
    ignore: ["v"],
  },
  {
    name: "a caught error",
    python: `log = []
try:
    raise ValueError("nope")
except ValueError:
    log.append("caught")
log.append("after")
`,
    javascript: `const log = [];
try {
  throw new Error("nope");
} catch (e) {
  log.push("caught");
}
log.push("after");
`,
  },
  {
    name: "nested function calls",
    python: `def square(x):
    return x * x

def sum_squares(xs):
    total = 0
    for x in xs:
        total += square(x)
    return total

answer = sum_squares([1, 2, 3])
print(answer)
`,
    javascript: `function square(x) {
  return x * x;
}

function sumSquares(xs) {
  let total = 0;
  for (const x of xs) {
    total += square(x);
  }
  return total;
}

const answer = sumSquares([1, 2, 3]);
console.log(answer);
`,
  },
];
