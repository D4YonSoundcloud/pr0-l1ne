"""
Serialization: Python values -> trace values and heap objects (the trace
format in src/trace/types.ts).

A primitive (int, str, None...) is a value written inline; anything else is
a reference to a heap object, numbered in the order it's first seen. A
Serializer serializes one snapshot of the program; the tracer makes a fresh
one per step, sharing the ids so an object keeps its id across steps.
"""

import inspect
import types
import weakref
from collections import deque
from itertools import islice
from typing import Any

from sizes import list_capacity, size64

MAX_ITEMS = 60  # items shown per container before truncating
MAX_REPR = 48  # characters shown for a primitive before truncating
MAX_OBJECTS = 400  # heap objects serialized per step

PRIMITIVE_TYPES = (bool, int, float, complex, str, bytes, type(None))
SEQUENCE_TYPES = (list, tuple, set, frozenset, deque)
PAUSABLE_OBJECTS = (types.GeneratorType, types.CoroutineType, types.AsyncGeneratorType)

# A trace value ({"kind": "prim", ...} or {"kind": "ref", "id": ...}) and a
# heap object ({"kind": "list", "id": ..., ...}), as in src/trace/types.ts.
Value = dict[str, Any]
HeapObject = dict[str, Any]

# Long lists: the cells shown follow the index variables (a window of
# MAX_ITEMS), and a strip of evenly spaced samples shows the whole list.
STRIP_SAMPLES = 256
# Names that conventionally hold an index (as render/draw.ts's pointersFor).
CONVENTIONAL_POINTERS = ("lo", "hi", "low", "high", "left", "right", "l", "r", "start", "end", "mid", "slow", "fast")


def short_repr(value: object) -> str:
    try:
        text = repr(value)
    except Exception:  # user __repr__ can raise
        text = "<%s>" % type(value).__name__
    if len(text) > MAX_REPR:
        text = text[: MAX_REPR - 1] + "…"
    return text


def pausable_state(v: Any) -> str:
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
    if frame.f_lasti <= 0 or pause_state(v) in ("GEN_CREATED", "CORO_CREATED", "AGEN_CREATED"):
        return "%s() not started" % name
    return "%s() paused at line %d" % (name, frame.f_lineno)


def pause_state(v: Any) -> str:
    """inspect's state for a generator, coroutine or async generator ("GEN_CREATED"...).
    Asked rather than worked out from the frame: where a new one's frame
    starts differs between Python versions (3.13 starts past 0)."""
    if isinstance(v, types.GeneratorType):
        return inspect.getgeneratorstate(v)
    if isinstance(v, types.CoroutineType):
        return inspect.getcoroutinestate(v)
    return inspect.getasyncgenstate(v)


def is_hidden_name(name: str, value: object) -> bool:
    if name.startswith("__") and name.endswith("__"):
        return True
    if isinstance(value, types.ModuleType):
        return True
    return False


