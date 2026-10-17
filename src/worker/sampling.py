"""
Sampling long loops (see docs/how-it-works.md, "Big inputs").

A loop that would use more than its share of the step budget keeps its
first passes, passes at round numbers (10, 20 ... 90, 100, 200 ... 900,
1000 ...), and its last passes; the passes in between run, and are counted,
but aren't recorded. A loop whose length is known as it starts (LoopLengths
reports it) knows which passes are its last. One whose length isn't known
(a while loop) keeps its latest passes in a buffer until it ends.

Loops that aren't loop statements are sampled the same way: a line running
again and again (a comprehension, a one-line loop body), and a function
called again and again from one line (a callback that map(), sorted() or a
generator expression calls).

The tracer asks place() where each event's step goes: straight into the
trace, into the buffer of a long loop's last passes, or nowhere.

How many passes, and what share of the budget, come from the SamplingPolicy
each run is given (src/trace/policy.ts), the same numbers the JavaScript
tracer gets.
"""

import ast
import sys
from collections import deque
from types import FrameType
from typing import Any, Literal

from analysis import USER_FILENAME
from policy import SamplingPolicy
from steplog import Step, StepLog

# Where place() puts an event's step: RECORD (into the trace now), a list
# (buffered with a long loop's last passes), or None (not recorded).
RECORD: Literal["record"] = "record"

Placement = list[Step] | Literal["record"] | None

# A loop's pass bookkeeping: {"instance", "iteration", "total", "mode", "start", ...}.
LoopState = dict[str, Any]


def round_pass(n: int, policy: SamplingPolicy) -> bool:
    """10, 20 ... 90, 100, 200 ... 900, 1000 ... (from policy roundFrom): a pass worth keeping in a long loop."""
    if n < policy["roundFrom"]:
        return False
    scale = 10 ** (len(str(n)) - 1)
    return n % scale == 0


def user_frames(frame: FrameType | None) -> list[FrameType]:
    """The program's own frames on the stack, outermost first, skipping library frames in
    between (asyncio's event loop sits between Global and a coroutine)."""
    frames = []
    f = frame
    while f is not None:
        if f.f_code.co_filename == USER_FILENAME:
            frames.append(f)
        f = f.f_back
    frames.reverse()
    return frames


class LoopLengths(ast.NodeTransformer):
    """for x in xs -> for x in __viz_len__(line, xs): tells the tracer a loop's length as it starts."""

    def visit_For(self, node: ast.For) -> ast.For:
        self.generic_visit(node)
        node.iter = ast.copy_location(
            ast.Call(
                func=ast.Name(id="__viz_len__", ctx=ast.Load()),
                args=[ast.Constant(node.lineno), node.iter],
                keywords=[],
            ),
            node.iter,
        )
        return node


