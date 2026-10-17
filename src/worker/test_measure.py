"""Tests for measure.py: python3 -m unittest discover -s src/worker"""

import json
import textwrap
import unittest
from unittest import mock

import measure as M
from measure import run_measure


def measure(source, limit_ms=10000):
    return json.loads(run_measure(textwrap.dedent(source), limit_ms))


class MeasureTests(unittest.TestCase):
    def test_counts_lines_and_loop_passes(self):
        r = measure("""
            total = 0
            for i in range(50):
                for j in range(i):
                    total += 1
            print(total)
        """)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["lines"]["5"], 50 * 49 // 2)
        self.assertEqual(r["passes"]["3"], 50)
        self.assertEqual(r["passes"]["4"], 50 * 49 // 2)
        self.assertEqual(r["totals"]["3"], 50)
        self.assertEqual(r["stdout"], "1225\n")
        self.assertIsNotNone(r["plainMs"])  # quick enough to time untouched

    def test_counts_calls_by_function(self):
        r = measure("""
            def fib(n):
                return n if n < 2 else fib(n - 1) + fib(n - 2)
            fib(15)
        """)
        self.assertEqual(r["calls"]["2"], 1973)

    def test_counts_work_hidden_inside_built_ins(self):
        r = measure("""
            nums = list(range(1000))
            for _ in range(10):
                nums.insert(0, nums.pop())
            found = 999 in nums
            seen = set(nums)
            hit = 999 in seen
            part = nums[:100]
            ordered = sorted(nums)
            d = {1: 2}
            d.pop(1)
        """)
        # insert(0) moves the whole list; it's measured as the line starts,
        # before its pop(), so it reads 1,000 rather than 999
        self.assertEqual(r["work"]["4"], 10 * 1000)
        self.assertEqual(r["workKind"]["4"], "m")
        self.assertEqual(r["work"]["5"], 1000)  # `in` on a list scans it
        self.assertNotIn("7", r["work"])  # `in` on a set doesn't
        self.assertEqual(r["work"]["8"], 100)  # a slice copies what it takes
        self.assertEqual(r["workKind"]["9"], "o")  # sorting
        self.assertNotIn("11", r["work"])  # dict.pop is a hash lookup

    def test_comprehensions_count_their_passes(self):
        r = measure("""
            squares = [x * x for x in range(30)]
        """)
        self.assertEqual(r["passes"]["2"], 30)

    def test_the_time_limit_stops_the_run_and_says_how_far_it_got(self):
        r = measure(
            """
            def spin(k):
                for _ in range(k):
                    x = 0
                    for j in range(100000):
                        x += j
            spin(1000000)
        """,
            limit_ms=600,
        )
        self.assertEqual(r["status"], "limit")
        loop = r["stoppedAt"]["loop"]
        self.assertEqual((loop["line"], loop["total"]), (3, 1000000))
        self.assertGreater(loop["done"], 0)
        self.assertLess(r["ms"], 3000)

    def test_recursion_without_loops_can_still_be_stopped(self):
        r = measure(
            """
            def fib(n):
                return n if n < 2 else fib(n - 1) + fib(n - 2)
            fib(60)
        """,
            limit_ms=500,
        )
        self.assertEqual(r["status"], "limit")

    def test_except_exception_cannot_swallow_the_limit(self):
        r = measure(
            """
            while True:
                try:
                    pass
                except Exception:
                    pass
        """,
            limit_ms=300,
        )
        self.assertEqual(r["status"], "limit")

    def test_errors_point_at_the_users_line(self):
        r = measure("""
            nums = [1, 2]
            print(nums[5])
        """)
        self.assertEqual(r["status"], "error")
        self.assertEqual(r["error"]["type"], "IndexError")
        self.assertEqual(r["error"]["line"], 3)

    def test_syntax_errors(self):
        r = measure("for i in range(3)\n    pass\n")
        self.assertEqual((r["status"], r["error"]["type"], r["error"]["line"]), ("error", "SyntaxError", 1))

    def test_memory_held_by_the_variables(self):
        r = measure("""
            nums = list(range(10000))
            copy = nums
        """)
        # a 64-bit list of 10,000 pointers, plus its ints (counted once, though two names share it)
        self.assertGreater(r["heldBytes"], 10000 * 8)
        self.assertLess(r["heldBytes"], 10000 * 8 + 10000 * 32 + 1000)

    def test_output_is_capped(self):
        r = measure("""
            for i in range(30000):
                print("x" * 9)
        """)
        self.assertEqual(len(r["stdout"]), 100000)
        self.assertEqual(r["droppedOutput"], 300000 - 100000)

    def test_asyncio_runs_on_the_virtual_clock(self):
        r = measure("""
            import asyncio
            async def nap(s):
                await asyncio.sleep(s)
                return s
            async def main():
                return await asyncio.gather(nap(3), nap(1))
            print(asyncio.run(main()))
        """)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["stdout"], "[3, 1]\n")
        self.assertLess(r["ms"], 1000)


