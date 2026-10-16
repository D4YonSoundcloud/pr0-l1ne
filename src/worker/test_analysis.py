"""Tests for the Python tracer's static analysis of code shape (cost_analysis),
called directly on source code without tracing it.
Run with: npm run test:tracer
"""

import ast
import textwrap
import unittest

import tracer as T


def shape(source):
    """The cost tree's functions by name."""
    tree = ast.parse(textwrap.dedent(source))
    return {f["name"]: f for f in T.cost_analysis(tree)["functions"]}


def loops(nodes):
    for node in nodes:
        if node["kind"] == "loop":
            yield node
            yield from loops(node["body"])


def nodes(nodes_, kind):
    for node in nodes_:
        if node["kind"] == kind:
            yield node
        if node["kind"] == "loop":
            yield from nodes(node["body"], kind)


def bounds(fn):
    return [loop["bound"] for loop in loops(fn["body"])]


class LoopBoundTests(unittest.TestCase):
    def test_shifting_and_floor_dividing_halve(self):
        fns = shape("""
            n = 100
            while n > 0:
                n >>= 1
            x = 64
            while x > 1:
                x //= 2
        """)
        self.assertEqual([b["kind"] for b in bounds(fns["Global"])], ["log", "log"])
        self.assertEqual(bounds(fns["Global"])[0]["size"], {"name": "n"})

    def test_comprehensions_size_what_they_build(self):
        fns = shape("""
            nums = [1, 2, 3]
            evens = [v for v in nums if v % 2 == 0]
            for e in evens:
                pass
            pairs = {(a, b) for a in nums for b in nums}
        """)
        allocs = {a["name"]: a for a in nodes(fns["Global"]["body"], "alloc")}
        self.assertEqual(allocs["evens"]["sizes"], [{"name": "nums", "len": True}])
        self.assertEqual(len(allocs["pairs"]["sizes"]), 2)  # n * n pairs
        self.assertEqual(bounds(fns["Global"])[1]["sizes"], [{"name": "evens", "len": True}])

    def test_views_and_wrappers_iterate_the_underlying_collection(self):
        fns = shape("""
            d = {"a": 1}
            for k in d.keys():
                pass
            for i, v in enumerate(reversed(sorted(d.values()))):
                pass
            for a, b in zip(d, d):
                pass
        """)
        for bound in bounds(fns["Global"]):
            self.assertEqual(bound["sizes"], [{"name": "d", "len": True}])
        sort = next(nodes(fns["Global"]["body"], "op"))
        self.assertEqual((sort["what"], sort["cost"]), ("sorted() (copies)", "nlogn"))

    def test_parameters_aliases_slices_and_inner_lengths(self):
        fns = shape("""
            def f(items):
                xs = items
                for x in xs:
                    pass
                for x in items[1:]:
                    pass
                for _ in range(len(items[0])):
                    pass
        """)
        b = bounds(fns["f"])
        self.assertEqual(b[0]["sizes"], [{"name": "xs", "len": True}])
        self.assertEqual(b[1]["sizes"], [{"name": "items", "len": True}])
        self.assertEqual(b[2]["sizes"], [{"name": "items", "len": True, "inner": True}])
        copy = next(nodes(fns["f"]["body"], "op"))
        self.assertEqual((copy["what"], copy["cost"]), ("items[1:] (copies)", "linear"))

    def test_rows_of_a_grid_are_inner_lengths(self):
        fns = shape("""
            grid = [[0] * 3 for _ in range(3)]
            for row in grid:
                for v in row:
                    pass
        """)
        b = bounds(fns["Global"])
        self.assertEqual(b[0], {"kind": "const", "why": "range(3)"})
        self.assertEqual(b[2]["sizes"], [{"name": "grid", "len": True, "inner": True}])

    def test_linked_walks_are_sized_by_the_list(self):
        fns = shape("""
            class Node:
                def __init__(self, v, nxt=None):
                    self.val = v
                    self.next = nxt
            head = Node(1, Node(2))
            node = head
            while node is not None and node.val < 5:
                node = node.next
            slow = fast = head
            while fast and fast.next:
                slow = slow.next
                fast = fast.next.next
        """)
        for bound in bounds(fns["Global"]):
            self.assertEqual(bound["sizes"], [{"name": "head", "len": True}])
            self.assertIn("follows .next", bound["why"])

    def test_loops_inside_match_and_with_are_found(self):
        fns = shape("""
            cmd = ["go", 3]
            match cmd:
                case ["go", n]:
                    for i in range(n):
                        pass
                case _:
                    pass
            with open("x") as f:
                for line in f:
                    pass
        """)
        b = bounds(fns["Global"])
        self.assertEqual(b[0]["sizes"], [{"name": "n"}])
        self.assertEqual(b[1]["sizes"], [{"name": "f", "len": True}])

    def test_bounds_it_cannot_work_out_say_so(self):
        fns = shape("""
            stack = [1, 2]
            total = 0
            while len(stack) > 0 and total < 10:
                total += stack.pop()
        """)
        self.assertEqual(bounds(fns["Global"])[0]["kind"], "unknown")


