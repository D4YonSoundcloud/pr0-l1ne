"""Tests for tracer.py. Run with: npm run test:tracer"""

import json
import textwrap
import unittest

from tracer import run_trace


def trace(source, max_steps=2000):
    return json.loads(run_trace(textwrap.dedent(source), max_steps))


def last_locals(t):
    return dict(t["steps"][-1]["stack"][-1]["locals"])


class TracerTests(unittest.TestCase):
    def test_list_is_a_heap_object(self):
        t = trace("arr = [3, 'a', None]\n")
        ref = last_locals(t)["arr"]
        self.assertEqual(ref["kind"], "ref")
        obj = t["steps"][-1]["heap"][ref["id"]]
        self.assertEqual(obj["kind"], "list")
        self.assertEqual([v["repr"] for v in obj["items"]], ["3", "'a'", "None"])

    def test_object_ids_are_stable_across_steps(self):
        t = trace("arr = [1]\narr.append(2)\narr.append(3)\n")
        ids = {dict(s["stack"][-1]["locals"])["arr"]["id"] for s in t["steps"] if s["stack"][-1]["locals"]}
        self.assertEqual(len(ids), 1)

    def test_object_ids_are_the_same_on_every_run(self):
        source = "a = [1]\nb = {'k': a}\nc = [a, b]\n"
        first = trace(source)["steps"][-1]["heap"]
        second = trace(source)["steps"][-1]["heap"]
        self.assertEqual(sorted(first), sorted(second))
        self.assertEqual(sorted(first), ["o1", "o2", "o3"])

    def test_for_loop_iterations_are_counted(self):
        t = trace("""
            total = 0
            for x in [5, 6, 7]:
                total += x
        """)
        iterations = {s["loops"][0]["iteration"] for s in t["steps"] if s["loops"]}
        self.assertEqual(iterations, {0, 1, 2, 3})

    def test_while_loop_iterations_are_counted(self):
        t = trace("""
            n = 0
            while n < 4:
                n += 1
        """)
        self.assertEqual(max(s["loops"][0]["iteration"] for s in t["steps"] if s["loops"]), 4)

    def test_inner_loop_gets_a_new_instance_per_outer_iteration(self):
        t = trace("""
            for i in range(3):
                for j in range(2):
                    pass
        """)
        inner = {ctx["instance"] for s in t["steps"] for ctx in s["loops"] if ctx["loop"] == "L3"}
        self.assertEqual(inner, {1, 2, 3})

    def test_index_names_come_from_subscripts(self):
        t = trace("""
            arr = [1, 2, 3]
            i = 0
            arr[i + 1] = arr[i]
        """)
        self.assertEqual(t["indexNames"], {"arr": ["i"]})

    def test_nested_index_names_are_recorded_per_level(self):
        t = trace("""
            grid = [[1, 2], [3, 4]]
            i, j = 1, 0
            grid[i][j] = grid[j][i + 1]
        """)
        self.assertEqual(t["indexNames"], {"grid": ["i", "j"], "grid[]": ["i", "j"]})
        t = trace("g = [[0]]\nr = 0\nc = 0\ng[r][c] += 1\n")
        self.assertEqual(t["indexNames"], {"g": ["r"], "g[]": ["c"]})

    def test_generator_yields_pause_and_resume(self):
        t = trace("""
            def countdown(n):
                while n > 0:
                    yield n
                    n -= 1
            g = countdown(2)
            a = next(g)
            b = next(g)
        """)
        events = [s["event"] for s in t["steps"]]
        self.assertIn("yield", events)
        self.assertIn("resume", events)
        yields = [s["returnValue"]["repr"] for s in t["steps"] if s["event"] == "yield"]
        self.assertEqual(yields, ["2", "1"])
        between = next(s for s in t["steps"] if s["event"] == "line" and s["line"] == 8)
        self.assertEqual([f["func"] for f in between["stack"]], ["Global"])
        self.assertEqual([f["func"] for f in between["suspended"]], ["countdown"])
        self.assertEqual(between["suspended"][0]["state"], "suspended")

    def test_dropped_generator_is_closed_not_left_suspended(self):
        t = trace("""
            def gen():
                yield 1
                yield 2
            g = gen()
            next(g)
            g = None
            done = True
        """)
        self.assertIsNone(t["error"])
        self.assertEqual(t["steps"][-1].get("suspended", []), [])

    def test_asyncio_coroutines_await_and_resume(self):
        t = trace("""
            import asyncio
            async def double(x):
                await asyncio.sleep(0)
                return x * 2
            async def main():
                return await double(21)
            result = asyncio.run(main())
        """)
        self.assertIsNone(t["error"])
        events = [s["event"] for s in t["steps"]]
        self.assertIn("await", events)
        self.assertIn("resume", events)
        # await plumbing (internal StopIteration) isn't shown as an exception
        self.assertNotIn("exception", events)
        resumed = next(s for s in t["steps"] if s["event"] == "resume")
        self.assertEqual(resumed["stack"][0]["func"], "Global")
        last_locals = dict(t["steps"][-1]["stack"][0]["locals"])
        self.assertEqual(last_locals["result"]["repr"], "42")

    def test_recursion_shows_one_frame_per_call(self):
        t = trace("""
            def f(n):
                return 1 if n <= 1 else n * f(n - 1)
            f(3)
        """)
        self.assertEqual(max(len(s["stack"]) for s in t["steps"]), 4)  # Global + 3 calls

    def test_closures_show_captured_variables(self):
        t = trace("""
            def outer():
                count = 7
                def inner():
                    return count
                return inner
            fn = outer()
        """)
        obj = t["steps"][-1]["heap"][last_locals(t)["fn"]["id"]]
        self.assertEqual(obj["kind"], "function")
        self.assertEqual(obj["fields"][0][0], "count")

    def test_syntax_error_has_line_and_no_steps(self):
        t = trace("x = 1\ny = (\n")
        self.assertEqual(t["steps"], [])
        self.assertEqual(t["error"]["type"], "SyntaxError")

    def test_runtime_error_is_reported_with_line(self):
        t = trace("a = []\nb = a[3]\n")
        self.assertEqual(t["error"]["type"], "IndexError")
        self.assertEqual(t["error"]["line"], 2)

    def test_infinite_loop_hits_step_limit(self):
        t = trace("while True:\n    pass\n", max_steps=200)
        self.assertTrue(t["truncated"])
        self.assertEqual(len(t["steps"]), 200)

    def test_step_limit_cannot_be_swallowed_by_except_exception(self):
        t = trace("""
            while True:
                try:
                    pass
                except Exception:
                    pass
        """, max_steps=100)
        self.assertTrue(t["truncated"])

    def test_stdout_is_captured_per_step(self):
        t = trace("print('a')\nprint('b')\n")
        self.assertEqual(t["stdout"], "a\nb\n")
        self.assertEqual(t["steps"][-1]["stdoutLength"], 4)

    def test_input_explains_itself(self):
        t = trace("name = input()\n")
        self.assertIn("input()", t["error"]["message"])


if __name__ == "__main__":
    unittest.main()
