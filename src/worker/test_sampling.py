"""Tests for sampling.py: which passes of long loops are recorded, driven by
hand (inside a real trace this code runs in the trace hook, where coverage
tools can't see it). Run with: npm run test:tracer
"""

import ast
import sys
import unittest

from analysis import USER_FILENAME
from policy import load_policy
from sampling import RECORD, LoopLengths, Sampler, round_pass, user_frames
from steplog import StepLog

POLICY = load_policy()["sampling"]
SAMPLE_FIRST, SAMPLE_LAST = POLICY["first"], POLICY["last"]

LOOP = {"id": "L2", "line": 2, "bodyStart": 3, "bodyEnd": 4}


def run_user(source, **names):
    """Run source as the program's own code; returns the frames that called capture()."""
    frames = []
    names["capture"] = lambda: frames.append(sys._getframe(1))
    exec(compile(source, USER_FILENAME, "exec"), names)
    return frames


def library(fn):
    """A function in library code, between two of the program's frames."""
    return fn()


def sampler(max_steps=1000, loops=(LOOP,)):
    log = StepLog(max_steps)
    s = Sampler(log, {}, POLICY)
    s.loops = list(loops)
    return s, log


def state(**kwargs):
    base = {"instance": 1, "iteration": 0, "total": None, "mode": None, "start": 0}
    base.update(kwargs)
    return base


class HelperTests(unittest.TestCase):
    def test_round_passes(self):
        self.assertEqual(
            [n for n in [5, 9, 10, 13, 20, 99, 100, 150, 200, 1000] if round_pass(n, POLICY)],
            [10, 20, 100, 200, 1000],
        )

    def test_user_frames_skip_library_code_in_between(self):
        (inner,) = run_user("def inner():\n    capture()\nlibrary(inner)\n", library=library)
        frames = user_frames(inner)
        self.assertEqual([f.f_code.co_name for f in frames], ["<module>", "inner"])
        self.assertEqual(user_frames(None), [])

    def test_loop_lengths_wrap_every_for_loops_iterable(self):
        tree = LoopLengths().visit(ast.parse("for x in xs:\n    for y in x:\n        pass\n"))
        self.assertEqual(
            ast.unparse(tree).splitlines()[:2], ["for x in __viz_len__(1, xs):", "    for y in __viz_len__(2, x):"]
        )


class LoopStatementTests(unittest.TestCase):
    def test_a_pass_starts_when_the_header_moves_into_the_body(self):
        s, _ = sampler()
        for line in (1, 2, 3, 4, 2, 3, 4, 2):
            s.update_loops("f1", line)
        self.assertEqual(s.active_loops["f1"]["L2"]["iteration"], 2)  # the last header check isn't a pass
        s.update_loops("f1", 5)
        self.assertNotIn("L2", s.active_loops["f1"])  # left the loop
        s.update_loops("f1", 2)
        self.assertEqual(s.active_loops["f1"]["L2"]["instance"], 2)  # running it again

    def test_a_loop_learns_its_length_as_it_starts(self):
        s, _ = sampler(loops=[{"id": "L7", "line": 7, "bodyStart": 8, "bodyEnd": 8}])
        s.frame_ids[id(sys._getframe())] = "f1"
        s.active_loops["f1"] = {"L7": state()}
        xs = range(4)
        self.assertIs(s.loop_length(7, xs), xs)
        self.assertEqual((s.active_loops["f1"]["L7"]["total"], s.active_loops["f1"]["L7"]["call"]), (4, "range(0, 4)"))
        gen = (x for x in [1])
        self.assertIs(s.loop_length(7, gen), gen)  # no length: nothing learned

    def test_each_running_loop_is_in_the_steps_context(self):
        s, _ = sampler()
        s.active_loops = {"f1": {"L2": state(iteration=3, call="range(0, 9)")}, "f2": {}}
        self.assertEqual(
            s.loop_context(["f1", "f2", "f3"]),
            [{"frame": "f1", "loop": "L2", "instance": 1, "iteration": 3, "call": "range(0, 9)"}],
        )


