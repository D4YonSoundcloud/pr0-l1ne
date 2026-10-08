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
import struct
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
# Where a frame is parked when it pauses at a yield or await: on the
# YIELD_VALUE itself in Python 3.12 (what the browser runs), or on the
# RESUME after it in 3.13.
PAUSE_OPS = {dis.opmap[name] for name in ("YIELD_VALUE", "RESUME") if name in dis.opmap}
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
# The shape of the code, for complexity estimates
# ---------------------------------------------------------------------------
#
# A language-neutral description of each function (see CostInfo in
# src/trace/types.ts): its loops and how many times each runs, calls to the
# program's own functions and how their arguments shrink, built-ins that
# aren't O(1), and memory that grows. trace/complexity.ts turns it into Big-O
# and checks it against the run. Everything here is a heuristic about how
# code is usually written; anything it can't size is marked "unknown" and
# sized from the run instead.

EMPTY_CONTAINERS = {"list": "list", "dict": "dict", "set": "set", "deque": "list", "defaultdict": "dict",
                    "Counter": "dict", "OrderedDict": "dict", "frozenset": "set"}
# Built-ins that walk a whole iterable they're given.
LINEAR_BUILTINS = {"sum", "min", "max", "any", "all", "list", "tuple", "set", "frozenset", "dict", "sorted",
                   "Counter", "deque"}
LINEAR_METHODS = {"index", "count", "remove", "copy", "reverse", "insert", "join", "split"}
LOG_FUNCTIONS = {"heappush", "heappop", "heappushpop", "heapreplace", "bisect", "bisect_left", "bisect_right",
                 "insort", "insort_left", "insort_right"}
GROW_METHODS = {"append", "appendleft", "add", "extend", "extendleft", "insert", "setdefault", "update"}
MEMO_DECORATORS = {"cache", "lru_cache"}


def _dotted(node):
    """self.items -> "self.items"; None for anything that isn't names and dots."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return base + "." + node.attr if base else None
    return None


def _call_name(call):
    """The name a call is made by: f(x) -> "f", heapq.heappush(...) -> "heappush"."""
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _is_const(node):
    return isinstance(node, ast.Constant) or (isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant))


def _halves(node):
    """x // 2, x >> 1, x / 2."""
    return (isinstance(node, ast.BinOp) and isinstance(node.op, (ast.FloorDiv, ast.RShift, ast.Div))
            and isinstance(node.right, ast.Constant) and node.right.value in (2, 1 if isinstance(node.op, ast.RShift) else 2))


