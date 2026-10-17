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

from sizes import size64
from tracer import USER_FILENAME, virtual_loop_policy

POLL_EVERY = 5000  # loop passes and calls between clock checks
PROGRESS_EVERY = 0.25  # seconds between progress reports
PLAIN_RUN_UNDER = 5.0  # seconds: time the untouched program only if counting took less
PEAK_RUN_UNDER = 0.25  # seconds: tracking every allocation costs ~25-80x, so only for quick programs
HELD_OBJECTS = 2_000_000  # objects walked when adding up what the variables hold
MAX_OUTPUT = 100_000  # characters of output kept

SEQUENCES = (list, tuple, str, bytes, bytearray)


class MeasureLimit(BaseException):
    """The time limit ran out. A BaseException, so `except Exception` can't catch it."""


class CappedOutput(io.TextIOBase):
    """stdout that keeps the first MAX_OUTPUT characters and counts the rest."""

    def __init__(self):
        self.parts = []
        self.size = 0
        self.dropped = 0

    def write(self, text):
        room = MAX_OUTPUT - self.size
        if room > 0:
            self.parts.append(text[:room])
            self.size += min(room, len(text))
        if len(text) > room:
            self.dropped += len(text) - max(room, 0)
        return len(text)

    def getvalue(self):
        return "".join(self.parts)


# ---------------------------------------------------------------------------
# Rewriting the program
# ---------------------------------------------------------------------------


def _pure(node):
    """Safe to evaluate twice: names, attributes of names, constants, simple arithmetic."""
    if isinstance(node, (ast.Name, ast.Constant)):
        return True
    if isinstance(node, ast.Attribute):
        return _pure(node.value)
    if isinstance(node, ast.UnaryOp):
        return _pure(node.operand)
    if isinstance(node, ast.BinOp):
        return _pure(node.left) and _pure(node.right)
    return False


def _name(id_, ctx=None):
    return ast.Name(id=id_, ctx=ctx or ast.Load())


def _count(array, line, amount=1):
    """array[line] += amount"""
    return ast.AugAssign(
        target=ast.Subscript(value=_name(array), slice=ast.Constant(line), ctx=ast.Store()),
        op=ast.Add(),
        value=ast.Constant(amount),
    )


def _poll():
    """_mt[0] -= 1; if _mt[0] < 0: _mpoll()"""
    tick = ast.AugAssign(
        target=ast.Subscript(value=_name("_mt"), slice=ast.Constant(0), ctx=ast.Store()),
        op=ast.Sub(),
        value=ast.Constant(1),
    )
    check = ast.If(
        test=ast.Compare(
            left=ast.Subscript(value=_name("_mt"), slice=ast.Constant(0), ctx=ast.Load()),
            ops=[ast.Lt()],
            comparators=[ast.Constant(0)],
        ),
        body=[ast.Expr(ast.Call(func=_name("_mpoll"), args=[], keywords=[]))],
        orelse=[],
    )
    return [tick, check]


def _call(fn, *args):
    return ast.Call(func=_name(fn), args=list(args), keywords=[])


def _before(work, expr):
    """(work or expr): run the bookkeeping call (which returns None), then the real expression."""
    return ast.BoolOp(op=ast.Or(), values=[work, expr])


# Methods whose cost is the receiver's length, and how to describe it.
METHOD_WORK = {"insert": "m", "index": "s", "count": "s", "remove": "m", "reverse": "m", "copy": "c"}
# Built-ins that walk a whole collection they're given.
FUNCTION_WORK = {
    "sorted": "o",
    "sum": "s",
    "min": "s",
    "max": "s",
    "any": "s",
    "all": "s",
    "list": "c",
    "tuple": "c",
    "set": "c",
    "frozenset": "c",
    "dict": "c",
}


