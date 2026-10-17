"""Tests for tracer.py. Run with: npm run test:tracer"""

import json
import sys
import textwrap
import unittest

import tracer as T
from tracer import run_trace


def expand_heaps(t):
    """Rebuild full heaps from deltas, as trace/delta.ts does."""
    prev = {}
    for step in t["steps"]:
        ids = step.pop("heapIds", None)
        if ids is not None:
            step["heap"] = {oid: step["heap"].get(oid, prev.get(oid)) for oid in ids}
        prev = step["heap"]
    t.pop("heapDelta", None)
    return t


def trace(source, max_steps=2000, max_seconds=6.0):
    return expand_heaps(json.loads(run_trace(textwrap.dedent(source), max_steps, max_seconds)))


def capture(source, **names):
    """Run source as the program's own code; returns the frames that called capture()."""
    frames = []
    names["capture"] = lambda: frames.append(sys._getframe(1))
    exec(compile(textwrap.dedent(source), T.USER_FILENAME, "exec"), names)
    return frames


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

    def test_long_containers_show_a_window_of_their_items(self):
        # A deque can't be sliced: this used to stop the program with a TypeError.
        t = trace("""
            from collections import deque
            q = deque(range(100))
            q.rotate(5)
            nums = list(range(100))
        """)
        self.assertIsNone(t["error"])
        heap = t["steps"][-1]["heap"]
        for name, first in (("q", "95"), ("nums", "0")):
            obj = heap[last_locals(t)[name]["id"]]
            self.assertEqual(obj["length"], 100)
            self.assertEqual(len(obj["items"]), 60)
            self.assertEqual(obj["items"][0]["repr"], first)

    def test_sizes_are_recorded_as_on_a_64_bit_python(self):
        t = trace("""
            nums = []
            for i in range(5):
                nums.append(i)
            point = (1, 2)
            word = "hi"
            big = 2 ** 70
        """)
        heap = t["steps"][-1]["heap"]
        local = last_locals(t)
        nums = heap[local["nums"]["id"]]
        # A list is 56 bytes plus 8 per slot it has room for.
        self.assertEqual(nums["size"], 56 + 8 * nums["capacity"])
        self.assertGreaterEqual(nums["capacity"], 5)
        self.assertEqual(heap[local["point"]["id"]]["size"], 40 + 8 * 2)
        self.assertEqual(local["word"]["size"], 41 + 2)  # an ASCII string: 41 + one byte a character
        self.assertEqual(local["big"]["size"], 36)
        self.assertNotIn("size", local["nums"])  # references carry no size; the object does

    def test_list_capacity_grows_ahead_of_length(self):
        t = trace("""
            nums = []
            for i in range(9):
                nums.append(i)
        """)
        caps = []
        for step in t["steps"]:
            for name, value in step["stack"][-1]["locals"]:
                if name == "nums":
                    cap = step["heap"][value["id"]]["capacity"]
                    if not caps or caps[-1] != cap:
                        caps.append(cap)
        self.assertEqual(caps, sorted(caps))
        self.assertGreater(len(caps), 2)  # it grew in jumps, not one slot at a time

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

    def test_asyncio_runs_on_a_virtual_clock(self):
        import time

        started = time.monotonic()
        t = trace("""
            import asyncio
            order = []
            async def nap(name, seconds):
                await asyncio.sleep(seconds)
                order.append(name)
            async def main():
                await asyncio.gather(nap("slow", 3), nap("fast", 1), nap("middle", 2))
                print(order)
            asyncio.run(main())
        """)
        self.assertIsNone(t["error"])
        self.assertEqual(t["stdout"], "['fast', 'middle', 'slow']\n")
        self.assertLess(time.monotonic() - started, 1.5)  # six seconds of sleeps, no real waiting
        self.assertTrue(any(f["func"] == "nap" for s in t["steps"] for f in s.get("suspended", [])))

    def test_asyncio_deadlock_is_reported_not_hung(self):
        t = trace("""
            import asyncio
            async def main():
                await asyncio.get_running_loop().create_future()
            asyncio.run(main())
        """)
        self.assertEqual(t["error"]["type"], "RuntimeError")
        self.assertIn("nothing is scheduled", t["error"]["message"])

    def test_print_is_recorded_on_the_next_step_with_printed_objects(self):
        t = trace("""
            nums = [3, 1, 2]
            print("start")
            nums.sort()
            print("sorted:", nums, [9])
        """)
        outs = [(i, s["output"]) for i, s in enumerate(t["steps"]) if "output" in s]
        self.assertEqual([o["line"] for _, o in outs], [3, 5])  # the source starts with a blank line
        first, second = outs
        self.assertEqual(first[1]["refs"], [])
        nums_id = dict(t["steps"][-1]["stack"][0]["locals"])["nums"]["id"]
        self.assertEqual(second[1]["refs"], [nums_id])  # the temporary [9] isn't drawn, so it isn't listed
        before = t["steps"][second[0] - 1]["stdoutLength"]
        self.assertEqual(t["stdout"][before : t["steps"][second[0]]["stdoutLength"]], "sorted: [1, 2, 3] [9]\n")
        self.assertNotIn("print", dict(t["steps"][-1]["stack"][0]["locals"]))

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
        # The loop is sampled once it's clearly long, so it runs until the time
        # budget rather than filling the step budget.
        t = trace("while True:\n    pass\n", max_steps=200, max_seconds=0.5)
        self.assertTrue(t["truncated"])
        self.assertEqual(t["stoppedBy"], "time")
        self.assertLessEqual(len(t["steps"]), 200)
        self.assertGreater(t["counts"]["steps"], 1000)

    def test_step_limit_cannot_be_swallowed_by_except_exception(self):
        t = trace(
            """
            while True:
                try:
                    pass
                except Exception:
                    pass
        """,
            max_steps=100,
        )
        self.assertTrue(t["truncated"])

    def test_stdout_is_captured_per_step(self):
        t = trace("print('a')\nprint('b')\n")
        self.assertEqual(t["stdout"], "a\nb\n")
        self.assertEqual(t["steps"][-1]["stdoutLength"], 4)

    def test_input_explains_itself(self):
        t = trace("name = input()\n")
        self.assertIn("input()", t["error"]["message"])


