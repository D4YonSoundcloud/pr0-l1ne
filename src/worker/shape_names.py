"""
The shape of the code, part 1: what size each name and expression in a
function stands for.

`n = len(nums)` makes n stand for len(nums); `for i in range(n)` makes i
count through it; `for x in nums` makes x an item of nums. size_of() and
length_of() turn an expression into a SizeRef ({"name": "nums", "len":
True}, see CostInfo in src/trace/types.ts), "const", or None when it can't
tell. The other shape modules build on this one: shape_loops.py (how many
passes a while loop makes), shape_costs.py (what expressions and calls
cost) and shape.py (the tree for a function).
"""

import ast
from collections.abc import Iterator
from typing import Any, Literal

# A size an expression measures: a SizeRef ({"name": "nums", "len": True},
# see CostInfo in src/trace/types.ts), "const" (it doesn't grow), or None
# (it can't tell).
SizeRef = dict[str, Any]
Size = SizeRef | Literal["const"] | None
# A loop's bound ({"kind": "size", "sizes": [...], "why": ...}) and a node of
# the cost tree ({"kind": "loop" | "call" | "op" | "alloc", ...}).
Bound = dict[str, Any]
CostNode = dict[str, Any]
# The program's own functions, by name.
UserFunctions = dict[str, ast.FunctionDef | ast.AsyncFunctionDef]

EMPTY_CONTAINERS = {
    "list": "list",
    "dict": "dict",
    "set": "set",
    "deque": "list",
    "defaultdict": "dict",
    "Counter": "dict",
    "OrderedDict": "dict",
    "frozenset": "set",
}


def dotted_name(node: ast.AST) -> str | None:
    """self.items -> "self.items"; None for anything that isn't names and dots."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted_name(node.value)
        return base + "." + node.attr if base else None
    return None


def call_name(call: ast.Call) -> str | None:
    """The name a call is made by: f(x) -> "f", heapq.heappush(...) -> "heappush"."""
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def is_const(node: ast.AST) -> bool:
    return isinstance(node, ast.Constant) or (isinstance(node, ast.UnaryOp) and isinstance(node.operand, ast.Constant))


def is_halving(node: ast.AST) -> bool:
    """x // 2, x >> 1, x / 2."""
    return (
        isinstance(node, ast.BinOp)
        and isinstance(node.op, (ast.FloorDiv, ast.RShift, ast.Div))
        and isinstance(node.right, ast.Constant)
        and node.right.value in (2, 1 if isinstance(node.op, ast.RShift) else 2)
    )


