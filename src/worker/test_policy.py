"""Tests for policy.py, and for the tracer taking its rules from the run. Run with: npm run test:tracer"""

import json
import os
import unittest
from unittest import mock

import policy
from tracer import run_trace

LOOP = "total = 0\nfor i in range(1000):\n    total += i\n"


def kept(trace_json):
    """The passes of the program's loop that were recorded."""
    trace = json.loads(trace_json)
    return sorted({ctx["iteration"] for step in trace["steps"] for ctx in step["loops"]})


class PolicyTests(unittest.TestCase):
    def test_the_policy_file_has_every_rule(self):
        p = policy.load_policy()
        self.assertEqual(set(p), set(policy.Policy.__annotations__))
        self.assertEqual(set(p["sampling"]), set(policy.SamplingPolicy.__annotations__))

    def test_a_missing_policy_file_says_how_to_make_one(self):
        with mock.patch.object(os.path, "exists", return_value=False):
            with self.assertRaisesRegex(FileNotFoundError, "npm run schema"):
                policy.load_policy()

    def test_the_run_decides_how_loops_are_sampled(self):
        rules = policy.load_policy()["sampling"]
        default = kept(run_trace(LOOP, 300))
        self.assertEqual(kept(run_trace(LOOP, 300, 6, json.dumps(rules))), default)  # as the worker sends it
        other: policy.SamplingPolicy = {**rules, "first": 2, "last": 2, "roundFrom": 100}
        self.assertEqual(
            kept(run_trace(LOOP, 300, 6, other)), [0, 1, 2, 100, 200, 300, 400, 500, 600, 700, 800, 900, 999, 1000]
        )
        self.assertNotEqual(default[:4], [0, 1, 2, 100])


if __name__ == "__main__":
    unittest.main()