def shape(source):
    """The cost tree's functions by name, from a traced program."""
    return {f["name"]: f for f in trace(source)["cost"]["functions"]}


def loops(nodes):
    for node in nodes:
        if node["kind"] == "loop":
            yield node
            yield from loops(node["body"])


class CostShapeTests(unittest.TestCase):
    def test_loop_bounds_come_from_the_code(self):
        fns = shape("""
            nums = [3, 1, 2]
            n = len(nums)
            for i in range(n):
                for j in range(i + 1, n):
                    pass
            lo, hi = 0, len(nums) - 1
            while lo <= hi:
                mid = (lo + hi) // 2
                lo = mid + 1
            queue = [1]
            while queue:
                queue.pop()
        """)
        bounds = [loop["bound"] for loop in loops(fns["Global"]["body"])]
        self.assertEqual([b["kind"] for b in bounds], ["size", "size", "log", "unknown"])
        self.assertEqual(bounds[0]["sizes"], [{"name": "nums", "len": True}])
        self.assertEqual(bounds[1]["sizes"], [{"name": "nums", "len": True}])  # range(i + 1, n) is still n
        self.assertEqual(bounds[2]["size"], {"name": "nums", "len": True})

    def test_walking_links_is_sized_by_the_structure(self):
        fns = shape("""
            class Node:
                def __init__(self, nxt=None):
                    self.next = nxt
            head = Node(Node(Node()))
            curr = head
            while curr:
                curr = curr.next
        """)
        loop = next(loops(fns["Global"]["body"]))
        self.assertEqual(loop["bound"]["sizes"], [{"name": "head", "len": True}])

    def test_recursive_calls_say_how_they_shrink(self):
        fns = shape("""
            def halves(items):
                if len(items) < 2:
                    return items
                mid = len(items) // 2
                return halves(items[:mid]) + halves(items[mid:])
            def count(n):
                return 0 if n == 0 else 1 + count(n - 1)
            def walk(node):
                if node:
                    walk(node.left)
            seen = set()
            def fill(r, c):
                if r < 0 or r > 3 or r in seen:
                    return
                seen.add(r)
                fill(r + 1, c)
                fill(r - 1, c)
            halves([3, 1, 2]); count(3); walk(None); fill(0, 0)
        """)

        def shrinks(name):
            return [n["shrink"] for n in fns[name]["body"] if n["kind"] == "call" and n["callee"] == name]

        self.assertEqual(shrinks("halves"), ["half", "half"])
        self.assertEqual(shrinks("count"), ["minus"])
        self.assertEqual(shrinks("walk"), ["child"])
        self.assertEqual(shrinks("fill"), ["unknown", "unknown"])  # moves both ways: a search

    def test_memoized_functions_are_recognized(self):
        fns = shape("""
            memo = {}
            def fib(n):
                if n in memo:
                    return memo[n]
                memo[n] = n if n < 2 else fib(n - 1) + fib(n - 2)
                return memo[n]
            def plain(n):
                return n if n < 2 else plain(n - 1) + plain(n - 2)
            fib(5); plain(5)
        """)
        self.assertTrue(fns["fib"]["memo"])
        self.assertFalse(fns["plain"]["memo"])

    def test_a_shape_the_analysis_cant_read_never_stops_the_run(self):
        t = trace("x = [i async for i in range(3)] if False else 1")
        self.assertNotIn("Traceback", json.dumps(t))