def _walk_shallow(node):
    """ast.walk that doesn't go into nested functions, classes or lambdas."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        child = stack.pop()
        yield child
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            stack.extend(ast.iter_child_nodes(child))


class FunctionShape:
    """Builds one CostFunction."""

    def __init__(self, name, line, params, body, user_functions, is_global):
        self.name = name
        self.line = line
        self.params = params
        self.body = body
        self.user_functions = user_functions
        self.is_global = is_global
        self.aliases = {}       # name -> SizeRef: n = len(nums)
        self.index_vars = {}    # i -> SizeRef list of the loop it counts through
        self.elements = {}      # x -> SizeRef of the collection it's an item of
        self.mids = set()       # names holding a midpoint: mid = (lo + hi) // 2
        self.containers = {}    # name -> "list" | "dict" | "set", for names made empty
        self.inits = {}         # name -> first expression assigned to it
        self.recursive_args = []
        self.returned = set()   # ids of calls that are a whole `return f(...)`
        self.collect()

    # -- what the names mean ------------------------------------------------

    def collect(self):
        # Names first, then what loop variables count through (which needs
        # the names), then names again (which can need the loop variables).
        self.learn_all()
        for node in self.walk():
            if isinstance(node, (ast.For, ast.AsyncFor)):
                self.for_bound(node)
            elif isinstance(node, ast.comprehension):
                self.for_bound(ast.For(target=node.target, iter=node.iter, body=[], orelse=[]))
        self.aliases.clear()
        self.inits.clear()
        self.learn_all()

    def learn_all(self):
        for node in self.walk():
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    self.learn(target, node.value)
            elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
                self.learn(node.target, node.value)

    def walk(self):
        for stmt in self.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            yield stmt
            yield from _walk_shallow(stmt)

    def learn(self, target, value):
        if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)) \
                and len(target.elts) == len(value.elts):
            for t, v in zip(target.elts, value.elts):
                self.learn(t, v)
            return
        if not isinstance(target, ast.Name):
            return
        name = target.id
        self.inits.setdefault(name, value)
        # mid = (lo + hi) // 2, mid = len(items) // 2; but not n = n // 2
        if any(_halves(sub) for sub in ast.walk(value)) and name not in {
                n.id for n in ast.walk(value) if isinstance(n, ast.Name)}:
            self.mids.add(name)
        kind = self.container_kind(value)
        if kind and name not in self.containers:
            self.containers[name] = kind
        if name not in self.aliases and name not in self.params:
            ref = self.size_of(value, allow_value=True)
            if ref and ref != "const" and ref.get("name") != name:
                self.aliases[name] = ref

    def container_kind(self, value):
        if isinstance(value, (ast.Dict, ast.DictComp)):
            return "dict"
        if isinstance(value, (ast.Set, ast.SetComp)):
            return "set"
        if isinstance(value, (ast.List, ast.ListComp)):
            return "list"
        if isinstance(value, ast.Call):
            name = _call_name(value)
            if name in EMPTY_CONTAINERS:
                return EMPTY_CONTAINERS[name]
        return None

    def size_of(self, node, allow_value=False):
        """The size an expression measures, as a SizeRef; "const" or None."""
        if node is None:
            return None
        if _is_const(node):
            return "const"
        if isinstance(node, ast.Call):
            fname = _call_name(node)
            if fname == "len" and node.args:
                return self.length_of(node.args[0])
            if fname in ("int", "abs", "round", "min", "max", "math.floor") and node.args:
                for arg in node.args:
                    ref = self.size_of(arg, allow_value)
                    if ref and ref != "const":
                        return ref
                return "const" if all(_is_const(a) for a in node.args) else None
            if fname in self.user_functions:
                # A function given a collection usually returns something its size.
                for arg in node.args:
                    ref = self.arg_ref(arg)
                    if ref:
                        return dict(ref, len=True) if self.looks_like_collection(arg) else ref
                return None
            if fname in ("sorted", "list", "set", "tuple", "reversed") and node.args:
                return self.length_of(node.args[0])
            return None
        if isinstance(node, ast.Name):
            if node.id in self.index_vars:
                sizes = self.index_vars[node.id]
                return sizes[0] if sizes else "const"
            if node.id in self.aliases:
                return self.aliases[node.id]
            if node.id in self.mids:
                return None
            return {"name": node.id} if allow_value else None
        if isinstance(node, ast.Attribute):
            dotted = _dotted(node)
            return {"name": dotted} if dotted and allow_value else None
        if isinstance(node, ast.BinOp):
            if _halves(node):
                return None
            found = [self.size_of(side, allow_value) for side in (node.left, node.right)]
            refs = [r for r in found if r and r != "const"]
            if refs:
                # Prefer a real size over a loop counter: len(arr) - i - 1 is len(arr).
                plain = [r for r, side in zip(found, (node.left, node.right))
                         if r and r != "const" and not (isinstance(side, ast.Name) and side.id in self.index_vars)]
                return (plain or refs)[0]
            return "const" if all(r == "const" for r in found) else None
        if isinstance(node, ast.UnaryOp):
            return self.size_of(node.operand, allow_value)
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice):
            return self.length_of(node.value)
        return None

    def length_of(self, node):
        """len(node) as a SizeRef."""
        if isinstance(node, ast.Name):
            if node.id in self.elements:
                return dict(self.elements[node.id], inner=True)
            alias = self.aliases.get(node.id)
            if alias and alias.get("len"):
                return alias
            return {"name": node.id, "len": True}
        if isinstance(node, ast.Subscript):
            if isinstance(node.slice, ast.Slice):
                # nums[:k] is k long; nums[i:] or nums[a:b] up to len(nums)
                sl = node.slice
                if sl.lower is None and sl.upper is not None and sl.step is None:
                    ref = self.size_of(sl.upper, allow_value=True)
                    if ref == "const" or (ref and not (isinstance(sl.upper, ast.Name) and sl.upper.id in self.mids)
                                          and not _halves(sl.upper)):
                        return ref
                return self.length_of(node.value)
            base = _dotted(node.value)
            if base:
                ref = self.length_of(node.value) if isinstance(node.value, ast.Name) else {"name": base, "len": True}
                return dict(ref, inner=True)
            return None
        if isinstance(node, ast.Attribute):
            # node.children, city.roads: an item of a structure
            base = _dotted(node.value)
            if base and isinstance(node.value, ast.Name) and node.value.id not in self.containers:
                return {"name": base, "len": True, "inner": True}
            dotted = _dotted(node)
            return {"name": dotted, "len": True} if dotted else None
        if isinstance(node, ast.Call):
            fname = _call_name(node)
            if isinstance(node.func, ast.Attribute) and fname in ("items", "keys", "values", "split", "copy", "strip", "lower", "upper"):
                return self.length_of(node.func.value)
            if fname in ("enumerate", "reversed", "sorted", "list", "set", "tuple", "iter") and node.args:
                return self.length_of(node.args[0])
            if fname == "zip" and node.args:
                return self.length_of(node.args[0])
            if fname == "range":
                return self.range_size(node)
            return self.size_of(node)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set, ast.Dict, ast.Constant, ast.JoinedStr)):
            return "const"
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)) and node.generators:
            return self.length_of(node.generators[0].iter)
        if isinstance(node, ast.BinOp):  # a + b, [0] * n
            if isinstance(node.op, ast.Mult):
                for side in (node.right, node.left):
                    ref = self.size_of(side, allow_value=True)
                    if ref and ref != "const":
                        return ref
                return "const"
            for side in (node.left, node.right):
                ref = self.length_of(side)
                if ref and ref != "const":
                    return ref
            return "const"
        return None

    def range_size(self, call):
        args = call.args
        if not args:
            return None
        stop = args[0] if len(args) == 1 else args[1]
        start = args[0] if len(args) > 1 else None
        for candidate in (stop, start):
            if candidate is None:
                continue
            ref = self.size_of(candidate, allow_value=True)
            if ref and ref != "const":
                return ref
        return "const"

    def looks_like_collection(self, arg):
        if isinstance(arg, ast.Subscript) and isinstance(arg.slice, ast.Slice):
            return True
        if isinstance(arg, ast.Name):
            return arg.id in self.containers or arg.id in self.elements or (
                arg.id in self.params and self.used_as_collection(arg.id))
        return False

    def used_as_collection(self, name):
        for node in self.walk():
            if isinstance(node, ast.Call) and _call_name(node) == "len" and node.args \
                    and isinstance(node.args[0], ast.Name) and node.args[0].id == name:
                return True
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == name:
                return True
            if isinstance(node, (ast.For, ast.comprehension)) and isinstance(node.iter, ast.Name) and node.iter.id == name:
                return True
        return False

    def arg_ref(self, arg):
        """What an argument passes along, as a SizeRef the callee's sizes can be renamed to."""
        if isinstance(arg, ast.Name):
            if arg.id in self.aliases:
                return self.aliases[arg.id]
            if arg.id in self.index_vars or arg.id in self.mids:
                return None
            return {"name": arg.id}
        if isinstance(arg, ast.Attribute):
            dotted = _dotted(arg)
            return {"name": dotted} if dotted else None
        if isinstance(arg, ast.Subscript) and isinstance(arg.slice, ast.Slice):
            return self.arg_ref(arg.value)
        if isinstance(arg, ast.Call) and _call_name(arg) == "len" and arg.args:
            return self.length_of(arg.args[0])
        if isinstance(arg, ast.BinOp):
            for side in (arg.left, arg.right):
                ref = self.arg_ref(side)
                if ref:
                    return ref
        return None

    # -- loop bounds --------------------------------------------------------

    def for_bound(self, node):
        it = node.iter
        ref = self.length_of(it)
        header = ast.unparse(it)
        target = node.target
        # Remember what the loop variable counts through, or is an item of.
        names = [target] if isinstance(target, ast.Name) else [
            t for t in ast.walk(target) if isinstance(t, ast.Name)]
        is_range = isinstance(it, ast.Call) and _call_name(it) == "range"
        for t in names:
            if is_range or (isinstance(it, ast.Call) and _call_name(it) == "enumerate" and t is names[0]):
                self.index_vars[t.id] = [ref] if ref and ref != "const" else []
            elif ref and ref != "const" and not ref.get("inner"):
                base = self.collection_of(it)
                if base:
                    self.elements[t.id] = base
        if ref == "const":
            return {"kind": "const", "why": header}
        if ref:
            return {"kind": "size", "sizes": [ref], "why": header}
        return {"kind": "unknown", "why": header}

    def collection_of(self, it):
        """The SizeRef of the collection a for loop walks, for its items."""
        if isinstance(it, ast.Call) and _call_name(it) in ("enumerate", "reversed", "sorted", "zip", "list") and it.args:
            return self.collection_of(it.args[0])
        if isinstance(it, ast.Call) and isinstance(it.func, ast.Attribute) and _call_name(it) in ("items", "values", "keys"):
            return self.collection_of(it.func.value)
        if isinstance(it, ast.Name):
            alias = self.aliases.get(it.id)
            return alias if alias and alias.get("len") else {"name": it.id, "len": True}
        return None

    def while_bound(self, node):
        test = node.test
        header = "while " + ast.unparse(test)
        test_names = {n.id for n in ast.walk(test) if isinstance(n, ast.Name)}
        changes = {}  # name -> how the body changes it
        for sub in _walk_shallow(ast.Module(body=node.body, type_ignores=[])):
            if isinstance(sub, ast.AugAssign) and isinstance(sub.target, ast.Name):
                op = sub.op
                if isinstance(op, (ast.FloorDiv, ast.RShift, ast.Div)) or (isinstance(op, ast.Mult) and _is_const(sub.value)) \
                        or (isinstance(op, ast.LShift)):
                    changes[sub.target.id] = "log"
                elif isinstance(op, (ast.Add, ast.Sub)):
                    changes.setdefault(sub.target.id, "step")
            elif isinstance(sub, ast.Assign):
                for target in sub.targets:
                    for t, v in self.pairs(target, sub.value):
                        if not isinstance(t, ast.Name):
                            continue
                        if _halves(v) or self.uses_mid(v):
                            changes[t.id] = "log"
                        elif isinstance(v, ast.Attribute) and isinstance(v.value, (ast.Name, ast.Attribute)) \
                                and self.root_name(v) == t.id:
                            changes[t.id] = "follow"
                        elif isinstance(v, ast.Name) and self.follows(v.id, t.id, node.body):
                            changes[t.id] = "follow"
                        elif isinstance(v, ast.BinOp) and isinstance(v.left, ast.Name) and v.left.id == t.id \
                                and isinstance(v.op, (ast.Add, ast.Sub)) and _is_const(v.right):
                            changes.setdefault(t.id, "step")

        # Halving: binary search, n //= 2
        logs = [n for n in changes if changes[n] == "log" and (n in test_names or self.uses_mid_name(n, test_names))]
        if logs:
            ref = self.test_size(test, set(logs))
            if ref and ref != "const":
                return {"kind": "log", "size": ref, "why": header + " (halves each pass)"}
        # Walking a linked structure: node = node.next
        follows = [n for n in changes if changes[n] == "follow"]
        if follows:
            root = self.structure_root(follows[0])
            if root:
                return {"kind": "size", "sizes": [{"name": root, "len": True}],
                        "why": header + " (follows ." + self.follow_attr(follows[0], node.body) + ")"}
        # Counting: while i < n: i += 1
        steps = [n for n in changes if changes[n] == "step" and n in test_names]
        if steps:
            sizes = []
            for compare in [c for c in ast.walk(test) if isinstance(c, ast.Compare)]:
                sides = [compare.left] + compare.comparators
                if not any(isinstance(s, ast.Name) and s.id in steps for s in sides):
                    continue
                for side in sides:
                    if isinstance(side, ast.Name) and side.id in steps:
                        # A counter is bounded by where it starts: j = i - 1 counting
                        # down to 0, right = len(s) - 1 moving toward left.
                        start = self.inits.get(side.id)
                        ref = self.size_of(start, allow_value=True) if start is not None else None
                    elif _is_const(side):
                        ref = None
                    else:
                        ref = self.size_of(side, allow_value=True)
                    if ref and ref != "const" and ref not in sizes:
                        sizes.append(ref)
            if sizes:
                return {"kind": "size", "sizes": sizes, "why": header}
        return {"kind": "unknown", "why": header}

    @staticmethod
    def pairs(target, value):
        if isinstance(target, (ast.Tuple, ast.List)) and isinstance(value, (ast.Tuple, ast.List)) \
                and len(target.elts) == len(value.elts):
            return list(zip(target.elts, value.elts))
        return [(target, value)]

    def uses_mid(self, value):
        return any(isinstance(n, ast.Name) and n.id in self.mids for n in ast.walk(value))

    def uses_mid_name(self, name, test_names):
        return name in self.mids or bool(test_names & self.mids)

    @staticmethod
    def root_name(node):
        while isinstance(node, ast.Attribute):
            node = node.value
        return node.id if isinstance(node, ast.Name) else None

    def follows(self, temp, name, body):
        """nxt = curr.next; ...; curr = nxt"""
        for sub in _walk_shallow(ast.Module(body=body, type_ignores=[])):
            if isinstance(sub, ast.Assign) and any(isinstance(t, ast.Name) and t.id == temp for t in sub.targets):
                v = sub.value
                if isinstance(v, ast.Attribute) and self.root_name(v) == name:
                    return True
        return False

    def follow_attr(self, name, body):
        for sub in _walk_shallow(ast.Module(body=body, type_ignores=[])):
            if isinstance(sub, ast.Attribute) and self.root_name(sub) == name and isinstance(sub.ctx, ast.Load):
                return sub.attr
        return "next"

    def structure_root(self, name):
        """Where a walking pointer starts: curr = head -> "head"; a parameter itself."""
        seen = set()
        while name not in seen:
            seen.add(name)
            if name in self.params:
                return name
            init = self.inits.get(name)
            if isinstance(init, ast.Name):
                name = init.id
                continue
            if isinstance(init, ast.Attribute):
                return self.root_name(init)
            return name
        return name

    def test_size(self, test, changing):
        """The size a halving loop works down: hi = len(nums) - 1, or n itself."""
        names = [n.id for n in ast.walk(test) if isinstance(n, ast.Name)]
        for name in names:
            if name in self.aliases:
                return self.aliases[name]
        for name in names:
            start = self.inits.get(name)
            ref = self.size_of(start, allow_value=True) if start is not None else None
            if ref and ref != "const":
                return ref
        others = [n for n in names if n not in changing] or names
        return {"name": others[0]} if others else None

    # -- building the tree --------------------------------------------------

    def build(self):
        body = self.block(self.body)
        return {"name": self.name, "line": self.line, "params": self.params,
                "memo": self.is_memoized(), "body": body}

    def block(self, stmts, in_loop=False):
        out = []
        for stmt in stmts:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(stmt, (ast.For, ast.AsyncFor)):
                out.extend(self.expr(stmt.iter, in_loop))
                bound = self.for_bound(stmt)
                out.append({"kind": "loop", "loop": "L%d" % stmt.lineno, "line": stmt.lineno, "bound": bound,
                            "body": self.block(stmt.body + stmt.orelse, True)})
            elif isinstance(stmt, ast.While):
                bound = self.while_bound(stmt)
                body = self.expr(stmt.test, True) + self.block(stmt.body + stmt.orelse, True)
                out.append({"kind": "loop", "loop": "L%d" % stmt.lineno, "line": stmt.lineno, "bound": bound,
                            "body": body})
            elif isinstance(stmt, ast.If):
                out.extend(self.expr(stmt.test, in_loop))
                out.extend(self.block(stmt.body, in_loop))
                out.extend(self.block(stmt.orelse, in_loop))
            elif isinstance(stmt, (ast.With, ast.AsyncWith)):
                for item in stmt.items:
                    out.extend(self.expr(item.context_expr, in_loop))
                out.extend(self.block(stmt.body, in_loop))
            elif isinstance(stmt, ast.Try) or (hasattr(ast, "TryStar") and isinstance(stmt, ast.TryStar)):
                out.extend(self.block(stmt.body, in_loop))
                for handler in stmt.handlers:
                    out.extend(self.block(handler.body, in_loop))
                out.extend(self.block(stmt.orelse, in_loop))
                out.extend(self.block(stmt.finalbody, in_loop))
            elif hasattr(ast, "Match") and isinstance(stmt, ast.Match):
                out.extend(self.expr(stmt.subject, in_loop))
                for case in stmt.cases:
                    out.extend(self.block(case.body, in_loop))
            else:
                if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Call):
                    self.returned.add(id(stmt.value))
                out.extend(self.statement(stmt, in_loop))
        return out

    def statement(self, stmt, in_loop):
        out = []
        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, ast.expr):
                out.extend(self.expr(child, in_loop))
        # Memory that's created or grows.
        if isinstance(stmt, ast.Assign):
            value = stmt.value
            sizes = self.alloc_sizes(value)
            simple = len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name)
            if sizes:
                out.append({"kind": "alloc", "line": stmt.lineno, "what": ast.unparse(value)[:40], "sizes": sizes,
                            **({"name": stmt.targets[0].id} if simple else {})})
            for target in stmt.targets:
                # node.children[ch] = TrieNode(): a structure growing by a new object
                if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Attribute) \
                        and isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id[:1].isupper():
                    base = _dotted(target.value)
                    if base:
                        out.append({"kind": "alloc", "line": stmt.lineno, "what": base + "[...] = " + value.func.id + "()",
                                    "sizes": [], "into": base})
                if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name) \
                        and self.containers.get(target.value.id) == "dict":
                    out.append({"kind": "alloc", "line": stmt.lineno, "what": target.value.id + "[...] = ...", "sizes": [],
                                "into": target.value.id})
        return out

    def alloc_sizes(self, value):
        """Sizes multiplied together if value makes a new collection sized by them, else None."""
        if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Mult) and isinstance(value.left, (ast.List, ast.Tuple)):
            ref = self.size_of(value.right, allow_value=True)
            return [ref] if ref and ref != "const" else None
        if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add):
            for side in (value.left, value.right):
                sizes = self.alloc_sizes(side)
                if sizes:
                    return sizes
            return None
        if isinstance(value, (ast.ListComp, ast.SetComp, ast.DictComp)):
            sizes = []
            for gen in value.generators:
                ref = self.length_of(gen.iter)
                if ref and ref != "const":
                    sizes.append(ref)
            inner = self.alloc_sizes(value.elt) if isinstance(value, (ast.ListComp, ast.SetComp)) else None
            return sizes + (inner or []) if sizes or inner else None
        if isinstance(value, ast.Subscript) and isinstance(value.slice, ast.Slice):
            ref = self.length_of(value.value)
            return [ref] if ref and ref != "const" else None
        if isinstance(value, ast.Call):
            name = _call_name(value)
            if name in ("list", "sorted", "set", "dict", "tuple", "deque", "Counter", "copy", "frozenset") and value.args:
                ref = self.length_of(value.args[0])
                return [ref] if ref and ref != "const" else None
            if name == "copy" and isinstance(value.func, ast.Attribute):
                ref = self.length_of(value.func.value)
                return [ref] if ref and ref != "const" else None
        return None

    def expr(self, node, in_loop):
        """Calls, costly built-ins, comprehensions and growth in an expression, in source order."""
        out = []
        if node is None:
            return out
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            return self.comprehension(node, node.generators, in_loop)
        if isinstance(node, ast.Lambda):
            return out
        if isinstance(node, ast.Call):
            for arg in [node.func] + node.args + [k.value for k in node.keywords]:
                out.extend(self.expr(arg, in_loop))
            out.extend(self.call(node))
            return out
        if isinstance(node, ast.Compare):
            for child in [node.left] + node.comparators:
                out.extend(self.expr(child, in_loop))
            for op, right in zip(node.ops, node.comparators):
                if isinstance(op, (ast.In, ast.NotIn)):
                    container = _dotted(right)
                    kind = self.containers.get(container) if container else None
                    if isinstance(right, (ast.Set, ast.Dict, ast.Constant)) or kind in ("dict", "set"):
                        continue
                    if isinstance(right, ast.Call) and _call_name(right) == "range":
                        continue
                    ref = self.length_of(right)
                    if ref and ref != "const":
                        out.append({"kind": "op", "line": node.lineno, "what": "in " + ast.unparse(right)[:30],
                                    "cost": "linear", "size": ref, **({"container": container} if container else {})})
            return out
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice) and isinstance(node.ctx, ast.Load):
            out.extend(self.expr(node.value, in_loop))
            ref = self.length_of(node)
            if ref and ref != "const":
                out.append({"kind": "op", "line": node.lineno, "what": ast.unparse(node)[:30] + " (copies)",
                            "cost": "linear", "size": ref})
            return out
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                out.extend(self.expr(child, in_loop))
        return out

    def comprehension(self, node, generators, in_loop):
        if not generators:
            elt = node.elt if not isinstance(node, ast.DictComp) else ast.Tuple(elts=[node.key, node.value])
            return self.expr(elt, True)
        gen = generators[0]
        out = self.expr(gen.iter, in_loop)
        bound = self.for_bound(ast.For(target=gen.target, iter=gen.iter, body=[], orelse=[]))
        body = []
        for cond in gen.ifs:
            body.extend(self.expr(cond, True))
        body.extend(self.comprehension(node, generators[1:], True))
        out.append({"kind": "loop", "line": node.lineno, "bound": bound, "body": body})
        return out

    def call(self, node):
        out = []
        name = _call_name(node)
        line = node.lineno
        is_method = isinstance(node.func, ast.Attribute)
        receiver = _dotted(node.func.value) if is_method else None
        # A method call is the program's own when it's called on an object
        # (stack.push(x), self.helper()), not on a collection it holds
        # (self.items.pop() is the list's pop, even in a class with a pop).
        own_method = not is_method or (isinstance(node.func.value, ast.Name) and receiver not in self.containers)
        if name in self.user_functions and own_method:
            args = [self.arg_ref(a) for a in node.args]
            shrink = self.shrink(node) if name == self.name else "same"
            out.append({"kind": "call", "line": line, "callee": name, "args": args, "shrink": shrink,
                        **({"alt": True} if id(node) in self.returned else {})})
            return out
        if name in LOG_FUNCTIONS and node.args:
            ref = self.length_of(node.args[0])
            out.append({"kind": "op", "line": line, "what": name + "()", "cost": "log",
                        "size": ref if ref != "const" else None})
            if name in ("heappush", "insort", "insort_left", "insort_right"):
                into = _dotted(node.args[0])
                out.append({"kind": "alloc", "line": line, "what": name + "()", "sizes": [], **({"into": into} if into else {})})
            return out
        if not is_method and name in LINEAR_BUILTINS and len(node.args) == 1:
            ref = self.length_of(node.args[0])
            if ref and ref != "const":
                copies = " (copies)" if name in ("sorted", "list", "tuple", "set", "frozenset", "dict", "deque", "Counter") else ""
                out.append({"kind": "op", "line": line, "what": name + "()" + copies, "size": ref,
                            "cost": "nlogn" if name == "sorted" else "linear"})
            return out
        if is_method and receiver:
            kind = self.containers.get(receiver)
            if name == "sort":
                out.append({"kind": "op", "line": line, "what": receiver + ".sort()", "cost": "nlogn",
                            "size": self.length_of(node.func.value)})
            elif name == "join" and node.args:
                ref = self.length_of(node.args[0])
                if ref and ref != "const":
                    out.append({"kind": "op", "line": line, "what": "join()", "cost": "linear", "size": ref})
            elif name in ("index", "count", "remove", "reverse", "copy") or (name == "insert" and kind != "dict"):
                ref = self.length_of(node.func.value)
                if ref and ref != "const":
                    out.append({"kind": "op", "line": line, "what": receiver + "." + name + "()", "cost": "linear",
                                "size": ref, "container": receiver})
            elif name == "pop" and node.args and _is_const(node.args[0]) and getattr(node.args[0], "value", None) == 0:
                ref = self.length_of(node.func.value)
                if ref and ref != "const":
                    out.append({"kind": "op", "line": line, "what": receiver + ".pop(0)", "cost": "linear",
                                "size": ref, "container": receiver})
            elif name == "extend" and node.args:
                ref = self.length_of(node.args[0])
                if ref and ref != "const":
                    out.append({"kind": "op", "line": line, "what": receiver + ".extend()", "cost": "linear", "size": ref})
                    out.append({"kind": "alloc", "line": line, "what": receiver + ".extend()", "sizes": [ref], "into": receiver})
            if name in GROW_METHODS and name != "extend":
                out.append({"kind": "alloc", "line": line, "what": receiver + "." + name + "()", "sizes": [], "into": receiver})
        return out

    def shrink(self, call):
        """How a recursive call's arguments compare with this function's parameters."""
        kinds = []
        for i, arg in enumerate(call.args):
            param = self.params[i] if i < len(self.params) else None
            kinds.append(self.arg_shrink(arg, param))
        self.recursive_args.append(list(zip(self.params, call.args)))
        for k in ("half", "child", "minus"):
            if k in kinds:
                return k
        if kinds and all(k in ("same", "const") for k in kinds):
            return "same"
        return "unknown"

    def arg_shrink(self, arg, param):
        names = {n.id for n in ast.walk(arg) if isinstance(n, ast.Name)}
        if _is_const(arg):
            return "const"
        if isinstance(arg, ast.Name):
            if arg.id == param:
                return "same"
            if arg.id in self.mids:
                return "half"
            if arg.id in self.elements and self.elements[arg.id].get("name") == param:
                return "child"
            init = self.inits.get(arg.id)
            if isinstance(init, ast.Subscript) and isinstance(init.slice, ast.Slice):
                return self.arg_shrink(init, param)
            return "unknown"
        if names & self.mids or _halves(arg):
            return "half"
        if isinstance(arg, ast.Attribute) and self.root_name(arg) in self.params:
            return "child"
        if isinstance(arg, ast.Subscript) and isinstance(arg.slice, ast.Slice):
            sl = arg.slice
            bounds = [b for b in (sl.lower, sl.upper) if b is not None]
            if any(_halves(b) or ({n.id for n in ast.walk(b) if isinstance(n, ast.Name)} & self.mids) for b in bounds):
                return "half"
            return "minus"
        if isinstance(arg, ast.BinOp) and isinstance(arg.op, (ast.Add, ast.Sub)) and _is_const(arg.right) \
                and isinstance(arg.left, ast.Name) and arg.left.id in self.params:
            return "minus"
        return "unknown"

    def is_memoized(self):
        if self.is_global:
            return False
        if any(name in MEMO_DECORATORS for name in self.decorators):
            return True
        # if n in memo: return memo[n] ... memo[n] = ...
        checked, stored = set(), set()
        for node in self.walk():
            if isinstance(node, ast.If) and isinstance(node.test, ast.Compare) \
                    and any(isinstance(op, ast.In) for op in node.test.ops) \
                    and any(isinstance(s, ast.Return) for s in node.body):
                container = _dotted(node.test.comparators[0])
                if container:
                    checked.add(container)
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Subscript):
                        base = _dotted(target.value)
                        if base:
                            stored.add(base)
        return bool(checked & stored)

    decorators = ()


