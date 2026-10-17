"""
PR0L1NE measure: run a program at full size with counters instead of a trace.

A trace snapshots everything at every step, which caps it at a few thousand
steps. Measure runs the whole program and only counts:

  lines   how many times each line ran
  passes  how many times each loop's body ran
  work    items moved, scanned, copied or sorted inside built-ins that aren't
          O(1) (list.insert, list.pop(0), x in list, slices, sorted, ...),
          which a line count alone would hide
  totals  how many passes a loop will make, when it's known at the start
          (for i in range(k)), for progress and for estimating a run that's
          stopped at the time limit

The counters are added by rewriting the program's syntax tree (an
ast.NodeTransformer), not with sys.settrace: a trace function runs Python
code on every line, which is about 100x slower; a counter is one indexed
add. Line numbers are kept, so errors point at the right line.

Then, if the counted run was quick, the original program runs once more
untouched, for an honest time, and if that was very quick, once more with
tracemalloc for its peak memory (tracemalloc is far too slow to leave on:
25 to 80 times slower). Otherwise memory is what the program's variables
hold at the end, added up with the same 64-bit sizes as the Sizes view.
"""

import ast
import io
import json
import math
import sys
import time
from collections.abc import Callable
from types import CodeType
from typing import Any

from analysis import USER_FILENAME, last_user_line
from counters import apply_overrides, instrument
from policy import load_policy
from sizes import size64
from virtual_asyncio import virtual_asyncio

POLL_EVERY = 5000  # loop passes and calls between clock checks
PROGRESS_EVERY = 0.25  # seconds between progress reports
PLAIN_RUN_UNDER = 5.0  # seconds: time the untouched program only if counting took less
PEAK_RUN_UNDER = 0.25  # seconds: tracking every allocation costs ~25-80x, so only for quick programs
HELD_OBJECTS = 2_000_000  # objects walked when adding up what the variables hold
MAX_OUTPUT = 100_000  # characters of output kept

SEQUENCES = (list, tuple, str, bytes, bytearray)

# What one run gives: its status ("done", "limit" or "error"), the error, how
# long it took (seconds), its peak memory (when tracked) and how far it got
# (when stopped at the limit).
RunOutcome = tuple[str, dict[str, Any] | None, float, int | None, dict[str, Any] | None]


class MeasureLimit(BaseException):
    """The time limit ran out. A BaseException, so `except Exception` can't catch it."""


class CappedOutput(io.TextIOBase):
    """stdout that keeps the first MAX_OUTPUT characters and counts the rest."""

    def __init__(self) -> None:
        self.parts = []
        self.size = 0
        self.dropped = 0

    def write(self, text: str) -> int:
        room = MAX_OUTPUT - self.size
        if room > 0:
            self.parts.append(text[:room])
            self.size += min(room, len(text))
        if len(text) > room:
            self.dropped += len(text) - max(room, 0)
        return len(text)

    def getvalue(self) -> str:
        return "".join(self.parts)


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


def _no_input(*_args: object) -> None:
    raise RuntimeError("input() isn't supported. Hard-code your test data instead.")


