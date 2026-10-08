import { describe, expect, it } from "vitest";
import { traceJavaScript } from "../js/trace";
import { findLinkedTrack, linkedRow, linkedSignature, treeDepths, type RowSnapshot } from "./linked";
import { buildLoopHistory } from "./loopHistory";

/** Rows of the first loop, as the loop view sees them. */
async function loopRows(source: string): Promise<RowSnapshot[]> {
  const trace = await traceJavaScript(source);
  expect(trace.error).toBeNull();
  const history = buildLoopHistory(trace, trace.steps.length - 1, null)!;
  return history.rows.map((row) => ({ locals: row.frame.locals, heap: row.heap }));
}

const REVERSE = `
class Node {
  constructor(val, next = null) { this.val = val; this.next = next; }
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
`;

describe("linked structures", () => {
  it("finds the node class, its link and its value field", async () => {
    const track = findLinkedTrack(await loopRows(REVERSE))!;
    expect(track).toMatchObject({ typeName: "Node", links: ["next"], valueField: "val" });
    expect(track.order).toHaveLength(3);
  });

  it("keeps nodes in fixed columns while the links turn around", async () => {
    const rows = await loopRows(REVERSE);
    const track = findLinkedTrack(rows)!;
    const [a, b, c] = track.order;
    const value = (row: RowSnapshot, id: string) => linkedRow(track, row).nodes.get(id)?.value;
    expect([a, b, c].map((id) => (value(rows[0], id) as { repr: string }).repr)).toEqual(["1", "2", "3"]);

    // Before: 1 -> 2 -> 3. After: 3 -> 2 -> 1.
    const first = linkedRow(track, rows[0]);
    const last = linkedRow(track, rows[rows.length - 1]);
    expect([a, b, c].map((id) => first.nodes.get(id)!.links[0])).toEqual([b, c, null]);
    expect([a, b, c].map((id) => last.nodes.get(id)!.links[0])).toEqual([null, a, b]);
    expect(linkedSignature(first)).not.toBe(linkedSignature(last));
  });

  it("reports which variables point at which node", async () => {
    const rows = await loopRows(REVERSE);
    const track = findLinkedTrack(rows)!;
    const before = linkedRow(track, rows[0]).pointers;
    expect(before).toEqual(expect.arrayContaining([{ name: "head", index: 0 }, { name: "curr", index: 0 }]));
  });

  it("finds nodes through `this` inside a method", async () => {
    const rows = await loopRows(`
      class ListNode { constructor(v) { this.v = v; this.next = null; } }
      class LinkedList {
        constructor() { this.head = null; }
        push(v) { const n = new ListNode(v); n.next = this.head; this.head = n; }
        size() {
          let count = 0;
          let node = this.head;
          while (node) {
            count++;
            node = node.next;
          }
          return count;
        }
      }
      const list = new LinkedList();
      list.push(1); list.push(2);
      list.size();
    `);
    const track = findLinkedTrack(rows)!;
    expect(track.typeName).toBe("ListNode");
    const names = linkedRow(track, rows[0]).pointers.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["this.head", "node"]));
  });

  it("orders a binary search tree in order, so it reads sorted", async () => {
    const rows = await loopRows(`
      class T { constructor(k) { this.key = k; this.left = null; this.right = null; } }
      const root = new T(5);
      root.left = new T(2);
      root.right = new T(8);
      root.left.right = new T(3);
      let node = root;
      while (node) {
        node = node.left;
      }
    `);
    const track = findLinkedTrack(rows)!;
    expect(track.links).toEqual(["left", "right"]);
    const keys = track.order.map((id) => (linkedRow(track, rows[0]).nodes.get(id)?.value as { repr: string }).repr);
    expect(keys).toEqual(["2", "3", "5", "8"]);
  });

  it("recognizes a binary tree and gives each node its depth", async () => {
    const rows = await loopRows(`
      class T { constructor(k) { this.key = k; this.left = null; this.right = null; } }
      const root = new T(5);
      root.left = new T(2);
      root.right = new T(8);
      root.left.right = new T(3);
      let node = root;
      while (node) {
        node = node.left;
      }
    `);
    const track = findLinkedTrack(rows)!;
    expect(track.shape).toBe("tree");
    const state = linkedRow(track, rows[0]);
    const depths = treeDepths(state);
    const byKey = Object.fromEntries(track.order.map((id) => [(state.nodes.get(id)!.value as { repr: string }).repr, depths.get(id)]));
    expect(byKey).toEqual({ 5: 0, 2: 1, 8: 1, 3: 2 });
  });

  it("doesn't mistake a doubly linked list for a tree", async () => {
    const rows = await loopRows(`
      class N { constructor(v) { this.v = v; this.prev = null; this.next = null; } }
      const a = new N(1), b = new N(2), c = new N(3);
      a.next = b; b.prev = a; b.next = c; c.prev = b;
      let n = a;
      while (n) {
        n = n.next;
      }
    `);
    const track = findLinkedTrack(rows)!;
    expect(track.shape).toBe("list");
    const values = track.order.map((id) => (linkedRow(track, rows[0]).nodes.get(id)!.value as { repr: string }).repr);
    expect(values).toEqual(["1", "2", "3"]); // in list order, not reversed
  });

  it("treats JavaScript plain objects with links as nodes", async () => {
    const rows = await loopRows(`
      let list = { val: 1, next: { val: 2, next: null } };
      let total = 0;
      for (let n = list; n; n = n.next) {
        total += n.val;
      }
    `);
    expect(findLinkedTrack(rows)).toMatchObject({ typeName: "Object", links: ["next"], valueField: "val" });
  });

  it("finds nothing when there are no linked objects", async () => {
    expect(findLinkedTrack(await loopRows(`const a = [1, 2];\nfor (const x of a) {\n  a.push(x);\n  break;\n}`))).toBeNull();
  });
});