def walk_shallow(node: ast.AST) -> Iterator[ast.AST]:
    """ast.walk that doesn't go into nested functions, classes or lambdas."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        child = stack.pop()
        yield child
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            stack.extend(ast.iter_child_nodes(child))


class NameSizes:
    """What the names in one function's body stand for. Learned when it's made."""

    def __init__(self, params: list[str], body: list[ast.stmt], user_functions: UserFunctions) -> None:
        self.params = params
        self.body = body
        self.user_functions = user_functions
        self.aliases: dict[str, SizeRef] = {}  # name -> SizeRef: n = len(nums)
        self.index_vars: dict[str, list[SizeRef]] = {}  # i -> SizeRef list of the loop it counts through
        self.elements: dict[str, SizeRef] = {}  # x -> SizeRef of the collection it's an item of
        self.mids: set[str] = set()  # names holding a midpoint: mid = (lo + hi) // 2
        self.containers: dict[str, str] = {}  # name -> "list" | "dict" | "set", for names made empty
        self.inits: dict[str, ast.expr] = {}  # name -> first expression assigned to it
        self.collect()

    def collect(self) -> None:
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

    def learn_all(self) -> None:
        for node in self.walk():
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    self.learn(target, node.value)
            elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
                self.learn(node.target, node.value)

    def walk(self) -> Iterator[ast.AST]:
        for stmt in self.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            yield stmt
            yield from walk_shallow(stmt)

    def learn(self, target: ast.expr, value: ast.expr) -> None:
        if (
            isinstance(target, (ast.Tuple, ast.List))
            and isinstance(value, (ast.Tuple, ast.List))
            and len(target.elts) == len(value.elts)
        ):
            for t, v in zip(target.elts, value.elts):
                self.learn(t, v)
            return
        if not isinstance(target, ast.Name):
            return
        name = target.id
        self.inits.setdefault(name, value)
        # mid = (lo + hi) // 2, mid = len(items) // 2; but not n = n // 2
        if any(is_halving(sub) for sub in ast.walk(value)) and name not in {
            n.id for n in ast.walk(value) if isinstance(n, ast.Name)
        }:
            self.mids.add(name)
        kind = self.container_kind(value)
        if kind and name not in self.containers:
            self.containers[name] = kind
        if name not in self.aliases and name not in self.params:
            ref = self.size_of(value, allow_value=True)
            if ref and ref != "const" and ref.get("name") != name:
                self.aliases[name] = ref

    def container_kind(self, value: ast.expr) -> str | None:
        if isinstance(value, (ast.Dict, ast.DictComp)):
            return "dict"
        if isinstance(value, (ast.Set, ast.SetComp)):
            return "set"
        if isinstance(value, (ast.List, ast.ListComp)):
            return "list"
        if isinstance(value, ast.Call):
            name = call_name(value)
            if name in EMPTY_CONTAINERS:
                return EMPTY_CONTAINERS[name]
        return None

    def size_of(self, node: ast.expr | None, allow_value: bool = False) -> Size:
        """The size an expression measures, as a SizeRef; "const" or None.
        `allow_value`: a plain name counts as a size (n in range(n)), not only len()."""
        if node is None:
            return None
        if is_const(node):
            return "const"
        if isinstance(node, ast.Call):
            return self.call_size(node, allow_value)
        if isinstance(node, ast.Name):
            return self.name_size(node, allow_value)
        if isinstance(node, ast.Attribute):
            dotted = dotted_name(node)
            return {"name": dotted} if dotted and allow_value else None
        if isinstance(node, ast.BinOp):
            return self.binop_size(node, allow_value)
        if isinstance(node, ast.UnaryOp):
            return self.size_of(node.operand, allow_value)
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice):
            return self.length_of(node.value)
        return None

    def call_size(self, node: ast.Call, allow_value: bool) -> Size:
        """What a call measures: len(xs), min/int/abs of a size, sorted(xs), or a program's
        own function given a collection."""
        fname = call_name(node)
        if fname == "len" and node.args:
            return self.length_of(node.args[0])
        if fname in ("int", "abs", "round", "min", "max", "math.floor") and node.args:
            for arg in node.args:
                ref = self.size_of(arg, allow_value)
                if ref and ref != "const":
                    return ref
            return "const" if all(is_const(a) for a in node.args) else None
        if fname in self.user_functions:
            # A function given a collection usually returns something its size.
            for arg in node.args:
                ref = self.arg_ref(arg)
                if ref:
                    return dict(ref, len=True) if ref != "const" and self.looks_like_collection(arg) else ref
            return None
        if fname in ("sorted", "list", "set", "tuple", "reversed") and node.args:
            return self.length_of(node.args[0])
        return None

    def name_size(self, node: ast.Name, allow_value: bool) -> Size:
        """What a name stands for: the size its loop counts through, an alias (n = len(xs)), or itself."""
        if node.id in self.index_vars:
            sizes = self.index_vars[node.id]
            return sizes[0] if sizes else "const"
        if node.id in self.aliases:
            return self.aliases[node.id]
        if node.id in self.mids:
            return None
        return {"name": node.id} if allow_value else None

    def binop_size(self, node: ast.BinOp, allow_value: bool) -> Size:
        """len(xs) - 1, n * 2...: the size either side measures (a half is no size)."""
        if is_halving(node):
            return None
        found: list[Size] = [self.size_of(side, allow_value) for side in (node.left, node.right)]
        refs = [r for r in found if r and r != "const"]
        if refs:
            # Prefer a real size over a loop counter: len(arr) - i - 1 is len(arr).
            plain = [
                r
                for r, side in zip(found, (node.left, node.right))
                if r and r != "const" and not (isinstance(side, ast.Name) and side.id in self.index_vars)
            ]
            return (plain or refs)[0]
        return "const" if all(r == "const" for r in found) else None

    def length_of(self, node: ast.expr) -> Size:
        """len(node) as a SizeRef."""
        if isinstance(node, ast.Name):
            return self.name_length(node)
        if isinstance(node, ast.Subscript):
            return self.subscript_length(node)
        if isinstance(node, ast.Attribute):
            return self.attribute_length(node)
        if isinstance(node, ast.Call):
            return self.call_length(node)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set, ast.Dict, ast.Constant, ast.JoinedStr)):
            return "const"
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)) and node.generators:
            return self.length_of(node.generators[0].iter)
        if isinstance(node, ast.BinOp):  # a + b, [0] * n
            return self.binop_length(node)
        return None

    def name_length(self, node: ast.Name) -> SizeRef:
        """len(xs): an item of a collection is "inner" (a row of a grid); an alias may be a length already."""
        if node.id in self.elements:
            return dict(self.elements[node.id], inner=True)
        alias = self.aliases.get(node.id)
        if alias and alias.get("len"):
            return alias
        return {"name": node.id, "len": True}

    def subscript_length(self, node: ast.Subscript) -> Size:
        """nums[:k] is k long; nums[i:] or nums[a:b] up to len(nums); grid[i] is a row of grid."""
        if isinstance(node.slice, ast.Slice):
            sl = node.slice
            if sl.lower is None and sl.upper is not None and sl.step is None:
                ref = self.size_of(sl.upper, allow_value=True)
                if ref == "const" or (
                    ref
                    and not (isinstance(sl.upper, ast.Name) and sl.upper.id in self.mids)
                    and not is_halving(sl.upper)
                ):
                    return ref
            return self.length_of(node.value)
        base = dotted_name(node.value)
        if base:
            ref = self.name_length(node.value) if isinstance(node.value, ast.Name) else {"name": base, "len": True}
            return dict(ref, inner=True)
        return None

    def attribute_length(self, node: ast.Attribute) -> Size:
        """node.children, city.roads: an item of a structure; self.items: a collection."""
        base = dotted_name(node.value)
        if base and isinstance(node.value, ast.Name) and node.value.id not in self.containers:
            return {"name": base, "len": True, "inner": True}
        dotted = dotted_name(node)
        return {"name": dotted, "len": True} if dotted else None

    def call_length(self, node: ast.Call) -> Size:
        """How many items a call gives: d.items(), enumerate(xs), zip(xs, ys), range(n)..."""
        fname = call_name(node)
        if isinstance(node.func, ast.Attribute) and fname in (
            "items",
            "keys",
            "values",
            "split",
            "copy",
            "strip",
            "lower",
            "upper",
        ):
            return self.length_of(node.func.value)
        if fname in ("enumerate", "reversed", "sorted", "list", "set", "tuple", "iter") and node.args:
            return self.length_of(node.args[0])
        if fname == "zip" and node.args:
            return self.length_of(node.args[0])
        if fname == "range":
            return self.range_size(node)
        return self.size_of(node)

    def binop_length(self, node: ast.BinOp) -> Size:
        """[0] * n is n long; a + b as long as either."""
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

    def range_size(self, call: ast.Call) -> Size:
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

    def looks_like_collection(self, arg: ast.expr) -> bool:
        if isinstance(arg, ast.Subscript) and isinstance(arg.slice, ast.Slice):
            return True
        if isinstance(arg, ast.Name):
            return (
                arg.id in self.containers
                or arg.id in self.elements
                or (arg.id in self.params and self.used_as_collection(arg.id))
            )
        return False

    def used_as_collection(self, name: str) -> bool:
        for node in self.walk():
            if (
                isinstance(node, ast.Call)
                and call_name(node) == "len"
                and node.args
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id == name
            ):
                return True
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == name:
                return True
            if (
                isinstance(node, (ast.For, ast.comprehension))
                and isinstance(node.iter, ast.Name)
                and node.iter.id == name
            ):
                return True
        return False

    def arg_ref(self, arg: ast.expr) -> Size:
        """What an argument passes along, as a SizeRef the callee's sizes can be renamed to."""
        if isinstance(arg, ast.Name):
            if arg.id in self.aliases:
                return self.aliases[arg.id]
            if arg.id in self.index_vars or arg.id in self.mids:
                return None
            return {"name": arg.id}
        if isinstance(arg, ast.Attribute):
            dotted = dotted_name(arg)
            return {"name": dotted} if dotted else None
        if isinstance(arg, ast.Subscript) and isinstance(arg.slice, ast.Slice):
            return self.arg_ref(arg.value)
        if isinstance(arg, ast.Call) and call_name(arg) == "len" and arg.args:
            return self.length_of(arg.args[0])
        if isinstance(arg, ast.BinOp):
            for side in (arg.left, arg.right):
                ref = self.arg_ref(side)
                if ref:
                    return ref
        return None

    def for_bound(self, node: ast.For | ast.AsyncFor) -> Bound:
        it = node.iter
        ref = self.length_of(it)
        header = ast.unparse(it)
        target = node.target
        # Remember what the loop variable counts through, or is an item of.
        names = [target] if isinstance(target, ast.Name) else [t for t in ast.walk(target) if isinstance(t, ast.Name)]
        is_range = isinstance(it, ast.Call) and call_name(it) == "range"
        for t in names:
            if is_range or (isinstance(it, ast.Call) and call_name(it) == "enumerate" and t is names[0]):
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

    def collection_of(self, it: ast.expr) -> SizeRef | None:
        """The SizeRef of the collection a for loop walks, for its items."""
        if isinstance(it, ast.Call) and call_name(it) in ("enumerate", "reversed", "sorted", "zip", "list") and it.args:
            return self.collection_of(it.args[0])
        if (
            isinstance(it, ast.Call)
            and isinstance(it.func, ast.Attribute)
            and call_name(it) in ("items", "values", "keys")
        ):
            return self.collection_of(it.func.value)
        if isinstance(it, ast.Name):
            alias = self.aliases.get(it.id)
            return alias if alias and alias.get("len") else {"name": it.id, "len": True}
        return None