class OperationCostTests(unittest.TestCase):
    def test_copies_sorts_and_heap_operations(self):
        fns = shape("""
            import heapq, bisect
            h = []
            nums = [3, 1, 2]
            for v in nums:
                heapq.heappush(h, v)
                bisect.insort(h, v)
            c = nums.copy()
            d = list(nums)
            e = nums[:]
            nums.sort()
        """)
        costs = {op["what"]: op["cost"] for op in nodes(fns["Global"]["body"], "op")}
        self.assertEqual(costs["heappush()"], "log")
        self.assertEqual(costs["insort()"], "log")
        self.assertEqual(costs["nums.copy()"], "linear")
        self.assertEqual(costs["list() (copies)"], "linear")
        self.assertEqual(costs["nums[:] (copies)"], "linear")
        self.assertEqual(costs["nums.sort()"], "nlogn")
        grows = [a for a in nodes(fns["Global"]["body"], "alloc") if a.get("into") == "h"]
        self.assertEqual(len(grows), 2)  # each push adds to h


class RecursionTests(unittest.TestCase):
    def setUp(self):
        self.fns = shape("""
            from functools import lru_cache
            def bs(a, lo, hi, t):
                if lo > hi:
                    return -1
                mid = (lo + hi) // 2
                if a[mid] < t:
                    return bs(a, mid + 1, hi, t)
                return bs(a, lo, mid - 1, t)
            def tail(s):
                if not s:
                    return 0
                return 1 + tail(s[1:])
            @lru_cache(None)
            def fib(n):
                return n if n < 2 else fib(n - 1) + fib(n - 2)
            def walk(r, c):
                if r < 0:
                    return
                walk(r + 1, c)
                walk(r - 1, c)
            def same(n):
                return same(n)
        """)

    def shrinks(self, name):
        return [c["shrink"] for c in nodes(self.fns[name]["body"], "call") if c["callee"] == name]

    def test_binary_search_halves(self):
        self.assertEqual(self.shrinks("bs"), ["half", "half"])

    def test_slicing_off_one_shrinks_by_one(self):
        self.assertEqual(self.shrinks("tail"), ["minus"])

    def test_memoized_functions_are_marked(self):
        self.assertTrue(self.fns["fib"]["memo"])
        self.assertFalse(self.fns["tail"]["memo"])

    def test_moving_both_ways_is_a_search_not_a_shrink(self):
        self.assertEqual(self.shrinks("walk"), ["unknown", "unknown"])

    def test_calling_with_the_same_argument_never_shrinks(self):
        self.assertEqual(self.shrinks("same"), ["same"])


if __name__ == "__main__":
    unittest.main()
