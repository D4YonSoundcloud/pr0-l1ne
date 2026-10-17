"""
The tracing policy: the step budget, time limits and sampling rules,
defined once in src/trace/policy.ts for both tracers.

The app sends the budget and the sampling rules with each run, so this
module holds none of the numbers. fixtures/policy.json (written from
policy.ts by `npm run schema`) has them for running the tracer outside the
app: the CLI and the tests.
"""

import json
import os
from typing import TypedDict


class SamplingPolicy(TypedDict):
    """How long loops are sampled. The fields are explained in src/trace/policy.ts."""

    first: int
    last: int
    roundFrom: int
    sampleShare: float
    watchShare: float
    roundShare: float
    passShare: float


class Policy(TypedDict):
    maxSteps: int
    liveSeconds: float
    runSeconds: float
    measureMs: float
    sampling: SamplingPolicy


POLICY_FILE = os.path.join("fixtures", "policy.json")


def load_policy() -> Policy:
    """The policy in fixtures/policy.json, found in this folder or one above it."""
    folder = os.path.dirname(os.path.abspath(__file__))
    while True:
        path = os.path.join(folder, POLICY_FILE)
        if os.path.exists(path):
            with open(path) as handle:
                return json.load(handle)
        parent = os.path.dirname(folder)
        if parent == folder:
            raise FileNotFoundError(f"{POLICY_FILE} not found: run `npm run schema`, or pass the policy in")
        folder = parent
