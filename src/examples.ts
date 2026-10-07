/** Starter programs, each chosen to exercise a different part of the canvas. */
export interface Example {
  name: string;
  code: string;
}

export const PYTHON_EXAMPLES: Example[] = [
  {
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
    name: "Word frequency (dict)",
    code: `words = "the cat and the hat and the bat".split()
counts = {}

for word in words:
    counts[word] = counts.get(word, 0) + 1

print(counts)
`,
  },
];

export const JAVASCRIPT_EXAMPLES: Example[] = [
  {
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
    name: "Word frequency (object as a map)",
    code: `const words = "the cat and the hat and the bat".split(" ");
const counts = {};

for (const word of words) {
  counts[word] = (counts[word] ?? 0) + 1;
}

console.log(counts);
`,
  },
  {
    name: "Array methods with callbacks",
    code: `const scores = [72, 95, 58, 88];

const passed = scores.filter((score) => score >= 60);
const curved = passed.map((score) => Math.min(100, score + 5));
const total = curved.reduce((sum, score) => sum + score, 0);

console.log(curved, total);
`,
  },
];

export const TYPESCRIPT_EXAMPLES: Example[] = [
  {
    name: "Bubble sort",
    code: `const arr: number[] = [5, 2, 9, 1, 6];
const n: number = arr.length;

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
    name: "Binary search (generic)",
    code: `function binarySearch<T>(items: T[], target: T): number {
  let lo = 0;
  let hi = items.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (items[mid] === target) {
      return mid;
    } else if (items[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

const nums = [2, 5, 8, 12, 16, 23, 38, 56, 72];
console.log("found at", binarySearch(nums, 23));
`,
  },
  {
    name: "Stack (generic class)",
    code: `interface Collection<T> {
  readonly size: number;
  push(item: T): void;
  pop(): T | undefined;
}

class Stack<T> implements Collection<T> {
  private items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
  }

  pop(): T | undefined {
    return this.items.pop();
  }
}

function isBalanced(text: string): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack = new Stack<string>();
  for (const ch of text) {
    if ("([{".includes(ch)) {
      stack.push(ch);
    } else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) {
        return false;
      }
    }
  }
  return stack.size === 0;
}

console.log(isBalanced("{[()]}"), isBalanced("(]"));
`,
  },
  {
    name: "Reverse a linked list",
    code: `class ListNode<T> {
  constructor(public val: T, public next: ListNode<T> | null = null) {}
}

let head: ListNode<number> | null = new ListNode(1, new ListNode(2, new ListNode(3)));

let prev: ListNode<number> | null = null;
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
    name: "Binary search tree insert",
    code: `class TreeNode {
  left: TreeNode | null = null;
  right: TreeNode | null = null;
  constructor(public key: number) {}
}

function insert(root: TreeNode, key: number): void {
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
    name: "State machine (enum)",
    code: `enum Light {
  Red,
  Green,
  Yellow,
}

const next: Record<Light, Light> = {
  [Light.Red]: Light.Green,
  [Light.Green]: Light.Yellow,
  [Light.Yellow]: Light.Red,
};

let light = Light.Red;
const history: string[] = [];

for (let tick = 0; tick < 4; tick++) {
  history.push(Light[light]);
  light = next[light];
}

console.log(history.join(" -> "));
`,
  },
  {
    name: "Recursion (factorial)",
    code: `function factorial(n: number): number {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

const result: number = factorial(4);
console.log(result);
`,
  },
  {
    name: "Closures and scope",
    code: `type Counter = () => number;

function makeCounter(start: number): Counter {
  let count = start;

  return function increment(): number {
    count += 1;
    return count;
  };
}

const counter: Counter = makeCounter(10);
counter();
counter();
`,
  },
  {
    name: "Word frequency (Map)",
    code: `const words: string[] = "the cat and the hat and the bat".split(" ");
const counts = new Map<string, number>();

for (const word of words) {
  counts.set(word, (counts.get(word) ?? 0) + 1);
}

console.log(counts);
`,
  },
];
