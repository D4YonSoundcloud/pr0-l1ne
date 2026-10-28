"""
The Python tracer.

Runs user code under sys.settrace and records a snapshot of program state at
every line, call, return and exception event. The output is a JSON string in
the language-agnostic trace format described in src/trace/types.ts.

The tracer is the settrace hooks and the run. The rest is in its own
modules: what's read from the code before it runs (analysis.py, shape.py),
how values are serialized (serialize.py), which passes of long loops are
recorded (sampling.py), where recorded steps go (steplog.py), and asyncio's
virtual clock (virtual_asyncio.py).

This is plain CPython: it runs inside Pyodide in the browser, and you can
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
from types import CodeType, FrameType
from typing import Any

from analysis import USER_FILENAME, analyze, collect_hints, last_user_line
from policy import SamplingPolicy, load_policy
from sampling import RECORD, LoopLengths, Sampler, user_frames
from serialize import CONVENTIONAL_POINTERS, MAX_ITEMS, PRIMITIVE_TYPES, Serializer, is_hidden_name
from shape import cost_analysis
from steplog import Step, StepLog
from virtual_asyncio import virtual_asyncio

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
# The events that become steps.
STEP_EVENTS = ("call", "line", "return", "exception", "resume", "yield", "await")

# Python 3.12 inlines list comprehensions into the enclosing frame. Reading
# that frame's locals from a trace function while a comprehension runs makes
# CPython warn "assigning None to unbound local" for the comprehension's
# variable. It's harmless (the trace is correct) but floods the console.
warnings.filterwarnings("ignore", message="assigning None to unbound local", category=RuntimeWarning)

CLOCK_EVERY = 1000  # events between checks of the clock


class StepLimitExceeded(BaseException):
    """Raised from the trace function when the step budget runs out.

    It subclasses BaseException so `except Exception:` in user code can't
    swallow it.
    """


class Tracer:
    def __init__(self, source: str, max_steps: int, max_seconds: float, sampling: SamplingPolicy) -> None:
        self.source = source
        self.max_seconds = max_seconds
        self.log = StepLog(max_steps)
        self.stdout = io.StringIO()
        # Every object and frame seen, kept alive for the run so CPython can't
        # reuse its id() for another (see Serializer.new_id).
        self.keepalive: dict[str, object] = {}
        self.object_ids: dict[Any, Any] = {}
        self.frame_ids: dict[int, str] = {}
        self.frame_counter = 0
        self.sampler = Sampler(self.log, self.frame_ids, sampling)
        # What print() was given since the last step: {"line", "objects"}.
        self.pending_print: dict | None = None
        # Names that index each list (analysis.analyze, plus `viz: pointers` hints).
        self.index_names: dict[str, list[str]] = {}
        # Generators and coroutines that are paused at a yield or await:
        # frame id -> frame. Shown as suspended frames until they resume.
        self.suspended: dict[str, FrameType] = {}
        # Frames with an exception propagating through them. A "return" that
        # follows is the frame exiting by exception, not pausing.
        self.unwinding: set[str] = set()
        # Everything that happens is counted, recorded or not.
        self.counts: dict[str, Any] = {"steps": 0, "calls": {}, "depth": {}}
        self.stopped_by: str | None = None
        self.deadline: float | None = None
        self.tick = CLOCK_EVERY

    @property
    def steps(self) -> list[Step]:
        return self.log.steps

    def frame_id(self, frame: FrameType) -> str:
        key = id(frame)
        if key not in self.frame_ids:
            self.frame_counter += 1
            self.frame_ids[key] = "f%d" % self.frame_counter
            self.keepalive.setdefault("frame%d" % key, frame)
        return self.frame_ids[key]

    # -- the trace hook ----------------------------------------------------

    def trace(self, frame: FrameType, event: str, arg: Any):
        """sys.settrace's hook: called on every event in the program's own code."""
        if frame.f_code.co_filename != USER_FILENAME:
            return None  # don't trace library code
        fid = self.frame_id(frame)
        prev_line = self.sampler.last_line.get(fid)
        kind = self.classify(frame, fid, event, arg)
        if kind in STEP_EVENTS:
            self.count(frame, kind)
            self.check_clock()
            where = self.sampler.place(frame, fid, kind, prev_line)
            if where == RECORD:
                self.record(frame, kind, arg)
            elif where is not None:
                self.record(frame, kind, arg, into=where)
            if kind in ("return", "yield", "await"):
                self.sampler.left(fid)
        return self.trace

    def classify(self, frame: FrameType, fid: str, event: str, arg: Any) -> str | None:
        """What the event is in the program's terms: a generator resuming, a coroutine
        awaiting... None for asyncio's own plumbing, which isn't a step."""
        if event == "line":
            self.unwinding.discard(fid)  # the exception was caught
            self.sampler.update_loops(fid, frame.f_lineno)
        elif event == "call" and fid in self.suspended:
            # A paused generator or coroutine picking up where it left off.
            del self.suspended[fid]
            return "resume"
        elif event == "return":
            return self.returned(frame, fid, arg)
        elif event == "exception":
            code = frame.f_code
            if (
                code.co_flags & CO_PAUSABLE
                and issubclass(arg[0], (StopIteration, StopAsyncIteration))
                and frame.f_lasti >= 0
                and code.co_code[frame.f_lasti] in AWAIT_PLUMBING
            ):
                return None
            self.unwinding.add(fid)
        return event

    def returned(self, frame: FrameType, fid: str, arg: Any) -> str:
        """A "return" event: a real return, or a generator or coroutine pausing."""
        code = frame.f_code
        if fid in self.unwinding:
            self.unwinding.discard(fid)
            self.suspended.pop(fid, None)
            return "return"
        if code.co_flags & CO_PAUSABLE and frame.f_lasti >= 0 and code.co_code[frame.f_lasti] in PAUSE_OPS:
            # Pausing at a yield or await looks like a return, except that the
            # frame is parked at the yield (see PAUSE_OPS) instead of a return.
            self.suspended[fid] = frame
            return self.pause_kind(code, arg)
        self.suspended.pop(fid, None)
        return "return"

    @staticmethod
    def pause_kind(code: CodeType, arg: Any) -> str:
        """A coroutine pausing awaits; an async generator awaits unless it's yielding a value."""
        if code.co_flags & CO_COROUTINE:
            return "await"
        if code.co_flags & CO_ASYNC_GENERATOR and (arg is None or hasattr(arg, "_asyncio_future_blocking")):
            return "await"
        return "yield"

    def count(self, frame: FrameType, event: str) -> None:
        """Count every step, and each call and how deep its recursion goes."""
        self.counts["steps"] += 1
        if event != "call":
            return
        code = frame.f_code
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

    def check_clock(self) -> None:
        """Every so often, stop if the run is past its time budget."""
        self.tick -= 1
        if self.tick > 0:
            return
        self.tick = CLOCK_EVERY
        if self.deadline is not None and time.perf_counter() > self.deadline:
            self.stopped_by = "time"
            raise StepLimitExceeded()

    # -- recording a step --------------------------------------------------

    def record(self, frame: FrameType, event: str, arg: Any, into: list[Step] | None = None) -> None:
        """Snapshot the program now: its stack, its heap, what it printed. Into the
        trace, or `into` a long loop's buffer of last passes."""
        if into is None and self.log.full():
            self.stopped_by = "steps"
            raise StepLimitExceeded()
        frames = user_frames(frame)
        serializer = Serializer(self.keepalive, self.object_ids, focus=self.focus_of(frames))
        stack = [self.frame_view(fr, serializer) for fr in frames]
        on_stack = {s["id"] for s in stack}
        suspended = [
            dict(self.frame_view(fr, serializer), state="suspended")
            for fid, fr in self.suspended.items()
            if fid not in on_stack
        ]
        step = {
            "event": event,
            "line": frame.f_lineno,
            "stack": stack,
            "heap": serializer.heap,
            "stdoutLength": len(self.stdout.getvalue()),
            "loops": self.sampler.loop_context([s["id"] for s in stack] + [s["id"] for s in suspended]),
        }
        if suspended:
            step["suspended"] = suspended
        if self.pending_print is not None:
            step["output"] = self.printed(serializer)
        if event in ("return", "yield"):
            step["returnValue"] = serializer.value(arg)
        if event == "exception":
            exc_type, exc_value, _ = arg
            step["exception"] = {"type": exc_type.__name__, "message": str(exc_value)}
        self.log.considered += 1
        if into is not None:
            into.append(step)
        else:
            self.log.commit(step)

    def frame_view(self, fr: FrameType, serializer: Serializer) -> dict[str, Any]:
        """One frame of the stack: its function, line and variables."""
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

    def printed(self, serializer: Serializer) -> dict[str, Any]:
        """What print() was given since the last step: the line, and the printed objects
        drawn at this step, by their ids."""
        pending = self.pending_print or {"line": None, "objects": []}
        refs = []
        for obj in pending["objects"]:
            oid = self.object_ids.get(id(obj))
            if oid in serializer.heap and oid not in refs:
                refs.append(oid)
        self.pending_print = None
        return {"line": pending["line"], "refs": refs}

    def focus_of(self, frames: list[FrameType]) -> dict[int, list[int]]:
        """Long lists' index variables: id(list) -> their values, innermost frame first."""
        focus = {}
        if not self.index_names:
            return focus
        for fr in reversed(frames):
            local = fr.f_locals
            for name, val in list(local.items()):
                if type(val) not in (list, tuple) or len(val) <= MAX_ITEMS or id(val) in focus:
                    continue
                indices = self.indices_into(val, self.index_names.get(name), local)
                if indices:
                    focus[id(val)] = indices
        return focus

    @staticmethod
    def indices_into(val: list | tuple, subs: list[str] | None, local: dict[str, Any]) -> list[int]:
        """The values of the names that index this list (and conventional pointers), where they're in range."""
        if not subs:
            return []
        indices = []
        for sub in set(subs).union(c for c in CONVENTIONAL_POINTERS if c in local):
            x = local.get(sub)
            if type(x) is int and 0 <= x <= len(val):
                indices.append(x)
        return indices

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

    def run(self) -> dict[str, Any]:
        """Trace the program: read it, run it under the hook, and return the trace."""
        result: dict[str, Any] = {
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
        code = self.prepare(result)
        if code is None:
            return result
        with virtual_asyncio("asyncio" in self.source):
            self.execute(code, result)
        result["stdout"] = self.stdout.getvalue()
        result["counts"] = self.counts
        if self.sampler.sampled:
            result["sampled"] = True
        self.log.finish()
        return result

    def prepare(self, result: dict[str, Any]) -> CodeType | None:
        """Read the program before it runs (its loops, index names, hints and shape),
        and compile it with its loops reporting their lengths. None if it doesn't
        parse; the error is in the result."""
        try:
            loops, result["indexNames"], accesses = analyze(self.source)
            self.sampler.loops = loops
            if accesses:
                result["gridAccesses"] = accesses
            result["loops"] = loops
            hints = collect_hints(self.source)
            if hints:
                result["hints"] = hints
            self.index_names = with_pointer_hints(result["indexNames"], hints)
            try:
                result["cost"] = cost_analysis(ast.parse(self.source, USER_FILENAME))
            except Exception:  # a guess about the code's shape must never stop a run
                pass
            tree = LoopLengths().visit(ast.parse(self.source, USER_FILENAME))
            return compile(ast.fix_missing_locations(tree), USER_FILENAME, "exec")
        except SyntaxError as exc:
            result["error"] = {"type": "SyntaxError", "message": exc.msg or str(exc), "line": exc.lineno}
            return None

    def execute(self, code: CodeType, result: dict[str, Any]) -> None:
        """Run the compiled program under the trace hook, with its output captured."""

        def no_input(*_args):
            raise RuntimeError("input() isn't supported. Hard-code your test data instead.")

        user_globals = {
            "__name__": "__main__",
            "input": no_input,
            "print": self.make_print(),
            "__viz_len__": self.sampler.loop_length,
        }
        old_stdout = sys.stdout
        sys.stdout = self.stdout
        self.deadline = time.perf_counter() + self.max_seconds
        sys.settrace(self.trace)
        try:
            exec(code, user_globals)
            self.sampler.settle_tail(())
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


def with_pointer_hints(index_names: dict[str, list[str]], hints: list[dict[str, Any]]) -> dict[str, list[str]]:
    """The names that index each list, with those a `viz: pointers nums: lo, hi` hint adds.

    The ends of a `viz: window nums: [left, right]` hint that are just a name
    count too, so a long list shows the part around them.
    """
    out = dict(index_names)
    for hint in hints:
        m = re.match(r"(pointers|window)\s+([\w.]+(?:\[\])?)\s*:\s*(.+)$", hint["text"])
        if m:
            ends = [re.sub(r"^[\[(]\s*|\s*[\])]$", "", n.strip()) for n in m.group(3).split(",")]
            if m.group(1) == "window":
                extra = [n for n in ends if re.fullmatch(r"[A-Za-z_]\w*", n)]
            else:
                extra = [n for n in ends if n]
            out[m.group(2)] = sorted(set(out.get(m.group(2), [])) | set(extra))
    return out


def run_trace(
    source: str,
    max_steps: int = 2000,
    max_seconds: float | None = None,
    sampling: str | SamplingPolicy | None = None,
) -> str:
    """Entry point called from the Pyodide worker. Returns a JSON string.

    The worker passes the run's time limit and sampling rules (sampling as
    JSON). Left out, as from the CLI or a test, they're the policy in
    fixtures/policy.json: how long a Run may take, and how it samples.
    """
    if max_seconds is None or sampling is None:
        policy = load_policy()
        max_seconds = policy["runSeconds"] if max_seconds is None else max_seconds
        sampling = policy["sampling"] if sampling is None else sampling
    rules: SamplingPolicy = json.loads(sampling) if isinstance(sampling, str) else sampling
    tracer = Tracer(source, int(max_steps), float(max_seconds), rules)
    result = tracer.run()
    tracer.keepalive.clear()
    return json.dumps(result)


if __name__ == "__main__" and sys.platform != "emscripten":
    # CLI for debugging traces outside the browser:
    #   python3 src/worker/tracer.py my_program.py > trace.json
    with open(sys.argv[1]) as handle:
        print(run_trace(handle.read()))
