"""Tests for steplog.py: where recorded steps go. Run with: npm run test:tracer"""

import unittest

from steplog import StepLog, ids_part


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


class DeltaTests(unittest.TestCase):
    def test_the_same_ids_in_the_same_order_are_sent_once(self):
        log = StepLog(10)
        a = {"kind": "list", "items": []}
        log.commit(step({"o1": a}))
        log.commit(step({"o1": a}))
        log.commit(step({"o1": {"kind": "list", "items": [1]}}))
        self.assertEqual(log.steps[0]["heapIds"], ["o1"])
        self.assertTrue(log.steps[1]["sameIds"])
        self.assertNotIn("heapIds", log.steps[1])
        self.assertEqual(log.steps[1]["heap"], {})
        self.assertTrue(log.steps[2]["sameIds"])  # one object changed: its ids didn't

    def test_a_frame_that_didnt_change_is_sent_as_its_id(self):
        log = StepLog(10)
        outer = {"id": "f1", "func": "Global", "line": 3, "locals": []}
        inner = {"id": "f2", "func": "f", "line": 1, "locals": []}
        log.commit({"event": "call", "heap": {}, "stack": [outer, inner]})
        moved = {"id": "f2", "func": "f", "line": 2, "locals": []}
        log.commit({"event": "line", "heap": {}, "stack": [outer, moved]})
        self.assertEqual(log.steps[0]["stack"], [outer, inner])
        self.assertEqual(log.steps[1]["stack"], [{"id": "f1", "same": True}, moved])

    def test_ids_are_sent_as_a_change_to_the_step_befores(self):
        before = ["o%d" % i for i in range(40)]
        self.assertEqual(ids_part(before, ["new", *before]), [0, 40, ["new"]])
        self.assertEqual(ids_part(before, [*before[:10], "x", *before[11:]]), [10, 29, ["x"]])
        self.assertIsNone(ids_part(before, list(reversed(before))))  # nothing kept: all of them
        self.assertIsNone(ids_part(None, before))