def explorations(shape):
    """A parameter moved both ways across recursive calls (r + 1 and r - 1) is a search, not a shrink."""
    moves = {}
    for args in shape.recursive_args:
        for param, arg in args:
            if isinstance(arg, ast.BinOp) and isinstance(arg.left, ast.Name) and arg.left.id == param and _is_const(arg.right):
                moves.setdefault(param, set()).add(type(arg.op).__name__)
    return any(len(ops) > 1 for ops in moves.values())


def cost_analysis(tree):
    """The CostInfo for a parsed program (see the comment above)."""
    user_functions = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            user_functions.setdefault(node.name, node)
    functions = []
    top = FunctionShape("Global", 1, [], tree.body, user_functions, True)
    functions.append(top.build())
    for name, node in user_functions.items():
        params = [a.arg for a in node.args.posonlyargs + node.args.args if a.arg not in ("self", "cls")]
        shape = FunctionShape(name, node.lineno, params, node.body, user_functions, False)
        shape.decorators = [(_call_name(d) if isinstance(d, ast.Call) else (d.attr if isinstance(d, ast.Attribute) else getattr(d, "id", "")))
                            for d in node.decorator_list]
        built = shape.build()
        if explorations(shape):
            for call in iter_calls(built["body"]):
                if call["callee"] == name:
                    call["shrink"] = "unknown"
        functions.append(built)
    return {"functions": functions}