class Sampler:
    """Which passes of which loops are recorded, for one run."""

    def __init__(self, log: StepLog, frame_ids: dict[int, str], policy: SamplingPolicy) -> None:
        self.policy = policy
        self.log = log
        self.frame_ids = frame_ids  # id(frame) -> "f3", shared with the tracer
        self.loops: list[dict[str, Any]] = []  # the program's loops (analysis.analyze)
        # Loop bookkeeping, keyed by frame id
        self.last_line: dict[str, int] = {}
        self.active_loops: dict[str, dict[str, LoopState]] = {}
        self.loop_instances: dict[tuple[str, str], int] = {}
        self.sampled = False
        # The last passes of a long loop whose length wasn't known: kept
        # until the loop ends, then saved (see place()).
        self.tail: dict[str, Any] | None = None
        self.repeats: dict[str, dict[str, Any]] = {}  # frame id -> {"line", "state"}
        self.callbacks: dict[str, Any] | None = None  # {"key", "state"}: the current run of repeated calls
        self.callback_of: dict[str, LoopState] = {}  # callee frame id -> that run's state

    # -- loop statements ---------------------------------------------------

    def update_loops(self, fid: str, line: int) -> None:
        """Detect loop entry, new iterations and loop exit for one frame.

        A new iteration starts when execution moves from a loop's header line
        into its body. That way the final header check (the one that ends the
        loop) is not counted as an iteration.
        """
        prev = self.last_line.get(fid)
        self.last_line[fid] = line
        active = self.active_loops.setdefault(fid, {})

        for loop in self.loops:
            lid = loop["id"]
            in_body = loop["bodyStart"] <= line <= loop["bodyEnd"]
            on_header = line == loop["line"]
            state = active.get(lid)

            if state is not None and not (in_body or on_header):
                del active[lid]  # left the loop
                continue
            if state is None and on_header:
                count = self.loop_instances.get((fid, lid), 0) + 1
                self.loop_instances[(fid, lid)] = count
                active[lid] = {
                    "instance": count,
                    "iteration": 0,
                    "total": None,
                    "mode": None,
                    "start": self.log.considered,
                }
            elif state is not None and in_body and not on_header and prev == loop["line"]:
                state["iteration"] += 1
                self.new_pass(state)

    def loop_length(self, line: int, iterable: Any) -> Any:
        """__viz_len__(line, xs): note a for loop's length as it starts, and
        for a range, the range itself ("range(0, 4)"), shown on the loop's rows."""
        try:
            n = len(iterable)
        except Exception:
            return iterable
        caller = sys._getframe(1)
        fid = self.frame_ids.get(id(caller))
        state = self.active_loops.get(fid, {}).get("L%d" % line) if fid is not None else None
        if state is not None and state["iteration"] == 0:
            state["total"] = n
            if type(iterable) is range:
                state["call"] = repr(iterable)
        return iterable

    def loop_context(self, frame_ids: list[str]) -> list[dict[str, Any]]:
        """The loops running in these frames, and which pass each is on (a step's "loops")."""
        context = []
        for fid in frame_ids:
            active = self.active_loops.get(fid, {})
            for loop in self.loops:
                state = active.get(loop["id"])
                if state is not None:
                    ctx = {
                        "frame": fid,
                        "loop": loop["id"],
                        "instance": state["instance"],
                        "iteration": state["iteration"],
                    }
                    if "call" in state:
                        ctx["call"] = state["call"]
                    context.append(ctx)
        return context

    # -- which passes are kept ---------------------------------------------

    def new_pass(self, state: LoopState) -> None:
        """Decide, after a loop's first few passes, whether to record all of it."""
        it = state["iteration"]
        room = self.log.max_steps - state["start"]
        first = self.policy["first"]
        if state["mode"] is None and it == first + 1:
            per_pass = (self.log.considered - state["start"]) / first
            total = state["total"]
            if total is not None:
                state["mode"] = "sampled" if per_pass * total > room * self.policy["sampleShare"] else "full"
            else:
                state["mode"] = "watch"
        if state["mode"] == "watch" and self.log.considered - state["start"] > room * self.policy["watchShare"]:
            state["mode"] = "sampled"
        if state["mode"] == "sampled":
            self.sampled = True
            state["keep"] = self.decide_keep(state, room)
        else:
            state["keep"] = True
        if state["keep"]:
            state["kept"] = state.get("kept", 0) + 1

    def decide_keep(self, state: LoopState, room: int) -> bool:
        """In a sampled loop: record this pass? The first and last few, and
        round-numbered ones while the loop's share of the budget allows
        (leaving room for its last passes)."""
        it, total = state["iteration"], state["total"]
        first, last = self.policy["first"], self.policy["last"]
        if it <= first or (total is not None and it > total - last):
            return True
        if not round_pass(it, self.policy):
            return False
        spent = self.log.considered - state["start"]
        per_pass = spent / max(1, state.get("kept", 0))
        return spent + per_pass * (last + 1) <= room * self.policy["roundShare"]

    @staticmethod
    def keep_pass(state: LoopState) -> bool:
        """Is this pass of the loop recorded?"""
        return state["mode"] != "sampled" or state.get("keep", True)

    # -- loops that aren't loop statements ---------------------------------

    def pseudo_state(self) -> LoopState:
        """Pass bookkeeping for a loop that isn't a loop statement (no last passes kept: see repeats)."""
        return {
            "instance": 0,
            "iteration": 0,
            "total": None,
            "mode": None,
            "start": self.log.considered,
            "pseudo": True,
        }

    def track_repeats(self, frame: FrameType, fid: str, event: str, prev_line: int | None) -> None:
        """Notice a line running again and again, and a function called again and again from one line."""
        if event == "line":
            self.repeated_line(frame, fid, prev_line)
        elif event == "call":
            self.repeated_call(frame, fid)
        # A callee's run state is dropped as it returns, after that return
        # step has been sampled with it (see left()).

    def repeated_line(self, frame: FrameType, fid: str, prev_line: int | None) -> None:
        rep = self.repeats.get(fid)
        if rep is not None and rep["line"] == frame.f_lineno and prev_line == frame.f_lineno:
            rep["state"]["iteration"] += 1
            self.new_pass(rep["state"])
        elif rep is None or rep["line"] != frame.f_lineno:
            self.repeats[fid] = {"line": frame.f_lineno, "state": self.pseudo_state()}
        run = self.callbacks
        if run is not None and run["caller"] == fid and run["line"] != frame.f_lineno:
            self.callbacks = None  # the caller moved on

    def repeated_call(self, frame: FrameType, fid: str) -> None:
        caller = frame.f_back
        while caller is not None and caller.f_code.co_filename != USER_FILENAME:
            caller = caller.f_back
        if caller is None:
            return
        caller_id = self.frame_ids.get(id(caller))
        key = (caller_id, caller.f_lineno, frame.f_code)
        run = self.callbacks
        if run is None or run["key"] != key:
            run = self.callbacks = {
                "key": key,
                "caller": caller_id,
                "line": caller.f_lineno,
                "state": self.pseudo_state(),
            }
        run["state"]["iteration"] += 1
        self.new_pass(run["state"])
        self.callback_of[fid] = run["state"]

    def left(self, fid: str) -> None:
        """A frame returned, yielded or awaited: it's no longer a pass of a run of calls."""
        self.callback_of.pop(fid, None)

    # -- where each step goes ----------------------------------------------

    def place(self, frame: FrameType, fid: str, event: str, prev_line: int | None) -> Placement:
        """Where this event's step goes (see RECORD)."""
        self.track_repeats(frame, fid, event, prev_line)
        states = self.active_states(frame) if self.sampled else ()
        self.settle_tail(states)
        outside = next((s for s in states if not self.keep_pass(s)), None)
        if outside is None and self.tail is not None:
            # A kept pass (a round number) of a loop whose last passes are
            # being buffered: it joins the buffer, pinned, to stay in order.
            return self.buffer(self.tail["state"], pinned=True)
        if outside is None:
            return RECORD
        if outside["total"] is not None or outside.get("pseudo"):
            self.log.skip()  # the middle of a loop whose last passes are known: not recorded
            return None
        return self.buffer(outside)

    def active_states(self, frame: FrameType) -> list[LoopState]:
        """Loop states on the user's stack, outermost first."""
        out = []
        for f in user_frames(frame):
            fid = self.frame_ids.get(id(f))
            if fid is None:
                continue
            run = self.callback_of.get(fid)
            if run is not None and run["iteration"] > 0:
                out.append(run)
            active = self.active_loops.get(fid)
            if active:
                for loop in self.loops:
                    state = active.get(loop["id"])
                    if state is not None:
                        out.append(state)
            rep = self.repeats.get(fid)
            if rep is not None and rep["state"]["iteration"] > 0 and rep["line"] == f.f_lineno:
                out.append(rep["state"])
        return out

    def settle_tail(self, states: list[LoopState] | tuple[()]) -> None:
        """The buffered last passes of a long loop: saved once the loop ends."""
        tail = self.tail
        if tail is None or any(s is tail["state"] for s in states):
            return  # still in the loop
        for _it, steps, _pinned in tail["passes"]:
            for step in steps:
                self.log.commit(step)
        self.tail = None

    def buffer(self, state: LoopState, pinned: bool = False) -> list[Step] | None:
        """A pass of a long loop of unknown length: kept in case it's one of the last
        (pinned passes, at round numbers, are always kept). Returns the list its step
        goes into, or None for the rest of one enormous pass."""
        if self.tail is None or self.tail["state"] is not state:
            if self.tail is not None:
                self.settle_tail(())  # a different loop: save what we had
            self.tail = {"state": state, "passes": deque(), "loose": 0}
        tail = self.tail
        passes = tail["passes"]
        if not passes or passes[-1][0] != state["iteration"]:
            passes.append((state["iteration"], [], pinned))
            if not pinned:
                tail["loose"] += 1
            while tail["loose"] > self.policy["last"]:
                _it, steps, was_pinned = passes.popleft()
                if was_pinned:
                    for step in steps:
                        self.log.commit(step)  # earlier than everything still buffered
                else:
                    tail["loose"] -= 1
                    self.log.skip(len(steps))
        steps = passes[-1][1]
        if len(steps) > self.log.max_steps * self.policy["passShare"]:
            self.log.skip()  # one enormous pass: keep its start
            return None
        return steps