def passes(t, loop_line):
    """The iterations recorded for the loop on loop_line (its first instance)."""
    seen = []
    for step in t["steps"]:
        for ctx in step["loops"]:
            if ctx["loop"] == "L%d" % loop_line and ctx["instance"] == 1 and ctx["iteration"] not in seen:
                seen.append(ctx["iteration"])
    return seen


class SamplingTests(unittest.TestCase):
    def test_a_short_loop_is_recorded_in_full(self):
        t = trace(
            """\
            total = 0
            for i in range(30):
                total += i
        """,
            3000,
        )
        self.assertFalse(t.get("sampled"))
        self.assertEqual(passes(t, 2), list(range(31)))

    def test_a_long_for_loop_keeps_its_first_round_and_last_passes(self):
        t = trace(
            """\
            total = 0
            for i in range(40000):
                total += i
            print(total)
        """,
            3000,
        )
        self.assertFalse(t["truncated"])
        self.assertTrue(t["sampled"])
        self.assertEqual(t["stdout"], "799980000\n")
        seen = passes(t, 2)
        for n in [1, 2, 3, 4, 5, 10, 50, 100, 900, 1000, 30000, 39996, 40000]:
            self.assertIn(n, seen)
        self.assertNotIn(6, seen)
        self.assertNotIn(1234, seen)
        self.assertTrue(any(s.get("skipped") for s in t["steps"]))
        self.assertGreater(t["counts"]["steps"], 80000)  # counted, recorded or not
        # Every skipped event is accounted for.
        recorded = len(t["steps"])
        skipped = sum(s.get("skipped", 0) for s in t["steps"]) + t["steps"][-1].get("skippedAfter", 0)
        self.assertEqual(recorded + skipped, t["counts"]["steps"])

    def test_a_long_while_loop_keeps_its_last_passes(self):
        t = trace(
            """\
            n = 0
            while n < 20000:
                n += 1
            done = n
        """,
            3000,
        )
        self.assertFalse(t["truncated"])
        seen = passes(t, 2)
        self.assertIn(20000, seen)
        self.assertIn(19996, seen)
        self.assertNotIn(19990 - 1, seen)
        self.assertEqual(last_locals(t)["done"]["repr"], "20000")

    def test_a_function_called_many_times_from_one_line_is_sampled(self):
        t = trace(
            """\
            def double(x):
                return x * 2
            nums = list(map(double, range(40000)))
        """,
            3000,
        )
        self.assertFalse(t["truncated"])
        self.assertTrue(t["sampled"])
        self.assertEqual(t["counts"]["calls"]["double"], 40000)
        self.assertLess(len(t["steps"]), 1500)

    def test_a_comprehension_is_sampled(self):
        t = trace("nums = [i * 2 for i in range(40000)]\n", 3000)
        self.assertFalse(t["truncated"])
        self.assertEqual(last_locals(t)["nums"]["kind"], "ref")

    def test_counts_hold_calls_and_recursion_depth(self):
        t = trace("""\
            def fact(n):
                return 1 if n <= 1 else n * fact(n - 1)
            fact(30)
        """)
        self.assertEqual(t["counts"]["calls"]["fact"], 30)
        self.assertEqual(t["counts"]["depth"]["fact"], 30)


class LoopHeaderTests(unittest.TestCase):
    def test_each_run_of_a_range_loop_carries_its_range(self):
        t = trace("""\
            n = 4
            for i in range(n):
                for j in range(n - 1 - i):
                    pass
            for x in [1, 2]:
                pass
        """)
        calls = {
            (c["loop"], c["instance"]): c.get("call") for s in t["steps"] for c in s["loops"] if c["iteration"] > 0
        }
        self.assertEqual(calls[("L2", 1)], "range(0, 4)")
        self.assertEqual(calls[("L3", 1)], "range(0, 3)")
        self.assertEqual(calls[("L3", 2)], "range(0, 2)")
        self.assertIsNone(calls[("L5", 1)])  # not a range


