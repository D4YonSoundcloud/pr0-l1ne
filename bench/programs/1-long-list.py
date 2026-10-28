# Stress 1: a long chain of objects. 2,000 nodes, each its own box in
# Arrows mode: one column per node, so the memory view is very wide.
class Node:
    def __init__(self, val, next=None):
        self.val = val
        self.next = next

N = 2000
head = None
for i in range(N, 0, -1):
    head = Node(i, head)

# Walk it, so there are steps with a pointer moving down the chain.
curr = head
total = 0
while curr:
    total += curr.val
    curr = curr.next
print(total)