class Counters(ast.NodeTransformer):
    def __init__(self):
        self.lines = set()

    # -- statements -----------------------------------------------------------

    def body(self, stmts, loop_line=None, function=False, def_line=None):
        out = []
        if def_line is not None:
            out.append(_count("_mf", def_line))  # a call
        if loop_line is not None:
            out.append(_count("_mp", loop_line))
        if loop_line is not None or function:
            out.extend(_poll())
        for stmt in stmts:
            stmt = self.visit(stmt)
            if isinstance(stmt, ast.ImportFrom) and stmt.module == "__future__":
                out.append(stmt)
                continue
            self.lines.add(stmt.lineno)
            out.append(_count("_mc", stmt.lineno))
            out.append(stmt)
        return out

    def generic_visit(self, node):
        super().generic_visit(node)
        for field in ("body", "orelse", "finalbody"):
            stmts = getattr(node, field, None)
            if (
                isinstance(stmts, list)
                and stmts
                and isinstance(stmts[0], ast.stmt)
                and not isinstance(node, ast.Module)
            ):
                if isinstance(node, (ast.For, ast.AsyncFor, ast.While)) and field == "body":
                    continue  # done in visit_For / visit_While
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and field == "body":
                    continue
                setattr(node, field, self.wrap_existing(stmts))
        if isinstance(node, ast.ExceptHandler) or isinstance(node, getattr(ast, "match_case", ())):
            pass
        return node

    def wrap_existing(self, stmts):
        """Add counters to an already-visited statement list."""
        out = []
        for stmt in stmts:
            if not (
                isinstance(stmt, ast.AugAssign)
                and isinstance(stmt.target, ast.Subscript)
                and isinstance(stmt.target.value, ast.Name)
                and stmt.target.value.id in ("_mc", "_mp", "_mf", "_mt")
            ):
                self.lines.add(stmt.lineno)
                out.append(_count("_mc", stmt.lineno))
            out.append(stmt)
        return out

    def visit_Module(self, node):
        node.body = self.body(node.body)
        return node

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef):
        node.decorator_list = [self.visit(d) for d in node.decorator_list]
        node.args = self.visit(node.args)
        node.body = self.body(node.body, function=True, def_line=node.lineno)
        return node

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):  # counted as a def is
        return self.visit_FunctionDef(node)

    def visit_For(self, node: ast.For | ast.AsyncFor):
        line = node.lineno
        node.target = self.visit(node.target)
        node.iter = ast.copy_location(_call("_miter", ast.Constant(line), self.visit(node.iter)), node.iter)
        node.body = self.body(node.body, loop_line=line)
        node.orelse = self.wrap_existing([self.visit(s) for s in node.orelse])
        return node

    def visit_AsyncFor(self, node: ast.AsyncFor):  # counted as a for is
        return self.visit_For(node)

    def visit_While(self, node):
        node.test = self.visit(node.test)
        node.body = self.body(node.body, loop_line=node.lineno)
        node.orelse = self.wrap_existing([self.visit(s) for s in node.orelse])
        return node

    # Every other compound statement (if, with, try, match, class): count
    # the statements in each of its blocks.
    def visit_If(self, node):
        node.test = self.visit(node.test)
        node.body = self.wrap_existing([self.visit(s) for s in node.body])
        node.orelse = self.wrap_existing([self.visit(s) for s in node.orelse])
        return node

    def visit_ClassDef(self, node):
        node.bases = [self.visit(b) for b in node.bases]
        node.body = self.wrap_existing([self.visit(s) for s in node.body])
        return node

    # -- expressions: work inside built-ins ------------------------------------

    def visit_Call(self, node):
        self.generic_visit(node)
        line = node.lineno
        func = node.func
        if isinstance(func, ast.Attribute) and _pure(func.value):
            name = func.attr
            if name in METHOD_WORK or (name == "pop" and node.args and not _is_minus_one(node.args[0])):
                kind = "m" if name == "pop" else METHOD_WORK[name]
                return ast.copy_location(
                    _before(_call("_mw", ast.Constant(line), func.value, ast.Constant(kind)), node), node
                )
            if name == "sort":
                return ast.copy_location(
                    _before(_call("_mw", ast.Constant(line), func.value, ast.Constant("o")), node), node
                )
            if name in ("extend", "join") and len(node.args) == 1 and _pure(node.args[0]):
                return ast.copy_location(
                    _before(_call("_mw", ast.Constant(line), node.args[0], ast.Constant("c")), node), node
                )
        if isinstance(func, ast.Name) and func.id in FUNCTION_WORK and len(node.args) == 1 and _pure(node.args[0]):
            return ast.copy_location(
                _before(_call("_mw", ast.Constant(line), node.args[0], ast.Constant(FUNCTION_WORK[func.id])), node),
                node,
            )
        return node

    def visit_Compare(self, node):
        self.generic_visit(node)
        if len(node.ops) == 1 and isinstance(node.ops[0], (ast.In, ast.NotIn)) and _pure(node.comparators[0]):
            work = _call("_mw", ast.Constant(node.lineno), node.comparators[0], ast.Constant("s"))
            return ast.copy_location(_before(work, node), node)
        return node

    def visit_Subscript(self, node):
        self.generic_visit(node)
        sl = node.slice
        if (
            isinstance(node.ctx, ast.Load)
            and isinstance(sl, ast.Slice)
            and _pure(node.value)
            and all(part is None or _pure(part) for part in (sl.lower, sl.upper, sl.step))
        ):
            parts = [part if part is not None else ast.Constant(None) for part in (sl.lower, sl.upper, sl.step)]
            work = _call("_mslice", ast.Constant(node.lineno), node.value, *parts)
            return ast.copy_location(_before(work, node), node)
        return node

    # Comprehensions are loops too: count their passes when the iterable has a length.
    def visit_comprehension(self, node):
        self.generic_visit(node)
        node.iter = ast.copy_location(_call("_mcomp", ast.Constant(node.iter.lineno), node.iter), node.iter)
        return node


