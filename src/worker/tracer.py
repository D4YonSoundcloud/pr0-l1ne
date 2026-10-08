"""
AlgoViz tracer.

Runs user code under sys.settrace and records a snapshot of program state at
every line, call, return and exception event. The output is a JSON string in
the language-agnostic trace format described in src/trace/types.ts.

This file is plain CPython: it runs inside Pyodide in the browser, and you can
also run it directly with `python3 tracer.py some_file.py` to inspect a trace.
"""

import ast
import dis
import re
import tokenize
import inspect
import io
import json
import sys
import types
import weakref
from collections import deque

USER_FILENAME = "<user>"
MAX_ITEMS = 60          # items shown per container before truncating
MAX_REPR = 48           # characters shown for a primitive before truncating
MAX_OBJECTS = 400       # heap objects serialized per step


# Code flags for functions that can pause: generators, coroutines (async def)
# and async generators.
CO_GENERATOR = inspect.CO_GENERATOR
CO_COROUTINE = inspect.CO_COROUTINE
CO_ASYNC_GENERATOR = inspect.CO_ASYNC_GENERATOR
CO_PAUSABLE = CO_GENERATOR | CO_COROUTINE | CO_ASYNC_GENERATOR
RESUME = dis.opmap["RESUME"]
# Instructions where `await` raises StopIteration internally to deliver its
# result. Those exceptions are plumbing, not part of the user's program.
AWAIT_PLUMBING = {dis.opmap[name] for name in ("SEND", "END_SEND", "CLEANUP_THROW") if name in dis.opmap}


class StepLimitExceeded(BaseException):
    """Raised from the trace function when the step budget runs out.

    It subclasses BaseException so `except Exception:` in user code can't
    swallow it.
    """


# ---------------------------------------------------------------------------
# Static analysis: things we learn from the AST before running anything
# ---------------------------------------------------------------------------

HINT = re.compile(r"^#\s*viz\s*:(.*)$")


def collect_hints(source):
    """Every `# viz: ...` comment, with its line. Parsed by the canvas."""
    hints = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                match = HINT.match(tok.string)
                if match:
                    hints.append({"line": tok.start[0], "text": match.group(1).strip()})
    except (tokenize.TokenError, SyntaxError):
        pass  # a syntax error is reported by compile()
    return hints


def analyze(source):
    """Find loops, and which names index which containers.

    `arr[j + 1]` records {"arr": ["j"]}, so the renderer knows to draw a `j`
    pointer under `arr` (and not under every other list). `grid[i][j]`
    records {"grid": ["i"], "grid[]": ["j"]}: i picks a row, j a column.
    """
    tree = ast.parse(source, USER_FILENAME)
    lines = source.splitlines()
    loops = []
    index_names = {}

    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.While, ast.AsyncFor)) and node.body:
            body_start = min(stmt.lineno for stmt in node.body)
            body_end = max(getattr(stmt, "end_lineno", stmt.lineno) for stmt in node.body)
            header = lines[node.lineno - 1].strip() if node.lineno - 1 < len(lines) else ""
            loops.append({
                "id": "L%d" % node.lineno,
                "kind": "while" if isinstance(node, ast.While) else "for",
                "line": node.lineno,
                "bodyStart": body_start,
                "bodyEnd": body_end,
                "header": header.rstrip(":"),
            })
        if isinstance(node, ast.Subscript):
            # grid[i] records "i" under "grid". grid[i][j] also records "j"
            # under "grid[]": a name that indexes the rows of grid.
            if isinstance(node.value, ast.Name):
                key = node.value.id
            elif isinstance(node.value, ast.Subscript) and isinstance(node.value.value, ast.Name):
                key = node.value.value.id + "[]"
            else:
                continue
            names = index_names.setdefault(key, set())
            for sub in ast.walk(node.slice):
                if isinstance(sub, ast.Name):
                    names.add(sub.id)

    loops.sort(key=lambda loop: loop["line"])
    return loops, {name: sorted(subs) for name, subs in index_names.items() if subs}


# ---------------------------------------------------------------------------
# Serialization: Python values -> trace Values + heap objects
# ---------------------------------------------------------------------------

PRIMITIVE_TYPES = (bool, int, float, complex, str, bytes, type(None))
SEQUENCE_TYPES = (list, tuple, set, frozenset, deque)


def short_repr(value):
    try:
        text = repr(value)
    except Exception:  # user __repr__ can raise
        text = "<%s>" % type(value).__name__
    if len(text) > MAX_REPR:
        text = text[: MAX_REPR - 1] + "…"
    return text


PAUSABLE_OBJECTS = (types.GeneratorType, types.CoroutineType, types.AsyncGeneratorType)