class LongListTests(unittest.TestCase):
    def test_the_window_follows_the_index_variables(self):
        t = trace(
            """\
            nums = list(range(1000))
            for j in range(990, 400, -1):
                nums[j] = nums[j - 1]
        """,
            3000,
        )
        windows = {o.get("offset", 0) for s in t["steps"] for o in s["heap"].values() if o["kind"] == "list"}
        self.assertIn(940, windows)  # j near 990: the last 60 items
        self.assertTrue(any(400 <= w <= 420 for w in windows))
        last = [o for o in t["steps"][-1]["heap"].values() if o["kind"] == "list"][0]
        self.assertEqual(len(last["items"]), 60)

    def test_a_long_list_of_numbers_has_a_strip_of_all_of_it(self):
        t = trace("nums = list(range(40000))\n")
        lst = [o for o in t["steps"][-1]["heap"].values() if o["kind"] == "list"][0]
        self.assertEqual(len(lst["strip"]["values"]), 256)
        self.assertEqual(lst["strip"]["values"][128], 20000)
        self.assertEqual(lst["strip"]["min"], 0)
        self.assertNotIn("offset", lst)  # no index variables: the start

    def test_no_strip_for_short_lists_or_non_numbers(self):
        t = trace("short = [1, 2, 3]\nwords = ['a'] * 100\n")
        for o in t["steps"][-1]["heap"].values():
            self.assertNotIn("strip", o)