def _is_minus_one(node):
    return (
        isinstance(node, ast.UnaryOp)
        and isinstance(node.op, ast.USub)
        and isinstance(node.operand, ast.Constant)
        and node.operand.value == 1
    )


def apply_overrides(tree, overrides):
    """Growth runs (`viz: size n`): set a top-level `n = <integer>` to another size."""
    if not overrides:
        return tree
    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            target, value = stmt.targets[0], stmt.value
        elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
            target, value = stmt.target, stmt.value
        else:
            continue
        if (
            isinstance(target, ast.Name)
            and target.id in overrides
            and isinstance(value, ast.Constant)
            and type(value.value) is int
        ):
            value.value = int(overrides[target.id])
    return tree


def instrument(source, overrides=None):
    tree = apply_overrides(ast.parse(source, USER_FILENAME), overrides)
    counters = Counters()
    tree = counters.visit(tree)
    ast.fix_missing_locations(tree)
    return tree, counters.lines


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


def _line_of(tb):
    line = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == USER_FILENAME:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def _no_input(*_args):
    raise RuntimeError("input() isn't supported. Hard-code your test data instead.")


class Measure:
    def __init__(self, source, limit_ms, report=None, overrides=None):
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

    def poll(self):
        self.tick[0] = POLL_EVERY
        now = time.perf_counter()
        if now - self.started > self.limit:
            self.tick[0] = -1  # keep failing fast if something catches it
            raise MeasureLimit()
        if self.report and now - self.last_report >= PROGRESS_EVERY:
            self.last_report = now
            self.report(json.dumps(self.progress(now)))

    def iterate(self, line, it):
        try:
            self.totals[line] = len(it)
            self.order += 1
            self.entered[line] = (self.passes[line], self.order)
        except TypeError:
            pass
        return it

    def comprehension(self, line, it):
        try:
            self.passes[line] += len(it)
        except TypeError:
            pass
        return it

    def add_work(self, line, value, kind):
        if isinstance(value, SEQUENCES) or type(value).__name__ == "deque":
            n = len(value)
        else:
            return None  # sets and dicts are hashed: O(1), or not something we can size
        if kind == "o":
            n = int(n * max(1.0, math.log2(n))) if n > 1 else n
        self.work[line] = self.work.get(line, 0) + n
        self.work_kind.setdefault(line, kind)
        return None

    def slice_work(self, line, value, lower, upper, step):
        if isinstance(value, SEQUENCES):
            n = len(range(*slice(lower, upper, step).indices(len(value))))
            self.work[line] = self.work.get(line, 0) + n
            self.work_kind.setdefault(line, "c")
        return None

    # -- results ---------------------------------------------------------------

    def outermost(self):
        """The loop running that started first: the one whose progress is the run's progress."""
        best = None
        for line, total in self.totals.items():
            at_entry, order = self.entered.get(line, (0, 0))
            done = self.passes[line] - at_entry
            if total and done < total and (best is None or order < best[3]):
                best = (line, done, total, order)
        return best

    def progress(self, now):
        loop = self.outermost()
        out = {"elapsedMs": round((now - self.started) * 1000)}
        if loop:
            out["loop"] = {"line": loop[0], "done": loop[1], "total": loop[2]}
        return out

    def run(self):
        result = {
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
            tree, _lines = instrument(self.source, self.overrides)
            code = compile(tree, USER_FILENAME, "exec")
        except SyntaxError as exc:
            result["status"] = "error"
            result["error"] = {"type": "SyntaxError", "message": exc.msg or str(exc), "line": exc.lineno}
            return result

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

        # The honest time: the untouched program, if it's quick enough to run twice.
        if status == "done" and elapsed < PLAIN_RUN_UNDER:
            plain = compile(
                apply_overrides(ast.parse(self.source, USER_FILENAME), self.overrides), USER_FILENAME, "exec"
            )
            env = {"__name__": "__main__", "input": _no_input}
            p_status, _e, p_elapsed, _p, _s = self._execute(plain, env, CappedOutput(), memory=False)
            if p_status == "done":
                result["plainMs"] = round(p_elapsed * 1000, 2)
                if p_elapsed < PEAK_RUN_UNDER:
                    env = {"__name__": "__main__", "input": _no_input}
                    m_status, _e, _t, peak, _s = self._execute(plain, env, CappedOutput(), memory=True)
                    if m_status == "done" and peak is not None:
                        result["peakBytes"] = _to_64_bit(peak)
        return result

    def _execute(self, code, env, out, memory):
        old_stdout = sys.stdout
        sys.stdout = out
        uses_asyncio = "asyncio" in self.source
        if uses_asyncio:
            import asyncio

            # asyncio's private policy and running-loop slots (see virtual_loop_policy).
            saved = (
                asyncio.events._event_loop_policy,  # pyright: ignore[reportAttributeAccessIssue]
                asyncio.run,
                asyncio.events._get_running_loop(),
            )
            asyncio.set_event_loop_policy(virtual_loop_policy())
            asyncio.run = asyncio.runners.run
            asyncio.events._set_running_loop(None)
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
            error = {"type": type(exc).__name__, "message": str(exc), "line": _line_of(exc.__traceback__)}
        elapsed = time.perf_counter() - self.started
        peak = None
        if tracemalloc is not None:
            try:
                peak = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
        sys.stdout = old_stdout
        if uses_asyncio:
            # Put asyncio's private policy slot back (see virtual_loop_policy).
            policy, asyncio.run, running = saved
            asyncio.events._event_loop_policy = policy  # pyright: ignore[reportAttributeAccessIssue]
            asyncio.events._set_running_loop(running)
        return status, error, elapsed, peak, stopped_at


def _to_64_bit(n):
    """tracemalloc's bytes on a 32-bit Python (the browser's), roughly as a 64-bit one would use."""
    return n * 2 if sys.maxsize < 2**32 else n


def held_bytes(env):
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


def run_measure(source: str, limit_ms: float = 20000, report=None, overrides_json: str | None = None) -> str:
    """Entry point for the worker. `report(json)` gets progress. `overrides_json`:
    {"n": 625} sets top-level sizes (growth runs). Returns a JSON string."""
    overrides = json.loads(overrides_json) if overrides_json else None
    return json.dumps(Measure(source, float(limit_ms), report, overrides).run())


if __name__ == "__main__" and sys.platform != "emscripten":
    with open(sys.argv[1]) as handle:
        print(run_measure(handle.read(), float(sys.argv[2]) if len(sys.argv) > 2 else 20000))