def iter_calls(nodes):
    for node in nodes:
        if node["kind"] == "call":
            yield node
        elif node["kind"] == "loop":
            yield from iter_calls(node["body"])


# ---------------------------------------------------------------------------
# Serialization: Python values -> trace Values + heap objects
# ---------------------------------------------------------------------------

PRIMITIVE_TYPES = (bool, int, float, complex, str, bytes, type(None))

# ---------------------------------------------------------------------------
# Memory sizes, as a 64-bit CPython reports them
# ---------------------------------------------------------------------------
#
# sys.getsizeof() is exact on a 64-bit Python. In the browser, Python is
# 32-bit WebAssembly (Pyodide), where pointers are 4 bytes, so sizes are
# converted to what the same object would take on a 64-bit Python, using
# rules measured on both (see the README, "Memory sizes"):
#   objects made of pointers (lists, tuples, sets, functions, instances): x2
#   ints and bools: +12, floats and complex: +8, None: 16
#   strings: +20 (ASCII) or +28, bytes: +16
#   dicts: worked out from their hash table's size and entry layout

POINTER = struct.calcsize("P")
EMPTY_LIST = sys.getsizeof([])


def dict_size64(d, size):
    """A dict's 64-bit size, from its size on a 32-bit Python."""
    if size <= 40:
        return 64
    # 32-bit: 40 (dict) + 20 (keys header) + slots * index bytes + usable * entry
    # 64-bit: 64 + 32 + the same indices + usable * (twice the entry)
    entry = 8 if all(type(k) is str for k in d) else 12
    for log2 in range(3, 24):
        slots = 1 << log2
        index = 1 if slots < 256 else 2 if slots < 65536 else 4
        usable = (slots * 2) // 3
        if 40 + 20 + slots * index + usable * entry == size:
            return 64 + 32 + slots * index + usable * entry * 2
    return round(size * 1.9)  # a split (instance) dict: close enough