def window_start(indices: list[int], length: int) -> int:
    """Where the window of MAX_ITEMS cells starts, to show these indices.
    Moves in steps of 10, so it doesn't shift on every step."""
    lo, hi = min(indices), max(indices)
    center = (lo + hi) // 2 if hi - lo < MAX_ITEMS - 4 else lo
    start = max(0, center - MAX_ITEMS // 2)
    start = (start // 10) * 10
    return max(0, min(start, length - MAX_ITEMS))


def strip_of(seq: Any) -> dict[str, Any] | None:
    """Evenly spaced samples of a long list of numbers, or None if it holds anything else."""
    n = len(seq)
    count = min(STRIP_SAMPLES, n)
    values = []
    for i in range(count):
        x = seq[(i * n) // count]
        if type(x) is bool:
            x = int(x)
        elif type(x) is int:
            if abs(x) > 2**53:
                return None
        elif type(x) is float:
            if x != x or x in (float("inf"), float("-inf")):
                return None
        else:
            return None
        values.append(x)
    return {"values": values, "min": min(values), "max": max(values)}


class Serializer:
    """Serializes one snapshot. A fresh instance is used per step."""

    def __init__(self, keepalive: dict[str, object], ids: dict[Any, Any], focus: dict[int, list[int]] | None = None):
        self.heap: dict[str, HeapObject] = {}
        # Every object ever seen, kept alive for the run (see ref).
        self.keepalive = keepalive
        # id(object) -> its trace id ("o3"), shared across steps; "__retired__"
        # counts ids given to generators that have since been collected.
        self.ids = ids
        # id(list) -> index variables' values, for long lists (see window_start)
        self.focus = focus or {}

    def value(self, v: object) -> Value:
        if isinstance(v, PRIMITIVE_TYPES):
            type_name = "none" if v is None else type(v).__name__
            out: Value = {"kind": "prim", "type": type_name, "repr": short_repr(v)}
            # Sizes the renderer can't tell from the repr: strings and bytes
            # (which may be shortened) and big ints. Others are fixed.
            if isinstance(v, (str, bytes)) or (type(v) is int and v.bit_length() > 30):
                out["size"] = size64(v)
            return out
        return {"kind": "ref", "id": self.ref(v)}

    def ref(self, v: object) -> str:
        # Objects are numbered in the order they're first seen, so the same
        # program gets the same ids on every run. (The renderer remembers
        # where you dragged a box by its id, across live re-runs.)
        oid = self.ids.get(id(v))
        if oid is None:
            oid = self.new_id(v)
        if oid in self.heap:
            return oid
        if len(self.heap) >= MAX_OBJECTS:
            self.heap[oid] = {"kind": "opaque", "id": oid, "typeName": type(v).__name__, "repr": "…"}
            return oid
        # Reserve the slot before recursing so cycles terminate (None until
        # describe returns; nothing reads the heap in between).
        self.heap[oid] = None  # pyright: ignore[reportArgumentType]
        self.heap[oid] = self.describe(v, oid)
        return oid

    def new_id(self, v: object) -> str:
        """The next id, for an object seen for the first time."""
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
        return oid

    def stable_order(self, s: set | frozenset) -> list:
        """A set's items in an order that's the same on every run.

        Python iterates a set of objects in memory-address order, which changes
        from run to run (and strings by a random hash seed, unless
        PYTHONHASHSEED is fixed, as the app does). Objects the trace has
        already seen come first, in the order they were first seen; the rest
        keep Python's order. Very large sets aren't reordered.
        """
        items = list(s)
        if len(items) > 1000:
            return items

        def key(pair):
            index, item = pair
            oid = self.ids.get(id(item))
            return (0, int(oid[1:])) if oid else (1, index)

        return [item for _, item in sorted(enumerate(items), key=key)]

    def items(self, iterable) -> list[Value]:
        out = []
        for index, item in enumerate(iterable):
            if index >= MAX_ITEMS:
                break
            out.append(self.value(item))
        return out

    def describe(self, v: Any, oid: str) -> HeapObject:
        """The heap object for v, by what kind of value it is."""
        type_name = type(v).__name__
        if isinstance(v, SEQUENCE_TYPES):
            return self.sequence(v, oid)
        if isinstance(v, dict):
            return self.dictionary(v, oid)
        if isinstance(v, PAUSABLE_OBJECTS):
            return {"kind": "opaque", "id": oid, "typeName": type_name, "repr": pausable_state(v)}
        if isinstance(v, types.FunctionType):
            return self.function(v, oid)
        if isinstance(v, (types.BuiltinFunctionType, types.BuiltinMethodType)):
            name = getattr(v, "__name__", "?")
            return {
                "kind": "function",
                "id": oid,
                "typeName": type_name,
                "name": name,
                "params": [],
                "fields": [],
                "builtin": True,
            }
        if isinstance(v, type):
            return {"kind": "class", "id": oid, "typeName": "type", "name": v.__name__, "size": size64(v)}
        fields = self.instance_fields(v)
        if fields is not None:
            return self.instance(v, oid, fields)
        return {"kind": "opaque", "id": oid, "typeName": type_name, "repr": short_repr(v), "size": size64(v)}

    def sequence(self, v: Any, oid: str) -> HeapObject:
        """A list, tuple, set or deque. A long list or tuple shows a window of
        MAX_ITEMS items around its index variables, and a strip of all of it."""
        kind = "tuple" if isinstance(v, tuple) else "set" if isinstance(v, (set, frozenset)) else "list"
        n = len(v)
        long = kind != "set" and n > MAX_ITEMS
        if long:
            indices = self.focus.get(id(v))
            start = window_start(indices, n) if indices else 0
            # islice, not v[start:...]: a deque can't be sliced.
            shown = islice(v, start, start + MAX_ITEMS)
        else:
            start = 0
            shown = self.stable_order(v) if isinstance(v, (set, frozenset)) else v
        out: HeapObject = {
            "kind": kind,
            "id": oid,
            "typeName": type(v).__name__,
            "items": self.items(shown),
            "length": n,
            "size": size64(v),
        }
        if long:
            if start:
                out["offset"] = start
            strip = strip_of(v)
            if strip is not None:
                out["strip"] = strip
        if type(v) is list:
            out["capacity"] = list_capacity(v)
        return out

    def dictionary(self, v: dict, oid: str) -> HeapObject:
        entries = []
        for index, (key, val) in enumerate(v.items()):
            if index >= MAX_ITEMS:
                break
            entries.append([self.value(key), self.value(val)])
        return {
            "kind": "dict",
            "id": oid,
            "typeName": type(v).__name__,
            "entries": entries,
            "length": len(v),
            "size": size64(v),
        }

    def function(self, v: types.FunctionType, oid: str) -> HeapObject:
        """A function, with the variables it closes over as its fields."""
        code = v.__code__
        params = list(code.co_varnames[: code.co_argcount + code.co_kwonlyargcount])
        fields = []
        if v.__closure__:
            for name, cell in zip(code.co_freevars, v.__closure__):
                try:
                    fields.append([name, self.value(cell.cell_contents)])
                except ValueError:  # empty cell
                    fields.append([name, {"kind": "prim", "type": "unbound", "repr": "?"}])
        return {
            "kind": "function",
            "id": oid,
            "typeName": type(v).__name__,
            "name": v.__name__,
            "params": params,
            "fields": fields,
            "builtin": False,
            "size": size64(v),
        }

    def instance(self, v: object, oid: str, fields: list) -> HeapObject:
        """An instance, sized with the dict holding its attributes (if it has one)."""
        size = size64(v)
        attrs = getattr(v, "__dict__", None)
        if size is not None and isinstance(attrs, dict):
            size += size64(attrs) or 0
        return {"kind": "object", "id": oid, "typeName": type(v).__name__, "fields": fields, "size": size}

    def instance_fields(self, v: object) -> list | None:
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
        return [
            [name, self.value(val)]
            for name, val in attrs.items()
            if not (name.startswith("__") and name.endswith("__"))
        ]
