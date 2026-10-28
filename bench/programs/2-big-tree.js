// Stress 2: a binary search tree of 1,023 nodes (10 levels), built from
// shuffled keys so it's bushy, then searched. Trees are laid out as one
// block: 512 leaves side by side.
class TreeNode {
  constructor(key) {
    this.key = key;
    this.left = null;
    this.right = null;
  }
}

function insert(root, key) {
  if (!root) return new TreeNode(key);
  if (key < root.key) root.left = insert(root.left, key);
  else root.right = insert(root.right, key);
  return root;
}

// Keys in an order that builds a balanced tree: middle first, then halves.
const keys = [];
function order(lo, hi) {
  if (lo > hi) return;
  const mid = (lo + hi) >> 1;
  keys.push(mid);
  order(lo, mid - 1);
  order(mid + 1, hi);
}
order(1, 1023);

let root = null;
for (const k of keys) root = insert(root, k);

let node = root;
const target = 777;
while (node && node.key !== target) node = target < node.key ? node.left : node.right;
console.log(node ? "found" : "missing");
