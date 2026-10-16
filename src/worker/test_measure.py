"""Tests for measure.py: python3 -m unittest discover -s src/worker"""

import json
import textwrap
import unittest

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


if __name__ == "__main__":
    unittest.main()