def size64(v):
    """sys.getsizeof(v), as a 64-bit CPython would report it (None if unknown)."""
    try:
        size = sys.getsizeof(v)
    except Exception:
        return None
    if POINTER == 8:
        return size
    if v is None:
        return 16
    if isinstance(v, int):  # and bool
        return size + 12
    if isinstance(v, (float, complex)):
        return size + 8
    if isinstance(v, str):
        return size + (20 if v.isascii() else 28)
    if isinstance(v, (bytes, bytearray)):
        return size + 16
    if isinstance(v, dict):
        return dict_size64(v, size)
    return size * 2


def list_capacity(v):
    """How many items a list has room for before it has to grow."""
    return (sys.getsizeof(v) - EMPTY_LIST) // POINTER
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
            out = {"kind": "prim", "type": type_name, "repr": short_repr(v)}
            # Sizes the renderer can't tell from the repr: strings and bytes
            # (which may be shortened) and big ints. Others are fixed.
            if isinstance(v, (str, bytes)) or (type(v) is int and v.bit_length() > 30):
                out["size"] = size64(v)
            return out
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
            out = {"kind": kind, "id": oid, "typeName": type_name,
                   "items": self.items(v), "length": len(v), "size": size64(v)}
            if type(v) is list:
                out["capacity"] = list_capacity(v)
            return out

        if isinstance(v, dict):
            entries = []
            for index, (key, val) in enumerate(v.items()):
                if index >= MAX_ITEMS:
                    break
                entries.append([self.value(key), self.value(val)])
            return {"kind": "dict", "id": oid, "typeName": type_name,
                    "entries": entries, "length": len(v), "size": size64(v)}

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
                    "name": v.__name__, "params": params, "fields": fields, "builtin": False,
                    "size": size64(v)}

        if isinstance(v, (types.BuiltinFunctionType, types.BuiltinMethodType)):
            return {"kind": "function", "id": oid, "typeName": type_name,
                    "name": getattr(v, "__name__", "?"), "params": [], "fields": [], "builtin": True}

        if isinstance(v, type):
            return {"kind": "class", "id": oid, "typeName": "type", "name": v.__name__, "size": size64(v)}

        fields = self.instance_fields(v)
        if fields is not None:
            # An instance and the dict holding its attributes (if it has one).
            size = size64(v)
            attrs = getattr(v, "__dict__", None)
            if size is not None and isinstance(attrs, dict):
                size += size64(attrs) or 0
            return {"kind": "object", "id": oid, "typeName": type_name, "fields": fields, "size": size}

        return {"kind": "opaque", "id": oid, "typeName": type_name, "repr": short_repr(v), "size": size64(v)}

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
            try:
                result["cost"] = cost_analysis(ast.parse(self.source, USER_FILENAME))
            except Exception:  # a guess about the code's shape must never stop a run
                pass
            code = compile(self.source, USER_FILENAME, "exec")
        except SyntaxError as exc:
            result["error"] = {"type": "SyntaxError", "message": exc.msg or str(exc),
                               "line": exc.lineno}
            return result

        def no_input(*_args):
            raise RuntimeError("input() isn't supported. Hard-code your test data instead.")

        user_globals = {"__name__": "__main__", "input": no_input}
        # Only programs that mention asyncio pay for importing it.
        uses_asyncio = "asyncio" in self.source
        if uses_asyncio:
            # Pyodide replaces asyncio.run with one that hands the coroutine
            # to the browser's loop, and marks that loop as running. Use the
            # standard asyncio.run and no running loop while tracing, then put
            # Pyodide's back.
            import asyncio
            saved_asyncio = (asyncio.events._event_loop_policy, asyncio.run, asyncio.events._get_running_loop())
            asyncio.set_event_loop_policy(virtual_loop_policy())
            asyncio.run = asyncio.runners.run
            asyncio.events._set_running_loop(None)
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
            if uses_asyncio:
                asyncio.events._event_loop_policy, asyncio.run, running = saved_asyncio
                asyncio.events._set_running_loop(running)

        result["stdout"] = self.stdout.getvalue()
        return result


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

    return Policy()


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