def pausable_state(v):
    """A generator or coroutine's state, as a short description."""
    if isinstance(v, types.GeneratorType):
        frame, running = v.gi_frame, v.gi_running
    elif isinstance(v, types.CoroutineType):
        frame, running = v.cr_frame, v.cr_running
    else:
        frame, running = v.ag_frame, v.ag_running
    name = getattr(v, "__name__", "?")
    if frame is None:
        return "%s() finished" % name
    if running:
        return "%s() running" % name
    if frame.f_lasti <= 0 or (isinstance(v, types.GeneratorType) and inspect.getgeneratorstate(v) == "GEN_CREATED"):
        return "%s() not started" % name
    return "%s() paused at line %d" % (name, frame.f_lineno)


def is_hidden_name(name, value):
    if name.startswith("__") and name.endswith("__"):
        return True
    if isinstance(value, types.ModuleType):
        return True
    return False


class Serializer:
    """Serializes one snapshot. A fresh instance is used per step."""

    def __init__(self, keepalive, ids, on_generator=None):
        self.heap = {}
        self.keepalive = keepalive
        self.ids = ids
        self.on_generator = on_generator

    def value(self, v):
        if isinstance(v, PRIMITIVE_TYPES):
            type_name = "none" if v is None else type(v).__name__
            return {"kind": "prim", "type": type_name, "repr": short_repr(v)}
        return {"kind": "ref", "id": self.ref(v)}

    def ref(self, v):
        # Objects are numbered in the order they're first seen, so the same
        # program gets the same ids on every run. (The renderer remembers
        # where you dragged a box by its id, across live re-runs.)
        oid = self.ids.get(id(v))
        if oid is None:
            oid = "o%d" % (len(self.ids) + 1 + self.ids.get("__retired__", 0))
            key = id(v)
            self.ids[key] = oid
            if isinstance(v, PAUSABLE_OBJECTS):
                # Don't keep generators alive: a dropped generator must be
                # able to close and finish, like it would without the tracer.
                # Forget its id when it's collected, so the id can't be
                # confused with a new object.
                def forget(ids=self.ids, key=key):
                    ids.pop(key, None)
                    ids["__retired__"] = ids.get("__retired__", 0) + 1
                weakref.finalize(v, forget)
            else:
                # Keep every other object we have ever seen alive for the
                # duration of the run, so CPython can't recycle its id() for
                # another object.
                self.keepalive["obj%d" % id(v)] = v
        if oid in self.heap:
            return oid
        if len(self.heap) >= MAX_OBJECTS:
            self.heap[oid] = {"kind": "opaque", "id": oid, "typeName": type(v).__name__, "repr": "…"}
            return oid
        # Reserve the slot before recursing so cycles terminate.
        self.heap[oid] = None
        self.heap[oid] = self.describe(v, oid)
        return oid

    def items(self, iterable):
        out = []
        for index, item in enumerate(iterable):
            if index >= MAX_ITEMS:
                break
            out.append(self.value(item))
        return out

    def describe(self, v, oid):
        type_name = type(v).__name__

        if isinstance(v, SEQUENCE_TYPES):
            kind = "list"
            if isinstance(v, tuple):
                kind = "tuple"
            elif isinstance(v, (set, frozenset)):
                kind = "set"
            return {"kind": kind, "id": oid, "typeName": type_name,
                    "items": self.items(v), "length": len(v)}

        if isinstance(v, dict):
            entries = []
            for index, (key, val) in enumerate(v.items()):
                if index >= MAX_ITEMS:
                    break
                entries.append([self.value(key), self.value(val)])
            return {"kind": "dict", "id": oid, "typeName": type_name,
                    "entries": entries, "length": len(v)}

        if isinstance(v, PAUSABLE_OBJECTS):
            return {"kind": "opaque", "id": oid, "typeName": type_name, "repr": pausable_state(v)}

        if isinstance(v, types.FunctionType):
            code = v.__code__
            params = list(code.co_varnames[: code.co_argcount + code.co_kwonlyargcount])
            fields = []
            if v.__closure__:
                for name, cell in zip(code.co_freevars, v.__closure__):
                    try:
                        fields.append([name, self.value(cell.cell_contents)])
                    except ValueError:  # empty cell
                        fields.append([name, {"kind": "prim", "type": "unbound", "repr": "?"}])
            return {"kind": "function", "id": oid, "typeName": type_name,
                    "name": v.__name__, "params": params, "fields": fields, "builtin": False}

        if isinstance(v, (types.BuiltinFunctionType, types.BuiltinMethodType)):
            return {"kind": "function", "id": oid, "typeName": type_name,
                    "name": getattr(v, "__name__", "?"), "params": [], "fields": [], "builtin": True}

        if isinstance(v, type):
            return {"kind": "class", "id": oid, "typeName": "type", "name": v.__name__}

        fields = self.instance_fields(v)
        if fields is not None:
            return {"kind": "object", "id": oid, "typeName": type_name, "fields": fields}

        return {"kind": "opaque", "id": oid, "typeName": type_name, "repr": short_repr(v)}

    def instance_fields(self, v):
        if isinstance(v, (types.ModuleType, types.GeneratorType, types.MethodType)):
            return None
        attrs = None
        try:
            attrs = vars(v)
        except TypeError:
            slots = getattr(type(v), "__slots__", None)
            if slots:
                attrs = {name: getattr(v, name) for name in slots if hasattr(v, name)}
        if attrs is None:
            return None
        return [[name, self.value(val)] for name, val in attrs.items()
                if not (name.startswith("__") and name.endswith("__"))]


