"""
The trace's steps, as they're recorded.

A step is committed in order, with its heap sent as a delta: only the
objects that differ from their last version sent (in any step before), plus every id in order
(heapIds), left out (sameIds) when they're the same ids in the same order
as the step before, or as a change to the step before's (heapIdsPart: how
many of its first and last ids stay, and the ids between). A frame that's the same as in the step before is sent
as just its id and `same` (the serializer hands back the very same view
for a frame that didn't change, so most of a deep call stack is sent once).
The page rebuilds full heaps and stacks, sharing what didn't change
(src/trace/delta.ts). Events that aren't recorded (the middle of a sampled
loop, see sampling.py) are counted, and the next step says how many were
skipped before it.
"""

from typing import Any

Step = dict[str, Any]


def ids_part(before: list[str] | None, ids: list[str]) -> list[Any] | None:
    """This step's ids as a change to the step before's: [how many of its first
    ids are kept, how many of its last, and the ids between] (a new node at the
    head of a list is one id, not every id again). None when that saves little."""
    if not before:
        return None
    n, m = len(before), len(ids)
    head = 0
    limit = min(n, m)
    while head < limit and before[head] == ids[head]:
        head += 1
    tail = 0
    while tail < limit - head and before[n - 1 - tail] == ids[m - 1 - tail]:
        tail += 1
    if head + tail < m // 2 or m < 16:
        return None
    return [head, tail, ids[head : m - tail]]


# The page keeps a heap's ids in full this often, in versions (src/trace/heapStore.ts CHECKPOINT_EVERY).
CHECKPOINT_EVERY = 64


def kept_entries(obj: dict[str, Any]) -> int:
    """What keeping a sent object costs the page, in heap entries: one, and one for each
    thing it holds (an item, a field, an entry's key and its value). As
    src/trace/heapStore.ts keptEntries counts it."""
    strip = obj.get("strip")
    return (
        1
        + len(obj.get("items") or ())
        + 2 * len(obj.get("entries") or ())
        + len(obj.get("fields") or ())
        + -(-len(strip["values"]) // 8 if strip else 0)
    )


class StepLog:
    def __init__(self, max_steps: int, max_heap_entries: float = float("inf")) -> None:
        self.max_steps = max_steps
        # Heap entries the page will keep (SamplingPolicy.maxHeapEntries in src/trace/policy.ts): the
        # objects sent, by what they hold, and the ids' changes (src/trace/heapStore.ts).
        self.max_heap_entries = max_heap_entries
        self.heap_entries = 0
        self.steps: list[Step] = []
        self.known: dict[str, Any] = {}  # every object's last version sent
        self.prev_ids: list[str] | None = None
        self.prev_frames: dict[str, Any] = {}  # the last committed step's frames, by id
        self.skipped = 0  # events not recorded since the last recorded step
        self.considered = 0  # steps recorded or buffered (for a loop's share of the budget)

    def full(self) -> bool:
        """The step budget is spent, or the memory budget."""
        return len(self.steps) >= self.max_steps or self.out_of_memory()

    def out_of_memory(self) -> bool:
        """The heap entries the page would keep are past their budget."""
        return self.heap_entries > self.max_heap_entries

    def commit(self, step: Step) -> None:
        """Add a recorded step, noting how many weren't recorded before it."""
        if self.skipped:
            step["skipped"] = self.skipped
            self.skipped = 0
        heap = step["heap"]
        known = self.known
        # Only what differs from the object's last version sent, in any step
        # before (an object out of reach for a while isn't sent again when it's
        # back). The serializer reuses unchanged heap objects, so `is` settles most.
        step["heap"] = {oid: obj for oid, obj in heap.items() if (p := known.get(oid)) is not obj and p != obj}
        known.update(step["heap"])
        ids = list(heap)
        # The page keeps the objects that changed and, for a heap that did, its ids (a change, and a
        # full list every CHECKPOINT_EVERY versions).
        if step["heap"] or ids != self.prev_ids:
            self.heap_entries += -(-len(ids) // CHECKPOINT_EVERY) + sum(
                1 + kept_entries(o) for o in step["heap"].values()
            )
        if ids == self.prev_ids:
            step["sameIds"] = True
        else:
            part = ids_part(self.prev_ids, ids)
            if part is not None:
                step["heapIdsPart"] = part
            else:
                step["heapIds"] = ids
        self.prev_ids = ids
        frames = {}
        for key in ("stack", "suspended"):
            if key not in step:
                continue
            out = []
            for frame in step[key]:
                frames[frame["id"]] = frame
                same = self.prev_frames.get(frame["id"]) is frame
                out.append({"id": frame["id"], "same": True} if same else frame)
            step[key] = out
        self.prev_frames = frames
        self.steps.append(step)

    def skip(self, count: int = 1) -> None:
        """Events that ran without being recorded."""
        self.skipped += count

    def finish(self) -> None:
        """Anything after the last recorded step (a sampled loop at the very end)."""
        if self.skipped and self.steps:
            self.steps[-1]["skippedAfter"] = self.skipped
