"""Tests for steplog.py: where recorded steps go. Run with: npm run test:tracer"""

import unittest

from steplog import StepLog


def step(heap):
    return {"event": "line", "heap": dict(heap)}


class StepLogTests(unittest.TestCase):
    def test_each_step_sends_only_what_changed_and_every_id_in_order(self):
        log = StepLog(10)
        a, b = {"kind": "list", "items": []}, {"kind": "dict", "entries": []}
        log.commit(step({"o1": a}))
        log.commit(step({"o1": a, "o2": b}))
        log.commit(step({"o2": b, "o1": {"kind": "list", "items": [1]}}))
        self.assertEqual([s["heap"] for s in log.steps], [{"o1": a}, {"o2": b}, {"o1": {"kind": "list", "items": [1]}}])
        self.assertEqual([s["heapIds"] for s in log.steps], [["o1"], ["o1", "o2"], ["o2", "o1"]])

    def test_the_next_step_says_how_many_werent_recorded(self):
        log = StepLog(10)
        log.commit(step({}))
        log.skip(3)
        log.skip()
        log.commit(step({}))
        log.commit(step({}))
        self.assertEqual([s.get("skipped") for s in log.steps], [None, 4, None])

    def test_skips_after_the_last_step_are_noted_on_it(self):
        log = StepLog(10)
        log.commit(step({}))
        log.skip(7)
        log.finish()
        self.assertEqual(log.steps[-1]["skippedAfter"], 7)
        empty = StepLog(10)
        empty.skip(2)
        empty.finish()  # no steps to note it on
        self.assertEqual(empty.steps, [])

    def test_full_at_the_budget(self):
        log = StepLog(2)
        log.commit(step({}))
        self.assertFalse(log.full())
        log.commit(step({}))
        self.assertTrue(log.full())


if __name__ == "__main__":
    unittest.main()