class Measure:
    def __init__(
        self,
        source: str,
        limit_ms: float,
        report: Callable[[str], None] | None = None,
        overrides: dict[str, int] | None = None,
    ) -> None:
        self.source = source
        self.overrides = overrides or {}
        self.limit = max(0.5, limit_ms / 1000)
        self.report = report
        size = source.count("\n") + 2
        self.counts = [0] * size  # _mc: per line
        self.passes = [0] * size  # _mp: per loop line
        self.calls = [0] * size  # _mf: per function (def line)
        self.tick = [POLL_EVERY]  # _mt
        self.work = {}  # line -> items
        self.work_kind = {}  # line -> m / s / c / o
        self.totals = {}  # loop line -> passes it will make
        self.entered = {}  # loop line -> (passes at entry, entry order)
        self.order = 0
        self.started = 0.0
        self.last_report = 0.0

    # -- the helpers the rewritten program calls -------------------------------

    def poll(self) -> None:
        self.tick[0] = POLL_EVERY
        now = time.perf_counter()
        if now - self.started > self.limit:
            self.tick[0] = -1  # keep failing fast if something catches it
            raise MeasureLimit()
        if self.report and now - self.last_report >= PROGRESS_EVERY:
            self.last_report = now
            self.report(json.dumps(self.progress(now)))

    def iterate(self, line: int, it: Any) -> Any:
        try:
            self.totals[line] = len(it)
            self.order += 1
            self.entered[line] = (self.passes[line], self.order)
        except TypeError:
            pass
        return it

    def comprehension(self, line: int, it: Any) -> Any:
        try:
            self.passes[line] += len(it)
        except TypeError:
            pass
        return it

    def add_work(self, line: int, value: Any, kind: str) -> None:
        if isinstance(value, SEQUENCES) or type(value).__name__ == "deque":
            n = len(value)
        else:
            return None  # sets and dicts are hashed: O(1), or not something we can size
        if kind == "o":
            n = int(n * max(1.0, math.log2(n))) if n > 1 else n
        self.work[line] = self.work.get(line, 0) + n
        self.work_kind.setdefault(line, kind)
        return None

    def slice_work(self, line: int, value: Any, lower: Any, upper: Any, step: Any) -> None:
        if isinstance(value, SEQUENCES):
            n = len(range(*slice(lower, upper, step).indices(len(value))))
            self.work[line] = self.work.get(line, 0) + n
            self.work_kind.setdefault(line, "c")
        return None

    # -- results ---------------------------------------------------------------

    def outermost(self) -> tuple[int, int, int, int] | None:
        """The loop running that started first: the one whose progress is the run's progress."""
        best = None
        for line, total in self.totals.items():
            at_entry, order = self.entered.get(line, (0, 0))
            done = self.passes[line] - at_entry
            if total and done < total and (best is None or order < best[3]):
                best = (line, done, total, order)
        return best

    def progress(self, now: float) -> dict[str, Any]:
        loop = self.outermost()
        out: dict[str, Any] = {"elapsedMs": round((now - self.started) * 1000)}
        if loop:
            out["loop"] = {"line": loop[0], "done": loop[1], "total": loop[2]}
        return out

    def run(self) -> dict[str, Any]:
        """Measure the program: a counted run, then, if that was quick, the untouched
        program for an honest time (and, if very quick, its peak memory)."""
        result: dict[str, Any] = {
            "status": "done",
            "lines": {},
            "passes": {},
            "calls": {},
            "work": {},
            "workKind": {},
            "totals": {},
            "ms": 0,
            "plainMs": None,
            "peakBytes": None,
            "heldBytes": None,
            "stdout": "",
            "droppedOutput": 0,
            "error": None,
        }
        try:
            code = compile(instrument(self.source, self.overrides), USER_FILENAME, "exec")
        except SyntaxError as exc:
            result["status"] = "error"
            result["error"] = {"type": "SyntaxError", "message": exc.msg or str(exc), "line": exc.lineno}
            return result
        elapsed = self.counted_run(code, result)
        if result["status"] == "done" and elapsed < PLAIN_RUN_UNDER:
            self.timed_runs(result)
        return result

    def counted_run(self, code: CodeType, result: dict[str, Any]) -> float:
        """Run the program with its counters, and put the counts in the result. Returns how long it took."""
        out = CappedOutput()
        env = {
            "__name__": "__main__",
            "input": _no_input,
            "_mc": self.counts,
            "_mp": self.passes,
            "_mf": self.calls,
            "_mt": self.tick,
            "_mpoll": self.poll,
            "_miter": self.iterate,
            "_mcomp": self.comprehension,
            "_mw": self.add_work,
            "_mslice": self.slice_work,
        }
        status, error, elapsed, _peak, stopped_at = self._execute(code, env, out, memory=False)
        result["status"], result["error"] = status, error
        result["ms"] = round(elapsed * 1000, 2)
        result["heldBytes"] = held_bytes(env)
        if status == "limit":
            result["stoppedAt"] = stopped_at
        result["lines"] = {str(i): c for i, c in enumerate(self.counts) if c}
        result["passes"] = {str(i): c for i, c in enumerate(self.passes) if c}
        result["calls"] = {str(i): c for i, c in enumerate(self.calls) if c}
        result["work"] = {str(k): v for k, v in self.work.items() if v}
        result["workKind"] = {str(k): v for k, v in self.work_kind.items() if k in self.work}
        result["totals"] = {str(k): v for k, v in self.totals.items()}
        result["stdout"] = out.getvalue()
        result["droppedOutput"] = out.dropped
        return elapsed

    def timed_runs(self, result: dict[str, Any]) -> None:
        """The honest time: the untouched program, quick enough to run again. And if it's
        very quick, once more with tracemalloc, for its peak memory."""
        plain = compile(apply_overrides(ast.parse(self.source, USER_FILENAME), self.overrides), USER_FILENAME, "exec")
        env = {"__name__": "__main__", "input": _no_input}
        p_status, _e, p_elapsed, _p, _s = self._execute(plain, env, CappedOutput(), memory=False)
        if p_status != "done":
            return
        result["plainMs"] = round(p_elapsed * 1000, 2)
        if p_elapsed < PEAK_RUN_UNDER:
            env = {"__name__": "__main__", "input": _no_input}
            m_status, _e, _t, peak, _s = self._execute(plain, env, CappedOutput(), memory=True)
            if m_status == "done" and peak is not None:
                result["peakBytes"] = _to_64_bit(peak)

    def _execute(self, code: CodeType, env: dict[str, Any], out: CappedOutput, memory: bool) -> RunOutcome:
        with virtual_asyncio("asyncio" in self.source):
            return self._execute_counted(code, env, out, memory)

    def _execute_counted(self, code: CodeType, env: dict[str, Any], out: CappedOutput, memory: bool) -> RunOutcome:
        old_stdout = sys.stdout
        sys.stdout = out
        tracemalloc = None
        if memory:
            try:
                import tracemalloc

                tracemalloc.start()
            except Exception:  # not available: no memory figure
                tracemalloc = None
        status, error, stopped_at = "done", None, None
        self.started = time.perf_counter()
        self.last_report = self.started
        try:
            exec(code, env)
        except MeasureLimit:
            status = "limit"
            stopped_at = self.progress(time.perf_counter())
        except BaseException as exc:  # report every program error, including SystemExit
            status = "error"
            error = {"type": type(exc).__name__, "message": str(exc), "line": last_user_line(exc.__traceback__)}
        elapsed = time.perf_counter() - self.started
        peak = None
        if tracemalloc is not None:
            try:
                peak = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        sys.stdout = old_stdout
        return status, error, elapsed, peak, stopped_at