class DecisionTests(unittest.TestCase):
    """After its first passes, a loop is recorded in full, sampled, or watched."""

    def first_passes(self, s, log, total, per_pass):
        st = state(total=total, iteration=SAMPLE_FIRST + 1)
        log.considered = per_pass * SAMPLE_FIRST
        s.new_pass(st)
        return st

    def test_a_short_loop_is_recorded_in_full(self):
        s, log = sampler()
        st = self.first_passes(s, log, total=10, per_pass=6)
        self.assertEqual((st["mode"], st["keep"], s.sampled), ("full", True, False))

    def test_a_long_loop_of_known_length_is_sampled(self):
        s, log = sampler()
        st = self.first_passes(s, log, total=1000, per_pass=6)
        self.assertEqual((st["mode"], st["keep"], s.sampled), ("sampled", False, True))

    def test_a_loop_of_unknown_length_is_watched_until_it_spends_a_quarter_of_its_room(self):
        s, log = sampler()
        st = self.first_passes(s, log, total=None, per_pass=6)
        self.assertEqual(st["mode"], "watch")
        log.considered = 251
        st["iteration"] += 1
        s.new_pass(st)
        self.assertEqual(st["mode"], "sampled")

    def test_a_sampled_loop_keeps_its_ends_and_round_passes_while_they_fit(self):
        s, log = sampler()
        st = state(mode="sampled", total=1000, kept=6)
        log.considered = 60
        for it, keep in [(3, True), (996, True), (13, False), (20, True)]:
            st["iteration"] = it
            self.assertEqual(s.decide_keep(st, 1000), keep, it)
        log.considered = 700  # past its share of the budget
        st["iteration"] = 30
        self.assertFalse(s.decide_keep(st, 1000))

    def test_keep_pass(self):
        self.assertTrue(Sampler.keep_pass(state(mode="full")))
        self.assertTrue(Sampler.keep_pass(state(mode="sampled", keep=True)))
        self.assertFalse(Sampler.keep_pass(state(mode="sampled", keep=False)))


class PlacementTests(unittest.TestCase):
    def setUp(self):
        (self.frame,) = run_user("x = 1\ncapture()\n")
        self.s, self.log = sampler()
        self.s.frame_ids[id(self.frame)] = "f1"

    def test_everything_is_recorded_until_a_loop_is_sampled(self):
        self.assertEqual(self.s.place(self.frame, "f1", "return", None), RECORD)

    def test_the_middle_of_a_sampled_loop_of_known_length_is_counted_not_recorded(self):
        self.s.sampled = True
        self.s.active_loops["f1"] = {"L2": state(mode="sampled", keep=False, total=500)}
        self.assertIsNone(self.s.place(self.frame, "f1", "return", None))
        self.assertEqual(self.log.skipped, 1)

    def test_passes_of_a_loop_of_unknown_length_wait_in_a_buffer_until_it_ends(self):
        s = self.s
        s.sampled = True
        loop = state(mode="sampled", keep=False, iteration=40)
        s.active_loops["f1"] = {"L2": loop}
        into = s.place(self.frame, "f1", "return", None)
        self.assertIsInstance(into, list)
        assert isinstance(into, list)
        into.append({"heap": {}, "event": "line"})
        loop["keep"] = True  # a round pass while buffering: pinned into the buffer, in order
        pinned = s.place(self.frame, "f1", "return", None)
        self.assertIs(pinned, into)
        del s.active_loops["f1"]["L2"]  # the loop ended: the buffer is saved
        self.assertEqual(s.place(self.frame, "f1", "return", None), RECORD)
        self.assertEqual(len(self.log.steps), 1)
        self.assertIsNone(s.tail)

    def test_the_buffer_keeps_the_last_passes_and_counts_the_rest(self):
        s, log = self.s, self.log
        loop = state(mode="sampled", keep=False)
        for it in range(1, SAMPLE_LAST + 4):
            loop["iteration"] = it
            into = s.buffer(loop, pinned=(it == 2))
            assert into is not None
            into.extend({"heap": {}, "event": "line"} for _ in range(2))  # two steps a pass
        # Pass 1 fell out (2 steps counted, not recorded); pass 2 was pinned, so it
        # was saved, saying 2 were skipped before it; then pass 3 fell out.
        self.assertEqual([step.get("skipped") for step in log.steps], [2, None])
        self.assertEqual(log.skipped, 2)
        assert s.tail is not None
        self.assertEqual([it for it, _steps, _pinned in s.tail["passes"]], list(range(4, SAMPLE_LAST + 4)))

    def test_another_loop_saves_the_buffer_first(self):
        s, log = self.s, self.log
        first, second = state(iteration=1), state(iteration=1)
        into = s.buffer(first)
        assert into is not None
        into.append({"heap": {}, "event": "line"})
        s.buffer(second)
        self.assertEqual(len(log.steps), 1)
        assert s.tail is not None
        self.assertIs(s.tail["state"], second)

    def test_one_enormous_pass_keeps_only_its_start(self):
        s, log = sampler(max_steps=8)
        loop = state(iteration=1)
        into = s.buffer(loop)
        assert into is not None
        into.extend({"heap": {}} for _ in range(3))  # more than a quarter of the budget
        self.assertIsNone(s.buffer(loop))
        self.assertEqual(log.skipped, 1)