# ---------------------------------------------------------------------------
# The tracer
# ---------------------------------------------------------------------------

class Tracer:
    def __init__(self, source, max_steps):
        self.source = source
        self.max_steps = max_steps
        self.steps = []
        self.stdout = io.StringIO()
        self.keepalive = {}
        self.object_ids = {}
        self.frame_ids = {}
        self.frame_counter = 0
        self.loops = []
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
                del active[lid]          # left the loop
                continue
            if state is None and on_header:
                count = self.loop_instances.get((fid, lid), 0) + 1
                self.loop_instances[(fid, lid)] = count
                active[lid] = {"instance": count, "iteration": 0}
            elif state is not None and in_body and not on_header and prev == loop["line"]:
                state["iteration"] += 1

    def loop_context(self, frame_ids):
        context = []
        for fid in frame_ids:
            active = self.active_loops.get(fid, {})
            for loop in self.loops:
                state = active.get(loop["id"])
                if state is not None:
                    context.append({"frame": fid, "loop": loop["id"],
                                    "instance": state["instance"],
                                    "iteration": state["iteration"]})
        return context

    # -- recording ---------------------------------------------------------

    def record(self, frame, event, arg):
        if len(self.steps) >= self.max_steps:
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

        serializer = Serializer(self.keepalive, self.object_ids)

        def describe(fr):
            is_module = fr.f_code.co_name == "<module>"
            variables = []
            for name, val in list(fr.f_locals.items()):
                if is_hidden_name(name, val):
                    continue
                if is_module and name == "input":
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
        suspended = [dict(describe(fr), state="suspended")
                     for fid, fr in self.suspended.items() if fid not in on_stack]

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
        if event in ("return", "yield"):
            step["returnValue"] = serializer.value(arg)
        if event == "exception":
            exc_type, exc_value, _ = arg
            step["exception"] = {"type": exc_type.__name__, "message": str(exc_value)}
        self.steps.append(step)

    def trace(self, frame, event, arg):
        code = frame.f_code
        if code.co_filename != USER_FILENAME:
            return None  # don't trace library code
        fid = self.frame_id(frame)
        pausable = code.co_flags & CO_PAUSABLE
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
        elif event == "return" and pausable and frame.f_lasti >= 0 and code.co_code[frame.f_lasti] == RESUME:
            # Pausing at a yield or await looks like a return, except that the
            # frame is parked on the RESUME instruction it will continue from.
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
            if pausable and issubclass(exc_type, (StopIteration, StopAsyncIteration)) and frame.f_lasti >= 0 \
                    and code.co_code[frame.f_lasti] in AWAIT_PLUMBING:
                return self.trace
            self.unwinding.add(fid)
        if event in ("call", "line", "return", "exception", "resume", "yield", "await"):
            self.record(frame, event, arg)
        return self.trace

    # -- running -----------------------------------------------------------

    def run(self):
        result = {"version": 1, "language": "python", "steps": self.steps, "loops": [], "indexNames": {},
                  "stdout": "", "error": None, "truncated": False}
        try:
            self.loops, result["indexNames"] = analyze(self.source)
            result["loops"] = self.loops
            hints = collect_hints(self.source)
            if hints:
                result["hints"] = hints
            code = compile(self.source, USER_FILENAME, "exec")
        except SyntaxError as exc:
            result["error"] = {"type": "SyntaxError", "message": exc.msg or str(exc),
                               "line": exc.lineno}
            return result

        def no_input(*_args):
            raise RuntimeError("input() isn't supported. Hard-code your test data instead.")

        user_globals = {"__name__": "__main__", "input": no_input}
        old_stdout = sys.stdout
        sys.stdout = self.stdout
        sys.settrace(self.trace)
        try:
            exec(code, user_globals)
        except StepLimitExceeded:
            result["truncated"] = True
        except BaseException as exc:  # report every user error, including SystemExit
            result["error"] = {"type": type(exc).__name__, "message": str(exc),
                               "line": last_user_line(exc.__traceback__)}
        finally:
            sys.settrace(None)
            sys.stdout = old_stdout

        result["stdout"] = self.stdout.getvalue()
        return result


def last_user_line(tb):
    line = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == USER_FILENAME:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def run_trace(source, max_steps=2000):
    """Entry point called from the Pyodide worker. Returns a JSON string."""
    tracer = Tracer(source, int(max_steps))
    result = tracer.run()
    tracer.keepalive.clear()
    return json.dumps(result)


if __name__ == "__main__" and sys.platform != "emscripten":
    # CLI for debugging traces outside the browser:
    #   python3 src/worker/tracer.py my_program.py > trace.json
    with open(sys.argv[1]) as handle:
        print(run_trace(handle.read()))