def _to_64_bit(n: int) -> int:
    """tracemalloc's bytes on a 32-bit Python (the browser's), roughly as a 64-bit one would use."""
    return n * 2 if sys.maxsize < 2**32 else n


def held_bytes(env: dict[str, Any]) -> int:
    """What the program's variables hold, counting each object once (64-bit sizes)."""
    import types

    skip = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType, type, types.CodeType)
    seen = set()
    total = 0
    stack = [v for k, v in env.items() if not k.startswith("_m") and not k.startswith("__") and k != "input"]
    while stack and len(seen) < HELD_OBJECTS:
        obj = stack.pop()
        if isinstance(obj, skip) or id(obj) in seen:
            continue
        seen.add(id(obj))
        try:
            total += size64(obj) or sys.getsizeof(obj)
        except Exception:
            continue
        if isinstance(obj, dict):
            stack.extend(obj.keys())
            stack.extend(obj.values())
        elif isinstance(obj, (list, tuple, set, frozenset)) or type(obj).__name__ == "deque":
            stack.extend(obj)
        elif hasattr(obj, "__dict__") and isinstance(getattr(obj, "__dict__", None), dict):
            stack.append(obj.__dict__)
    return total


def run_measure(
    source: str,
    limit_ms: float | None = None,
    report: Callable[[str], None] | None = None,
    overrides_json: str | None = None,
) -> str:
    """Entry point for the worker. `report(json)` gets progress. `overrides_json`:
    {"n": 625} sets top-level sizes (growth runs). Returns a JSON string.
    The worker always passes the limit; left out, it's the policy's (fixtures/policy.json)."""
    if limit_ms is None:
        limit_ms = load_policy()["measureMs"]
    overrides = json.loads(overrides_json) if overrides_json else None
    return json.dumps(Measure(source, float(limit_ms), report, overrides).run())


if __name__ == "__main__" and sys.platform != "emscripten":
    with open(sys.argv[1]) as handle:
        print(run_measure(handle.read(), float(sys.argv[2]) if len(sys.argv) > 2 else None))
