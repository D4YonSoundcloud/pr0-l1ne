"""
AlgoViz tracer.

Runs user code under sys.settrace and records a snapshot of program state at
every line, call, return and exception event. The output is a JSON string in
the language-agnostic trace format described in src/trace/types.ts.

This file is plain CPython: it runs inside Pyodide in the browser, and you can
also run it directly with `python3 tracer.py some_file.py` to inspect a trace.
"""

import ast
import builtins
import dis
import inspect
import io
import json
import re
import sys
import time
import warnings
from collections import deque

from analysis import USER_FILENAME, analyze, collect_hints
from serialize import CONVENTIONAL_POINTERS, MAX_ITEMS, PRIMITIVE_TYPES, Serializer, is_hidden_name
from shape import cost_analysis

# Code flags for functions that can pause: generators, coroutines (async def)
# and async generators.
CO_GENERATOR = inspect.CO_GENERATOR
CO_COROUTINE = inspect.CO_COROUTINE
CO_ASYNC_GENERATOR = inspect.CO_ASYNC_GENERATOR
CO_PAUSABLE = CO_GENERATOR | CO_COROUTINE | CO_ASYNC_GENERATOR
# Where a frame is parked when it pauses at a yield or await: on the
# YIELD_VALUE itself in Python 3.12 (what the browser runs), or on the
# RESUME after it in 3.13.
PAUSE_OPS = {dis.opmap[name] for name in ("YIELD_VALUE", "RESUME") if name in dis.opmap}
# Instructions where `await` raises StopIteration internally to deliver its
# result. Those exceptions are plumbing, not part of the user's program.
AWAIT_PLUMBING = {dis.opmap[name] for name in ("SEND", "END_SEND", "CLEANUP_THROW") if name in dis.opmap}


# Sampling long loops (see "Big inputs" in the README). A loop that would
# use more than its share of the step budget keeps its first passes, passes
# at round numbers (10, 20 ... 90, 100, 200 ... 900, 1000 ...), and its last
# passes; the passes in between run, and are counted, but aren't recorded.
# Python 3.12 inlines list comprehensions into the enclosing frame. Reading
# that frame's locals from a trace function while a comprehension runs makes
# CPython warn "assigning None to unbound local" for the comprehension's
# variable. It's harmless (the trace is correct) but floods the console.
warnings.filterwarnings("ignore", message="assigning None to unbound local", category=RuntimeWarning)

SAMPLE_FIRST = 5  # passes always recorded at the start
SAMPLE_LAST = 5  # passes always recorded at the end
TRACE_SECONDS = 6.0  # stop tracing after this long, even within the step budget
# (the page passes less for live runs while typing)


def round_pass(n):
    """10, 20 ... 90, 100, 200 ... 900, 1000 ...: a pass worth keeping in a long loop."""
    if n < 10:
        return False
    scale = 10 ** (len(str(n)) - 1)
    return n % scale == 0


class StepLimitExceeded(BaseException):
    """Raised from the trace function when the step budget runs out.

    It subclasses BaseException so `except Exception:` in user code can't
    swallow it.
    """


# ---------------------------------------------------------------------------
# The tracer
# ---------------------------------------------------------------------------