class RepeatTests(unittest.TestCase):
    """Loops that aren't loop statements: a line running again and again, a function called again and again."""

    def test_a_line_running_again_counts_its_passes(self):
        (frame,) = run_user("capture()\n")
        s, _ = sampler()
        for _ in range(3):
            s.track_repeats(frame, "f1", "line", frame.f_lineno)
        self.assertEqual(s.repeats["f1"]["state"]["iteration"], 2)  # the first time isn't a repeat
        self.assertTrue(s.repeats["f1"]["state"]["pseudo"])

    def test_a_function_called_again_from_one_line_is_a_run_of_calls(self):
        frames = run_user("def cb():\n    capture()\nfor _ in range(3):\n    cb()\n")
        s, _ = sampler()
        s.frame_ids[id(frames[0].f_back)] = "f1"
        for i, frame in enumerate(frames):
            s.track_repeats(frame, "f%d" % (i + 2), "call", None)
        assert s.callbacks is not None
        self.assertEqual(s.callbacks["state"]["iteration"], 3)
        self.assertIs(s.callback_of["f4"], s.callbacks["state"])
        s.left("f4")
        self.assertNotIn("f4", s.callback_of)
        # The caller moving to another line ends the run.
        (elsewhere,) = run_user("\n\n\n\n\ncapture()\n")
        self.assertNotEqual(elsewhere.f_lineno, s.callbacks["line"])
        s.repeated_line(elsewhere, "f1", None)
        self.assertIsNone(s.callbacks)

    def test_a_call_from_library_code_only_is_no_run(self):
        frames = []
        frame = sys._getframe()  # the test's own frame: no program frame above it
        s, _ = sampler()
        s.track_repeats(frame, "f9", "call", None)
        self.assertIsNone(s.callbacks)
        self.assertEqual(frames, [])

    def test_runs_and_repeats_count_as_loops_on_the_stack(self):
        (frame,) = run_user("capture()\n")
        s, _ = sampler()
        s.frame_ids[id(frame)] = "f1"
        run = state(iteration=2, pseudo=True)
        s.callback_of["f1"] = run
        s.repeats["f1"] = {"line": frame.f_lineno, "state": state(iteration=4, pseudo=True)}
        s.active_loops["f1"] = {"L2": state(iteration=1)}
        self.assertEqual([st["iteration"] for st in s.active_states(frame)], [2, 1, 4])


if __name__ == "__main__":
    unittest.main()
