// Stress 1: a long chain of objects. 2,000 nodes, each its own box in
// Arrows mode: one column per node, so the memory view is very wide.
class Node {
  constructor(val, next = null) {
    this.val = val;
    this.next = next;
  }
}

const N = 2000;
let head = null;
for (let i = N; i > 0; i--) head = new Node(i, head);

// Walk it, so there are steps with a pointer moving down the chain.
let curr = head;
let total = 0;
while (curr) {
  total += curr.val;
  curr = curr.next;
}
console.log(total);