class Tracer:
    def __init__(self, source, max_steps, max_seconds=TRACE_SECONDS):
        self.source = source
        self.max_steps = max_steps
        self.max_seconds = max_seconds
        self.steps = []
        self.stdout = io.StringIO()
        self.keepalive = {}
        self.object_ids = {}
        self.frame_ids = {}
        # What print() was given since the last step: {"line", "objects"}.
        self.pending_print: dict | None = None
        self.frame_counter = 0
        self.loops = []
        self.index_names = {}
        self.prev_heap = {}  # the last committed step's full heap (see commit)
        # Loop bookkeeping, keyed by frame id
        self.last_line = {}
        self.active_loops = {}
        self.loop_instances = {}
        # Generators and coroutines that are paused at a yield or await:
        # frame id -> frame. Shown as suspended frames until they resume.
        self.suspended = {}
        # Frames with an exception propagating through them. A "return" that
        # follows is the frame exiting by exception, not pausing.
        self.unwinding = set()
        # Everything that happens is counted, recorded or not.
        self.counts = {"steps": 0, "calls": {}, "depth": {}}
        self.skipped = 0  # events not recorded since the last recorded step
        self.considered = 0  # steps recorded or buffered (for a loop's share of the budget)
        self.sampled = False
        self.stopped_by = None
        self.deadline = None
        self.tick = 1000
        # The last passes of a long loop whose length wasn't known: kept
        # until the loop ends, then saved (see trace()).
        self.tail = None
        # Loops that aren't loop statements, sampled the same way:
        # a line running again and again (a comprehension, a one-line loop
        # body), and a function called again and again from one line (a
        # callback that map(), sorted() or a generator expression calls).
        self.repeats = {}  # frame id -> {"line", "state"}
        self.callbacks = None  # {"key", "state"}: the current run of repeated calls
        self.callback_of = {}  # callee frame id -> that run's state

    # -- identity ----------------------------------------------------------

    def frame_id(self, frame):
        key = id(frame)
        if key not in self.frame_ids:
            self.frame_counter += 1
            self.frame_ids[key] = "f%d" % self.frame_counter
            self.keepalive.setdefault("frame%d" % key, frame)
        return self.frame_ids[key]

    # -- loops -------------------------------------------------------------

    def update_loops(self, fid, line):
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
                active[lid] = {"instance": count, "iteration": 0, "total": None, "mode": None, "start": self.considered}
            elif state is not None and in_body and not on_header and prev == loop["line"]:
                state["iteration"] += 1
                self.new_pass(state)

    def new_pass(self, state):
        """Decide, after a loop's first few passes, whether to record all of it."""
        it = state["iteration"]
        room = self.max_steps - state["start"]
        if state["mode"] is None and it == SAMPLE_FIRST + 1:
            per_pass = (self.considered - state["start"]) / SAMPLE_FIRST
            total = state["total"]
            if total is not None:
                state["mode"] = "sampled" if per_pass * total > room * 0.5 else "full"
            else:
                state["mode"] = "watch"
        if state["mode"] == "watch" and self.considered - state["start"] > room * 0.25:
            state["mode"] = "sampled"
        if state["mode"] == "sampled":
            self.sampled = True
            state["keep"] = self.decide_keep(state, room)
        else:
            state["keep"] = True
        if state["keep"]:
            state["kept"] = state.get("kept", 0) + 1

    def decide_keep(self, state, room):
        """In a sampled loop: record this pass? The first and last few, and
        round-numbered ones while the loop's share of the budget allows
        (leaving room for its last passes)."""
        it, total = state["iteration"], state["total"]
        if it <= SAMPLE_FIRST or (total is not None and it > total - SAMPLE_LAST):
            return True
        if not round_pass(it):
            return False
        spent = self.considered - state["start"]
        per_pass = spent / max(1, state.get("kept", 0))
        return spent + per_pass * (SAMPLE_LAST + 1) <= room * 0.6

    @staticmethod
    def keep_pass(state):
        """Is this pass of the loop recorded?"""
        return state["mode"] != "sampled" or state.get("keep", True)

    def pseudo_state(self):
        """Pass bookkeeping for a loop that isn't a loop statement (no last passes kept: see repeats)."""
        return {"instance": 0, "iteration": 0, "total": None, "mode": None, "start": self.considered, "pseudo": True}

    def track_repeats(self, frame, fid, event, prev_line):
        """Notice a line running again and again, and a function called again and again from one line."""
        if event == "line":
            rep = self.repeats.get(fid)
            if rep is not None and rep["line"] == frame.f_lineno and prev_line == frame.f_lineno:
                rep["state"]["iteration"] += 1
                self.new_pass(rep["state"])
            elif rep is None or rep["line"] != frame.f_lineno:
                self.repeats[fid] = {"line": frame.f_lineno, "state": self.pseudo_state()}
            run = self.callbacks
            if run is not None and run["caller"] == fid and run["line"] != frame.f_lineno:
                self.callbacks = None  # the caller moved on
        elif event == "call":
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
        # A callee's run state is dropped as it returns, after that return
        # step has been sampled with it (see trace()).

    def loop_length(self, line, iterable):
        """__viz_len__(line, xs): note a for loop's length as it starts, and
        for a range, the range itself ("range(0, 4)"), shown on the loop's rows."""
        try:
            n = len(iterable)
        except Exception:
            return iterable
        caller = sys._getframe(1)
        state = self.active_loops.get(self.frame_ids.get(id(caller)), {}).get("L%d" % line)
        if state is not None and state["iteration"] == 0:
            state["total"] = n
            if type(iterable) is range:
                state["call"] = repr(iterable)
        return iterable

    def loop_context(self, frame_ids):
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

    # -- recording ---------------------------------------------------------

    def record(self, frame, event, arg, into=None):  # noqa: C901 (W4 splits it)
        if into is None and len(self.steps) >= self.max_steps:
            self.stopped_by = "steps"
            raise StepLimitExceeded()

        # The user's frames on the call stack, skipping library frames in
        # between (asyncio's event loop sits between Global and a coroutine).
        frames = []
        f = frame
        while f is not None:
            if f.f_code.co_filename == USER_FILENAME:
                frames.append(f)
            f = f.f_back
        frames.reverse()

        serializer = Serializer(self.keepalive, self.object_ids, focus=self.focus_of(frames))

        def describe(fr):
            is_module = fr.f_code.co_name == "<module>"
            variables = []
            for name, val in list(fr.f_locals.items()):
                if is_hidden_name(name, val):
                    continue
                if is_module and name in ("input", "print"):
                    continue
                variables.append([name, serializer.value(val)])
            return {
                "id": self.frame_id(fr),
                "func": "Global" if is_module else fr.f_code.co_name,
                "line": fr.f_lineno,
                "locals": variables,
            }

        stack = [describe(fr) for fr in frames]
        on_stack = {s["id"] for s in stack}
        suspended = [dict(describe(fr), state="suspended") for fid, fr in self.suspended.items() if fid not in on_stack]

        step = {
            "event": event,
            "line": frame.f_lineno,
            "stack": stack,
            "heap": serializer.heap,
            "stdoutLength": len(self.stdout.getvalue()),
            "loops": self.loop_context([s["id"] for s in stack] + [s["id"] for s in suspended]),
        }
        if suspended:
            step["suspended"] = suspended
        if self.pending_print is not None:
            # Printed objects that are drawn at this step, by their ids.
            refs = []
            for obj in self.pending_print["objects"]:
                oid = self.object_ids.get(id(obj))
                if oid in serializer.heap and oid not in refs:
                    refs.append(oid)
            step["output"] = {"line": self.pending_print["line"], "refs": refs}
            self.pending_print = None
        if event in ("return", "yield"):
            step["returnValue"] = serializer.value(arg)
        if event == "exception":
            exc_type, exc_value, _ = arg
            step["exception"] = {"type": exc_type.__name__, "message": str(exc_value)}
        self.considered += 1
        if into is not None:
            into.append(step)
        else:
            self.commit(step)

    def focus_of(self, frames):
        """Long lists' index variables: id(list) -> their values, innermost frame first."""
        focus = {}
        names = self.index_names
        if not names:
            return focus
        for fr in reversed(frames):
            local = fr.f_locals
            for name, val in list(local.items()):
                if type(val) not in (list, tuple) or len(val) <= MAX_ITEMS or id(val) in focus:
                    continue
                subs = names.get(name)
                if not subs:
                    continue
                indices = []
                for sub in set(subs).union(c for c in CONVENTIONAL_POINTERS if c in local):
                    x = local.get(sub)
                    if type(x) is int and 0 <= x <= len(val):
                        indices.append(x)
                if indices:
                    focus[id(val)] = indices
        return focus

    def commit(self, step):
        """Add a recorded step, noting how many weren't recorded before it.

        Its heap is sent as a delta: only objects that differ from the
        previous step's, plus every id in order (heapIds). The page rebuilds
        full heaps, sharing unchanged objects (trace/delta.ts)."""
        if self.skipped:
            step["skipped"] = self.skipped
            self.skipped = 0
        heap = step["heap"]
        prev = self.prev_heap
        step["heap"] = {oid: obj for oid, obj in heap.items() if prev.get(oid) != obj}
        step["heapIds"] = list(heap)
        self.prev_heap = heap
        self.steps.append(step)

    # -- sampling ------------------------------------------------------------

    def active_states(self, frame):
        """Loop states on the user's stack, outermost first."""
        frames = []
        f = frame
        while f is not None:
            if f.f_code.co_filename == USER_FILENAME:
                frames.append(f)
            f = f.f_back
        out = []
        for f in reversed(frames):
            fid = self.frame_ids.get(id(f))
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

    def settle_tail(self, states):
        """The buffered last passes of a long loop: saved once the loop ends."""
        tail = self.tail
        if tail is None or any(s is tail["state"] for s in states):
            return  # still in the loop
        for _it, steps, _pinned in tail["passes"]:
            for step in steps:
                self.commit(step)
        self.tail = None

    def trace(self, frame, event, arg):  # noqa: C901 (W4 splits it)
        code = frame.f_code
        if code.co_filename != USER_FILENAME:
            return None  # don't trace library code
        fid = self.frame_id(frame)
        pausable = code.co_flags & CO_PAUSABLE
        prev_line = self.last_line.get(fid)
        if event == "line":
            self.unwinding.discard(fid)  # the exception was caught
            self.update_loops(fid, frame.f_lineno)
        elif event == "call" and fid in self.suspended:
            # A paused generator or coroutine picking up where it left off.
            del self.suspended[fid]
            event = "resume"
        elif event == "return" and fid in self.unwinding:
            self.unwinding.discard(fid)
            self.suspended.pop(fid, None)
        elif event == "return" and pausable and frame.f_lasti >= 0 and code.co_code[frame.f_lasti] in PAUSE_OPS:
            # Pausing at a yield or await looks like a return, except that the
            # frame is parked at the yield (see PAUSE_OPS) instead of a return.
            self.suspended[fid] = frame
            if code.co_flags & CO_COROUTINE:
                event = "await"
            elif code.co_flags & CO_ASYNC_GENERATOR and (arg is None or hasattr(arg, "_asyncio_future_blocking")):
                event = "await"
            else:
                event = "yield"
        elif event == "return":
            self.suspended.pop(fid, None)
        elif event == "exception":
            exc_type = arg[0]
            if (
                pausable
                and issubclass(exc_type, (StopIteration, StopAsyncIteration))
                and frame.f_lasti >= 0
                and code.co_code[frame.f_lasti] in AWAIT_PLUMBING
            ):
                return self.trace
            self.unwinding.add(fid)
        if event in ("call", "line", "return", "exception", "resume", "yield", "await"):
            self.counts["steps"] += 1
            if event == "call":
                name = code.co_name
                calls = self.counts["calls"]
                calls[name] = calls.get(name, 0) + 1
                depth, f = 0, frame
                while f is not None:
                    if f.f_code is code:
                        depth += 1
                    f = f.f_back
                if depth > self.counts["depth"].get(name, 0):
                    self.counts["depth"][name] = depth
            self.tick -= 1
            if self.tick <= 0:
                self.tick = 1000
                if self.deadline is not None and time.perf_counter() > self.deadline:
                    self.stopped_by = "time"
                    raise StepLimitExceeded()
            self.track_repeats(frame, fid, event, prev_line)
            states = self.active_states(frame) if self.sampled else ()
            self.settle_tail(states)
            outside = next((s for s in states if not self.keep_pass(s)), None)
            if outside is None and self.tail is not None:
                # A kept pass (a round number) of a loop whose last passes are
                # being buffered: it joins the buffer, pinned, to stay in order.
                self.buffer(self.tail["state"], frame, event, arg, pinned=True)
            elif outside is None:
                self.record(frame, event, arg)
            elif outside["total"] is not None or outside.get("pseudo"):
                self.skipped += 1  # the middle of a loop whose last passes are known: not recorded
            else:
                self.buffer(outside, frame, event, arg)
            if event in ("return", "yield", "await"):
                self.callback_of.pop(fid, None)
        return self.trace

    def buffer(self, state, frame, event, arg, pinned=False):
        """A pass of a long loop of unknown length: keep it in case it's one
        of the last. Pinned passes (round numbers) are always kept."""
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
            while tail["loose"] > SAMPLE_LAST:
                _it, steps, was_pinned = passes.popleft()
                if was_pinned:
                    for step in steps:
                        self.commit(step)  # earlier than everything still buffered
                else:
                    tail["loose"] -= 1
                    self.skipped += len(steps)
        steps = passes[-1][1]
        if len(steps) > self.max_steps // 4:
            self.skipped += 1  # one enormous pass: keep its start
            return
        self.record(frame, event, arg, into=steps)

    # -- running -----------------------------------------------------------

    def make_print(self):
        """print() for the program: prints as usual, and remembers what it was
        given, so the canvas can point at printed objects on the next step."""
        tracer = self

        def print(*args, **kwargs):  # noqa: A001 - it is print
            caller = sys._getframe(1)
            if caller.f_code.co_filename == USER_FILENAME and kwargs.get("file") in (None, sys.stdout):
                pending = tracer.pending_print or {"line": caller.f_lineno, "objects": []}
                if len(pending["objects"]) < 20:
                    pending["objects"].extend(a for a in args if not isinstance(a, PRIMITIVE_TYPES))
                tracer.pending_print = pending
            return builtins.print(*args, **kwargs)

        return print

    def run(self):  # noqa: C901 (W4 splits it)
        result = {
            "version": 1,
            "language": "python",
            "steps": self.steps,
            "loops": [],
            "indexNames": {},
            "heapDelta": True,
            "stdout": "",
            "error": None,
            "truncated": False,
        }
        try:
            self.loops, result["indexNames"], accesses = analyze(self.source)
            if accesses:
                result["gridAccesses"] = accesses
            result["loops"] = self.loops
            hints = collect_hints(self.source)
            if hints:
                result["hints"] = hints
            self.index_names = dict(result["indexNames"])
            for hint in hints or ():
                # viz: pointers nums: lo, hi
                m = re.match(r"pointers\s+([\w.]+(?:\[\])?)\s*:\s*(.+)$", hint["text"])
                if m:
                    extra = [n.strip() for n in m.group(2).split(",") if n.strip()]
                    self.index_names[m.group(1)] = sorted(set(self.index_names.get(m.group(1), [])) | set(extra))
            try:
                result["cost"] = cost_analysis(ast.parse(self.source, USER_FILENAME))
            except Exception:  # a guess about the code's shape must never stop a run
                pass
            tree = LoopLengths().visit(ast.parse(self.source, USER_FILENAME))
            code = compile(ast.fix_missing_locations(tree), USER_FILENAME, "exec")
        except SyntaxError as exc:
            result["error"] = {"type": "SyntaxError", "message": exc.msg or str(exc), "line": exc.lineno}
            return result

        def no_input(*_args):
            raise RuntimeError("input() isn't supported. Hard-code your test data instead.")

        user_globals = {
            "__name__": "__main__",
            "input": no_input,
            "print": self.make_print(),
            "__viz_len__": self.loop_length,
        }
        # Only programs that mention asyncio pay for importing it.
        uses_asyncio = "asyncio" in self.source
        if uses_asyncio:
            # Pyodide replaces asyncio.run with one that hands the coroutine
            # to the browser's loop, and marks that loop as running. Use the
            # standard asyncio.run and no running loop while tracing, then put
            # Pyodide's back.
            import asyncio

            # asyncio's private policy and running-loop slots (see virtual_loop_policy).
            saved_asyncio = (
                asyncio.events._event_loop_policy,  # pyright: ignore[reportAttributeAccessIssue]
                asyncio.run,
                asyncio.events._get_running_loop(),
            )
            asyncio.set_event_loop_policy(virtual_loop_policy())
            asyncio.run = asyncio.runners.run
            asyncio.events._set_running_loop(None)
        old_stdout = sys.stdout
        sys.stdout = self.stdout
        self.deadline = time.perf_counter() + self.max_seconds
        sys.settrace(self.trace)
        try:
            exec(code, user_globals)
            self.settle_tail(())
        except StepLimitExceeded:
            result["truncated"] = True
            result["stoppedBy"] = self.stopped_by or "steps"
        except BaseException as exc:  # report every user error, including SystemExit
            result["error"] = {
                "type": type(exc).__name__,
                "message": str(exc),
                "line": last_user_line(exc.__traceback__),
            }
        finally:
            sys.settrace(None)
            sys.stdout = old_stdout
            if uses_asyncio:
                # Put asyncio's private policy slot back (see virtual_loop_policy).
                policy, asyncio.run, running = saved_asyncio
                asyncio.events._event_loop_policy = policy  # pyright: ignore[reportAttributeAccessIssue]
                asyncio.events._set_running_loop(running)

        result["stdout"] = self.stdout.getvalue()
        result["counts"] = self.counts
        if self.sampled:
            result["sampled"] = True
        if self.skipped and self.steps:
            # Anything after the last recorded step (a sampled loop at the very end).
            self.steps[-1]["skippedAfter"] = self.skipped
        return result