class HookTests(unittest.TestCase):
    """The tracer's hooks called directly, on frames of the program's own code.

    Inside a real trace they run in the trace hook, where coverage tools can't
    see them; the end-to-end tests above check what they add up to.
    """

    def test_events_in_the_programs_terms(self):
        frames = capture("def f():\n    capture()\nf()\n")
        tracer = T.Tracer("", 100)
        frame = frames[0]
        self.assertEqual(tracer.classify(frame, "f1", "line", None), "line")
        tracer.suspended["f1"] = frame
        self.assertEqual(tracer.classify(frame, "f1", "call", None), "resume")
        self.assertNotIn("f1", tracer.suspended)
        # An exception leaving a frame: its "return" is the frame unwinding.
        self.assertEqual(tracer.classify(frame, "f1", "exception", (ValueError, ValueError(), None)), "exception")
        self.assertIn("f1", tracer.unwinding)
        self.assertEqual(tracer.classify(frame, "f1", "return", None), "return")
        self.assertNotIn("f1", tracer.unwinding)
        tracer.classify(frame, "f1", "exception", (ValueError, ValueError(), None))
        tracer.classify(frame, "f1", "line", None)  # caught
        self.assertNotIn("f1", tracer.unwinding)

    def test_a_generator_pausing_is_a_yield_and_a_coroutine_an_await(self):
        names = {}
        exec(
            compile(
                textwrap.dedent("""
                    import types
                    def gen():
                        yield 1
                    @types.coroutine
                    def pause():
                        yield
                    async def task():
                        await pause()
                    g = gen()
                    next(g)
                    c = task()
                    c.send(None)
                """),
                T.USER_FILENAME,
                "exec",
            ),
            names,
        )
        tracer = T.Tracer("", 100)
        self.assertEqual(tracer.returned(names["g"].gi_frame, "f1", 1), "yield")
        self.assertEqual(tracer.returned(names["c"].cr_frame, "f2", None), "await")
        self.assertEqual(set(tracer.suspended), {"f1", "f2"})
        names["c"].close()

    def test_an_async_generator_awaits_unless_it_hands_over_a_value(self):
        async def stream():
            yield 1

        code = stream.__code__
        self.assertEqual(T.Tracer.pause_kind(code, None), "await")
        self.assertEqual(T.Tracer.pause_kind(code, 5), "yield")

    def test_calls_are_counted_with_their_deepest_recursion(self):
        (frame,) = capture("def f(n):\n    if n == 0:\n        capture()\n    else:\n        f(n - 1)\nf(2)\n")
        tracer = T.Tracer("", 100)
        tracer.count(frame, "call")
        tracer.count(frame, "line")
        self.assertEqual(tracer.counts, {"steps": 2, "calls": {"f": 1}, "depth": {"f": 3}})

    def test_the_clock_is_checked_every_so_often(self):
        tracer = T.Tracer("", 100)
        tracer.deadline = 0  # long past
        tracer.tick = 2
        tracer.check_clock()  # not yet
        with self.assertRaises(T.StepLimitExceeded):
            tracer.check_clock()
        self.assertEqual(tracer.stopped_by, "time")
        tracer.deadline = None
        tracer.tick = 1
        tracer.check_clock()  # no deadline: never stops

    def test_a_step_is_the_stack_the_heap_and_the_output_so_far(self):
        (frame,) = capture("nums = [1, 2]\nprint('hi')\ncapture()\n", print=lambda *a: None)
        tracer = T.Tracer("", 100)
        into = []
        tracer.record(frame, "line", None, into=into)
        (step,) = into
        self.assertEqual(step["stack"][0]["func"], "Global")
        names = [name for name, _value in step["stack"][0]["locals"]]
        self.assertIn("nums", names)
        self.assertNotIn("print", names)  # the tracer's own print isn't the program's
        self.assertNotIn("__builtins__", names)
        nums = dict(step["stack"][0]["locals"])["nums"]
        self.assertEqual(step["heap"][nums["id"]]["kind"], "list")
        self.assertEqual(tracer.log.considered, 1)
        self.assertEqual(tracer.steps, [])  # buffered, not committed

    def test_the_step_budget_stops_the_run(self):
        (frame,) = capture("capture()\n")
        tracer = T.Tracer("", 1)
        tracer.record(frame, "line", None)
        with self.assertRaises(T.StepLimitExceeded):
            tracer.record(frame, "line", None)
        self.assertEqual(tracer.stopped_by, "steps")

    def test_printed_objects_are_pointed_at_on_the_next_step(self):
        (frame,) = capture("box = [1]\ncapture()\n")
        tracer = T.Tracer("", 100)
        box = frame.f_locals["box"]
        tracer.pending_print = {"line": 1, "objects": [box, box, object()]}
        tracer.record(frame, "line", None)
        self.assertEqual(tracer.steps[0]["output"], {"line": 1, "refs": [tracer.object_ids[id(box)]]})
        self.assertIsNone(tracer.pending_print)

    def test_long_lists_follow_the_names_that_index_them(self):
        (frame,) = capture("nums = list(range(100))\ni = 50\nlo = 3\nshort = [1]\nj = 0\ncapture()\n")
        tracer = T.Tracer("", 100)
        self.assertEqual(tracer.focus_of([frame]), {})  # no index names known
        tracer.index_names = {"nums": ["i"], "short": ["j"]}
        focus = tracer.focus_of([frame])
        self.assertEqual(sorted(focus[id(frame.f_locals["nums"])]), [3, 50])  # i, and lo by convention
        self.assertEqual(T.Tracer.indices_into([0] * 100, ["k"], {"k": 500}), [])  # out of range
        self.assertEqual(T.Tracer.indices_into([0] * 100, None, {}), [])

    def test_pointer_hints_add_index_names(self):
        hints = [{"line": 1, "text": "pointers nums: lo, hi"}, {"line": 2, "text": "hide x"}]
        self.assertEqual(T.with_pointer_hints({"nums": ["i"]}, hints), {"nums": ["hi", "i", "lo"]})

    def test_prepare_reads_the_program_or_reports_why_it_cant(self):
        tracer = T.Tracer("for i in range(3):\n    pass  # viz: hide i\n", 100)
        result = {"indexNames": {}, "loops": []}
        self.assertIsNotNone(tracer.prepare(result))
        self.assertEqual([loop["id"] for loop in result["loops"]], ["L1"])
        self.assertEqual(result["hints"], [{"line": 2, "text": "hide i"}])
        self.assertIn("cost", result)
        broken = {"indexNames": {}, "loops": []}
        self.assertIsNone(T.Tracer("x = (", 100).prepare(broken))
        self.assertEqual(broken["error"]["type"], "SyntaxError")

    def test_an_error_is_reported_at_the_programs_own_line(self):
        try:
            exec(compile("def f():\n    return [][0]\nf()\n", T.USER_FILENAME, "exec"), {})
        except IndexError as exc:
            self.assertEqual(T.last_user_line(exc.__traceback__), 2)
        self.assertIsNone(T.last_user_line(None))


if __name__ == "__main__":
    unittest.main()