class MoreMeasureTests(unittest.TestCase):
    def test_every_block_of_an_if_and_a_class_is_counted(self):
        r = measure("""
            for i in range(6):
                if i % 2:
                    a = 1
                elif i % 3:
                    b = 2
                else:
                    c = 3
            class Box:
                size = 4
        """)
        self.assertEqual((r["lines"]["4"], r["lines"]["6"], r["lines"]["8"]), (3, 2, 1))
        self.assertEqual(r["lines"]["10"], 1)

    def test_future_imports_stay_first(self):
        r = measure("""
            from __future__ import annotations
            x: list[int] = [1]
        """)
        self.assertEqual(r["status"], "done")
        self.assertNotIn("2", r["lines"])  # not counted: it must stay first in the file

    def test_more_work_inside_built_ins(self):
        r = measure("""
            class Stack:
                def __init__(self):
                    self.items = list(range(300))
            s = Stack()
            s.items.insert(0, -1)
            words = ["a"] * 50
            sep = ", "
            text = sep.join(words)
            more = []
            more.extend(words)
            s.items.sort()
            k = 10
            tail = s.items[-k:]
            n = sum(s.items)
        """)
        self.assertEqual(r["work"]["6"], 300)  # insert on an attribute's list
        self.assertEqual((r["work"]["9"], r["workKind"]["9"]), (50, "c"))  # join copies
        self.assertEqual(r["work"]["11"], 50)  # extend copies
        self.assertEqual(r["workKind"]["12"], "o")  # sort
        self.assertEqual(r["work"]["14"], 10)  # a slice with a computed bound
        self.assertEqual((r["work"]["15"], r["workKind"]["15"]), (301, "s"))  # sum scans

    def test_loops_over_things_without_a_length_still_count_their_passes(self):
        r = measure("""
            def gen():
                yield from range(5)
            for v in gen():
                pass
            squares = [x * x for x in gen()]
            async def f(xs):
                async for x in xs:
                    pass
        """)
        self.assertEqual(r["passes"]["4"], 5)
        self.assertNotIn("4", r["totals"])  # its length wasn't known as it started

    def test_growth_runs_set_the_sizes_at_the_top(self):
        source = """
            n = 1000
            k: int = 3
            name = "x"
            for i in range(n * k):
                pass
        """
        r = json.loads(run_measure(textwrap.dedent(source), 10000, None, json.dumps({"n": 10, "k": 2, "name": 5})))
        self.assertEqual(r["passes"]["5"], 20)  # n = 10, k = 2; name isn't a number, so it stays

    def test_progress_is_reported_while_it_runs(self):
        reports = []
        with mock.patch.object(M, "PROGRESS_EVERY", 0), mock.patch.object(M, "POLL_EVERY", 10):
            run_measure("for i in range(200):\n    pass\n", 10000, reports.append)
        self.assertTrue(reports)
        last = json.loads(reports[-1])
        self.assertIn("elapsedMs", last)
        self.assertEqual(last["loop"]["line"], 1)

    def test_input_explains_itself(self):
        r = measure("name = input()")
        self.assertEqual(r["error"]["type"], "RuntimeError")
        self.assertIn("input() isn't supported", r["error"]["message"])

    def test_memory_held_walks_objects_and_skips_what_it_cant_size(self):
        class Unsizable:
            def __sizeof__(self):
                raise TypeError("no size")

        class Point:
            def __init__(self):
                self.coords = [1, 2, 3]

        held = M.held_bytes(
            {"p": Point(), "s": {1, 2}, "d": {"k": [1]}, "u": Unsizable(), "_mc": [0] * 1000, "input": None}
        )
        self.assertGreater(held, 0)
        self.assertLess(held, M.held_bytes({"big": [0] * 1000}))  # the counters aren't the program's

    def test_a_program_that_fails_on_its_second_run_has_no_plain_time(self):
        import sys

        self.addCleanup(sys.modules.pop, "measure_runs", None)
        r = measure("""
            import sys
            runs = sys.modules.setdefault("measure_runs", type(sys)("measure_runs"))
            runs.n = getattr(runs, "n", 0) + 1
            if runs.n % 2 == 0:
                raise ValueError("second time")
        """)
        self.assertEqual(r["status"], "done")
        self.assertIsNone(r["plainMs"])


if __name__ == "__main__":
    unittest.main()
