"""
The shape of the code, part 3: what expressions and calls cost.

Calls to the program's own functions (and how a recursive call's arguments
shrink), built-ins that aren't O(1) (sorted, sum, x in list, list.pop(0)...)
and memory that's made or grows. Builds on shape_loops.py.
"""

import ast

from shape_loops import LoopBounds
from shape_names import CostNode, Size, SizeRef, call_name, dotted_name, is_const, is_halving

Comprehension = ast.ListComp | ast.SetComp | ast.GeneratorExp | ast.DictComp

LINEAR_BUILTINS = {
    "sum",
    "min",
    "max",
    "any",
    "all",
    "list",
    "tuple",
    "set",
    "frozenset",
    "dict",
    "sorted",
    "Counter",
    "deque",
}
LOG_FUNCTIONS = {
    "heappush",
    "heappop",
    "heappushpop",
    "heapreplace",
    "bisect",
    "bisect_left",
    "bisect_right",
    "insort",
    "insort_left",
    "insort_right",
}
GROW_METHODS = {"append", "appendleft", "add", "extend", "extendleft", "insert", "setdefault", "update"}


class ExprCosts(LoopBounds):
    """The costs in one function's expressions."""

    # Set by FunctionShape: the function's name (a call to it is recursive),
    # the ids of calls that are a whole `return f(...)`, and each recursive
    # call's (parameter, argument) pairs (see shape.explorations).
    name: str
    returned: set[int]
    recursive_args: list[list[tuple[str, ast.expr]]]

    def alloc_sizes(self, value: ast.expr) -> list[SizeRef] | None:
        """Sizes multiplied together if value makes a new collection sized by them, else None."""
        if isinstance(value, ast.BinOp):
            return self.binop_alloc(value)
        if isinstance(value, (ast.ListComp, ast.SetComp, ast.DictComp)):
            sizes = []
            for gen in value.generators:
                ref = self.length_of(gen.iter)
                if ref and ref != "const":
                    sizes.append(ref)
            inner = self.alloc_sizes(value.elt) if isinstance(value, (ast.ListComp, ast.SetComp)) else None
            return sizes + (inner or []) if sizes or inner else None
        if isinstance(value, ast.Subscript) and isinstance(value.slice, ast.Slice):
            return self.sized(self.length_of(value.value))
        if isinstance(value, ast.Call):
            return self.call_alloc(value)
        return None

    @staticmethod
    def sized(ref: Size) -> list[SizeRef] | None:
        """[ref] when ref is a real size, else None."""
        return [ref] if ref and ref != "const" else None

    def binop_alloc(self, value: ast.BinOp) -> list[SizeRef] | None:
        """[0] * n makes n items; a + b makes whatever either side makes."""
        if isinstance(value.op, ast.Mult) and isinstance(value.left, (ast.List, ast.Tuple)):
            return self.sized(self.size_of(value.right, allow_value=True))
        if isinstance(value.op, ast.Add):
            for side in (value.left, value.right):
                sizes = self.alloc_sizes(side)
                if sizes:
                    return sizes
        return None

    def call_alloc(self, value: ast.Call) -> list[SizeRef] | None:
        """list(xs), sorted(xs), xs.copy(): a copy as big as xs."""
        name = call_name(value)
        if name in ("list", "sorted", "set", "dict", "tuple", "deque", "Counter", "copy", "frozenset") and value.args:
            return self.sized(self.length_of(value.args[0]))
        if name == "copy" and isinstance(value.func, ast.Attribute):
            return self.sized(self.length_of(value.func.value))
        return None

    def expr(self, node: ast.expr | None, in_loop: bool) -> list[CostNode]:
        """Calls, costly built-ins, comprehensions and growth in an expression, in source order."""
        if node is None or isinstance(node, ast.Lambda):
            return []
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            return self.comprehension(node, node.generators, in_loop)
        out = []
        if isinstance(node, ast.Call):
            for arg in [node.func] + node.args + [k.value for k in node.keywords]:
                out.extend(self.expr(arg, in_loop))
            out.extend(self.call(node))
            return out
        if isinstance(node, ast.Compare):
            for child in [node.left] + node.comparators:
                out.extend(self.expr(child, in_loop))
            out.extend(self.membership_costs(node))
            return out
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice) and isinstance(node.ctx, ast.Load):
            return self.expr(node.value, in_loop) + self.slice_cost(node)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                out.extend(self.expr(child, in_loop))
        return out

    def slice_cost(self, node: ast.Subscript) -> list[CostNode]:
        """xs[a:b] copies that part of xs."""
        ref = self.length_of(node)
        if not (ref and ref != "const"):
            return []
        return [
            {
                "kind": "op",
                "line": node.lineno,
                "what": ast.unparse(node)[:30] + " (copies)",
                "cost": "linear",
                "size": ref,
            }
        ]

    def membership_costs(self, node: ast.Compare) -> list[CostNode]:
        """`x in xs` walks a list (but not a set, a dict or a range)."""
        out = []
        for op, right in zip(node.ops, node.comparators):
            if not isinstance(op, (ast.In, ast.NotIn)):
                continue
            container = dotted_name(right)
            kind = self.containers.get(container) if container else None
            if isinstance(right, (ast.Set, ast.Dict, ast.Constant)) or kind in ("dict", "set"):
                continue
            if isinstance(right, ast.Call) and call_name(right) == "range":
                continue
            ref = self.length_of(right)
            if ref and ref != "const":
                out.append(
                    {
                        "kind": "op",
                        "line": node.lineno,
                        "what": "in " + ast.unparse(right)[:30],
                        "cost": "linear",
                        "size": ref,
                        **({"container": container} if container else {}),
                    }
                )
        return out

    def comprehension(self, node: Comprehension, generators: list[ast.comprehension], in_loop: bool) -> list[CostNode]:
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

    def call(self, node: ast.Call) -> list[CostNode]:
        """What one call costs: a call to the program's own function, or a built-in that isn't O(1)."""
        name = call_name(node)
        if name is None:  # f()(x), fs[0](x): nothing to go by
            return []
        func = node.func
        is_method = isinstance(func, ast.Attribute)
        receiver = dotted_name(func.value) if isinstance(func, ast.Attribute) else None
        # A method call is the program's own when it's called on an object
        # (stack.push(x), self.helper()), not on a collection it holds
        # (self.items.pop() is the list's pop, even in a class with a pop).
        own_method = not isinstance(func, ast.Attribute) or (
            isinstance(func.value, ast.Name) and receiver not in self.containers
        )
        if name in self.user_functions and own_method:
            return [self.own_call(node, name)]
        if name in LOG_FUNCTIONS and node.args:
            return self.log_call(node, name)
        if not is_method and name in LINEAR_BUILTINS and len(node.args) == 1:
            return self.builtin_call(node, name)
        if isinstance(func, ast.Attribute) and receiver:
            return self.method_call(node, name, receiver, func.value)
        return []

    def own_call(self, node: ast.Call, name: str) -> CostNode:
        """A call to one of the program's functions; a recursive one says how its arguments shrink."""
        args = [self.arg_ref(a) for a in node.args]
        shrink = self.shrink(node) if name == self.name else "same"
        return {
            "kind": "call",
            "line": node.lineno,
            "callee": name,
            "args": args,
            "shrink": shrink,
            **({"alt": True} if id(node) in self.returned else {}),
        }

    def log_call(self, node: ast.Call, name: str) -> list[CostNode]:
        """heapq and bisect: log n, and pushing or inserting grows the collection."""
        line = node.lineno
        ref = self.length_of(node.args[0])
        out = [
            {"kind": "op", "line": line, "what": name + "()", "cost": "log", "size": ref if ref != "const" else None}
        ]
        if name in ("heappush", "insort", "insort_left", "insort_right"):
            into = dotted_name(node.args[0])
            out.append(
                {"kind": "alloc", "line": line, "what": name + "()", "sizes": [], **({"into": into} if into else {})}
            )
        return out

    def builtin_call(self, node: ast.Call, name: str) -> list[CostNode]:
        """sum(xs), sorted(xs), list(xs)...: a walk over xs (sorted: n log n), and some copy it."""
        ref = self.length_of(node.args[0])
        if not (ref and ref != "const"):
            return []
        copies = (
            " (copies)" if name in ("sorted", "list", "tuple", "set", "frozenset", "dict", "deque", "Counter") else ""
        )
        return [
            {
                "kind": "op",
                "line": node.lineno,
                "what": name + "()" + copies,
                "size": ref,
                "cost": "nlogn" if name == "sorted" else "linear",
            }
        ]

    def method_call(self, node: ast.Call, name: str, receiver: str, owner: ast.expr) -> list[CostNode]:
        """A method on a collection (`owner`, named `receiver`): what it costs, and whether it grows the collection."""
        out = self.method_cost(node, name, receiver, owner)
        if name in GROW_METHODS and name != "extend":
            out.append(
                {
                    "kind": "alloc",
                    "line": node.lineno,
                    "what": receiver + "." + name + "()",
                    "sizes": [],
                    "into": receiver,
                }
            )
        return out

    def method_cost(self, node: ast.Call, name: str, receiver: str, owner: ast.expr) -> list[CostNode]:
        """xs.sort() is n log n; xs.index(), xs.pop(0), ", ".join(xs)... walk the list."""
        line = node.lineno
        if name == "sort":
            size = self.length_of(owner)
            return [{"kind": "op", "line": line, "what": receiver + ".sort()", "cost": "nlogn", "size": size}]
        if name == "join":
            ref = self.length_of(node.args[0]) if node.args else None
            return (
                [{"kind": "op", "line": line, "what": "join()", "cost": "linear", "size": ref}]
                if self.sized(ref)
                else []
            )
        if name == "extend":
            ref = self.length_of(node.args[0]) if node.args else None
            if not self.sized(ref):
                return []
            what = receiver + ".extend()"
            return [
                {"kind": "op", "line": line, "what": what, "cost": "linear", "size": ref},
                {"kind": "alloc", "line": line, "what": what, "sizes": [ref], "into": receiver},
            ]
        if self.walks_list(node, name, receiver):
            ref = self.length_of(owner)
            if self.sized(ref):
                what = receiver + (".pop(0)" if name == "pop" else "." + name + "()")
                return [
                    {"kind": "op", "line": line, "what": what, "cost": "linear", "size": ref, "container": receiver}
                ]
        return []

    def walks_list(self, node: ast.Call, name: str, receiver: str) -> bool:
        """index, count, remove, reverse, copy, insert (not a dict's) and pop(0) go through the list."""
        if name in ("index", "count", "remove", "reverse", "copy"):
            return True
        if name == "insert":
            return self.containers.get(receiver) != "dict"
        return (
            name == "pop" and bool(node.args) and is_const(node.args[0]) and getattr(node.args[0], "value", None) == 0
        )

    def shrink(self, call: ast.Call) -> str:
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

    def arg_shrink(self, arg: ast.expr, param: str | None) -> str:
        """How one argument of a recursive call compares with its parameter: "same", "const",
        "half" (n // 2, nums[:mid]), "child" (node.left, an item), "minus" (n - 1, nums[1:]) or "unknown"."""
        if is_const(arg):
            return "const"
        if isinstance(arg, ast.Name):
            return self.name_shrink(arg, param)
        names = {n.id for n in ast.walk(arg) if isinstance(n, ast.Name)}
        if names & self.mids or is_halving(arg):
            return "half"
        if isinstance(arg, ast.Attribute) and self.root_name(arg) in self.params:
            return "child"
        if isinstance(arg, ast.Subscript) and isinstance(arg.slice, ast.Slice):
            sl = arg.slice
            bounds = [b for b in (sl.lower, sl.upper) if b is not None]
            if any(
                is_halving(b) or ({n.id for n in ast.walk(b) if isinstance(n, ast.Name)} & self.mids) for b in bounds
            ):
                return "half"
            return "minus"
        if (
            isinstance(arg, ast.BinOp)
            and isinstance(arg.op, (ast.Add, ast.Sub))
            and is_const(arg.right)
            and isinstance(arg.left, ast.Name)
            and arg.left.id in self.params
        ):
            return "minus"
        return "unknown"

    def name_shrink(self, arg: ast.Name, param: str | None) -> str:
        """A name passed to a recursive call: the parameter itself, a midpoint, an item, or a slice made earlier."""
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
