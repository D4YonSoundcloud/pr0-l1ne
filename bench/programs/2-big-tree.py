# Stress 2: a binary search tree of 1,023 nodes (10 levels), built from
# keys in an order that keeps it balanced, then searched. Trees are laid
# out as one block: 512 leaves side by side.
class TreeNode:
    def __init__(self, key):
        self.key = key
        self.left = None
        self.right = None

def insert(root, key):
    if root is None:
        return TreeNode(key)
    if key < root.key:
        root.left = insert(root.left, key)
    else:
        root.right = insert(root.right, key)
    return root

keys = []
def order(lo, hi):
    if lo > hi:
        return
    mid = (lo + hi) // 2
    keys.append(mid)
    order(lo, mid - 1)
    order(mid + 1, hi)
order(1, 1023)

root = None
for k in keys:
    root = insert(root, k)

node = root
target = 777
while node and node.key != target:
    node = node.left if target < node.key else node.right
print("found" if node else "missing")