class LoopLengths(ast.NodeTransformer):
    """for x in xs -> for x in __viz_len__(line, xs): tells the tracer a loop's length as it starts."""

    def visit_For(self, node):
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


# ---------------------------------------------------------------------------
# asyncio: an event loop with a virtual clock
# ---------------------------------------------------------------------------


def virtual_loop_policy():
    """An event loop policy whose loops run on a virtual clock.

    Pyodide's own event loop is the browser's, which can't block, so
    asyncio.run() fails there unless WebAssembly stack switching is set up
    (and even then the coroutines run from browser callbacks, outside the
    trace). This loop is the standard pure-Python one with the waiting taken
    out: when every task is asleep, the clock jumps to the next timer instead
    of sleeping. Programs behave the same, asyncio.sleep(2) costs no real
    time, and it works the same in the browser and on your machine, like the
    JavaScript tracer's virtual timers.
    """
    import asyncio

    class Clock:
        """Stands in for the selector: "waiting" moves the clock forward."""

        def __init__(self, loop):
            self.loop = loop

        def select(self, timeout):
            if timeout is None:
                raise RuntimeError("Every task is waiting, and nothing is scheduled to wake one up.")
            self.loop.now += timeout
            return []

        def close(self):
            pass

    class VirtualLoop(asyncio.BaseEventLoop):
        def __init__(self):
            self.now = 0.0
            super().__init__()
            self._selector = Clock(self)

        def time(self):
            return self.now

        def _process_events(self, event_list):
            pass

        def _write_to_self(self):
            pass

    class Policy(asyncio.events.BaseDefaultEventLoopPolicy):
        _loop_factory = VirtualLoop

    # Typeshed's stubs list the child watcher methods as abstract; asyncio's own policy doesn't need them.
    return Policy()  # pyright: ignore[reportAbstractUsage]


def last_user_line(tb):
    line = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == USER_FILENAME:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def run_trace(source, max_steps=2000, max_seconds=TRACE_SECONDS):
    """Entry point called from the Pyodide worker. Returns a JSON string."""
    tracer = Tracer(source, int(max_steps), float(max_seconds))
    result = tracer.run()
    tracer.keepalive.clear()
    return json.dumps(result)


if __name__ == "__main__" and sys.platform != "emscripten":
    # CLI for debugging traces outside the browser:
    #   python3 src/worker/tracer.py my_program.py > trace.json
    with open(sys.argv[1]) as handle:
        print(run_trace(handle.read()))
