"""Tests for tracer.py's hooks, called directly on frames of the program's own
code. Inside a real trace they run in the trace hook, where coverage tools
can't see them; test_tracer.py checks what they add up to, end to end.
Run with: npm run test:tracer
"""

import sys
import textwrap
import unittest

import tracer as T
from policy import load_policy

POLICY = load_policy()


def tracer_for(source, max_steps):
    """A Tracer with the app's time limit and sampling rules."""
    return T.Tracer(source, max_steps, POLICY["runSeconds"], POLICY["sampling"])


def capture(source, **names):
    """Run source as the program's own code; returns the frames that called capture()."""
    frames = []
    names["capture"] = lambda: frames.append(sys._getframe(1))
    exec(compile(textwrap.dedent(source), T.USER_FILENAME, "exec"), names)
    return frames


class HookTests(unittest.TestCase):
    """The tracer's hooks called directly, on frames of the program's own code.

    Inside a real trace they run in the trace hook, where coverage tools can't
    see them; the end-to-end tests above check what they add up to.
    """

    def test_events_in_the_programs_terms(self):
        frames = capture("def f():\n    capture()\nf()\n")
        tracer = tracer_for("", 100)
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
        tracer = tracer_for("", 100)
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
        tracer = tracer_for("", 100)
        tracer.count(frame, "call")
        tracer.count(frame, "line")
        self.assertEqual(tracer.counts, {"steps": 2, "calls": {"f": 1}, "depth": {"f": 3}})

    def test_the_clock_is_checked_every_so_often(self):
        tracer = tracer_for("", 100)
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
        tracer = tracer_for("", 100)
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
        tracer = tracer_for("", 1)
        tracer.record(frame, "line", None)
        with self.assertRaises(T.StepLimitExceeded):
            tracer.record(frame, "line", None)
        self.assertEqual(tracer.stopped_by, "steps")

    def test_printed_objects_are_pointed_at_on_the_next_step(self):
        (frame,) = capture("box = [1]\ncapture()\n")
        tracer = tracer_for("", 100)
        box = frame.f_locals["box"]
        tracer.pending_print = {"line": 1, "objects": [box, box, object()]}
        tracer.record(frame, "line", None)
        self.assertEqual(tracer.steps[0]["output"], {"line": 1, "refs": [tracer.object_ids[id(box)]]})
        self.assertIsNone(tracer.pending_print)

    def test_long_lists_follow_the_names_that_index_them(self):
        (frame,) = capture("nums = list(range(100))\ni = 50\nlo = 3\nshort = [1]\nj = 0\ncapture()\n")
        tracer = tracer_for("", 100)
        self.assertEqual(tracer.focus_of([frame]), {})  # no index names known
        tracer.index_names = {"nums": ["i"], "short": ["j"]}
        focus = tracer.focus_of([frame])
        self.assertEqual(sorted(focus[id(frame.f_locals["nums"])]), [3, 50])  # i, and lo by convention
        self.assertEqual(T.Tracer.indices_into([0] * 100, ["k"], {"k": 500}), [])  # out of range
        self.assertEqual(T.Tracer.indices_into([0] * 100, None, {}), [])

    def test_pointer_hints_add_index_names(self):
        hints = [{"line": 1, "text": "pointers nums: lo, hi"}, {"line": 2, "text": "hide x"}]
        self.assertEqual(T.with_pointer_hints({"nums": ["i"]}, hints), {"nums": ["hi", "i", "lo"]})

    def test_window_hints_add_the_ends_that_are_names(self):
        hints = [{"line": 1, "text": "window nums: [left, right]"}, {"line": 2, "text": "window s: [i, i + k)"}]
        self.assertEqual(T.with_pointer_hints({}, hints), {"nums": ["left", "right"], "s": ["i"]})

    def test_prepare_reads_the_program_or_reports_why_it_cant(self):
        tracer = tracer_for("for i in range(3):\n    pass  # viz: hide i\n", 100)
        result = {"indexNames": {}, "loops": []}
        self.assertIsNotNone(tracer.prepare(result))
        self.assertEqual([loop["id"] for loop in result["loops"]], ["L1"])
        self.assertEqual(result["hints"], [{"line": 2, "text": "hide i"}])
        self.assertIn("cost", result)
        broken = {"indexNames": {}, "loops": []}
        self.assertIsNone(tracer_for("x = (", 100).prepare(broken))
        self.assertEqual(broken["error"]["type"], "SyntaxError")

    def test_an_error_is_reported_at_the_programs_own_line(self):
        try:
            exec(compile("def f():\n    return [][0]\nf()\n", T.USER_FILENAME, "exec"), {})
        except IndexError as exc:
            self.assertEqual(T.last_user_line(exc.__traceback__), 2)
        self.assertIsNone(T.last_user_line(None))


if __name__ == "__main__":
    unittest.main()
