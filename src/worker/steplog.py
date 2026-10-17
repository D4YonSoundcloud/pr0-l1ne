"""
The trace's steps, as they're recorded.

A step is committed in order, with its heap sent as a delta: only the
objects that differ from the step before, plus every id in order
(heapIds). The page rebuilds full heaps, sharing unchanged objects
(src/trace/delta.ts). Events that aren't recorded (the middle of a sampled
loop, see sampling.py) are counted, and the next step says how many were
skipped before it.
"""

from typing import Any

Step = dict[str, Any]


class StepLog:
    def __init__(self, max_steps: int) -> None:
        self.max_steps = max_steps
        self.steps: list[Step] = []
        self.prev_heap: dict[str, Any] = {}  # the last committed step's full heap
        self.skipped = 0  # events not recorded since the last recorded step
        self.considered = 0  # steps recorded or buffered (for a loop's share of the budget)

    def full(self) -> bool:
        """The step budget is spent."""
        return len(self.steps) >= self.max_steps

    def commit(self, step: Step) -> None:
        """Add a recorded step, noting how many weren't recorded before it."""
        if self.skipped:
            step["skipped"] = self.skipped
            self.skipped = 0
        heap = step["heap"]
        prev = self.prev_heap
        step["heap"] = {oid: obj for oid, obj in heap.items() if prev.get(oid) != obj}
        step["heapIds"] = list(heap)
        self.prev_heap = heap
        self.steps.append(step)

    def skip(self, count: int = 1) -> None:
        """Events that ran without being recorded."""
        self.skipped += count

    def finish(self) -> None:
        """Anything after the last recorded step (a sampled loop at the very end)."""
        if self.skipped and self.steps:
            self.steps[-1]["skippedAfter"] = self.skipped
