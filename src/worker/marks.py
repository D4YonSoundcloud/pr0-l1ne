"""
Marks: which objects the program may have written to since a step read them.

Reading every object at every step is most of what a recorded step costs (a
big tree is thousands of objects, nearly all as they were). So the program is
rewritten before it runs to note, as it goes, each object a write may land
on: the object a field or item is stored into or deleted from, the result of
an augmented assignment (`xs += ys` changes the list it holds), and the
receiver, arguments and callee of a call that could change what it's given
(`xs.sort()`, `heapq.heappush(h, x)`, `push = xs.append; push(1)`). The
serializer then reads an object only when it's marked (or new); one it holds
from before that isn't is the same as when it was read (serialize.py).

The note is a C-level expression, so it adds no Python frame (and no trace
event): `max((E,), key=__viz_r__)` is E, after `__viz_r__` (a list's append)
has been given it. The tracer turns what was appended into marks, and keeps
them marked until the statement that made them is done (tracer.py
`settle_marks`), since steps recorded part-way (a callback of `xs.sort(key=f)`)
read the object before the write lands.

What can't be followed this way (eval, exec, a class's `__dict__`...) makes
the whole run read every object, as without marks (`unsafe`). And every 500
steps, and at the program's last, every object is read anyway and checked:
one marks would have skipped that changed is a write they missed, reported,
and the rest of the run reads everything (Tracer.record).

test_marks.py traces every way of writing in write_catalogue.py with marks and
without: the two traces must be the same.
"""

import ast
import builtins

# The helpers the rewritten program calls, put in its globals (tracer.py).
RECORD = "__viz_r__"  # the tracer's list of what may have been written: its append
RECORD_EACH = "__viz_rx__"  # ...and its extend
TUPLE = "__viz_tuple__"  # builtins.tuple
MAX = "__viz_max__"  # builtins.max, by a name the program can't rebind
TEMP = "__viz_t%d__"  # an augmented assignment's target, evaluated once

# Builtins that change nothing they're given (or only call the program's own
# code, which is rewritten too), called by their own name: no marks.
PURE_BUILTINS = frozenset(
    """abs all any ascii bin bool bytes callable chr complex dict divmod enumerate filter float format
    frozenset getattr hasattr hash hex id int isinstance issubclass iter len list map max min next
    object oct ord pow print range repr reversed round set slice sorted str sum super tuple type zip
    ArithmeticError AssertionError AttributeError BaseException Exception IndexError KeyError
    LookupError NameError NotImplementedError OverflowError RecursionError RuntimeError StopIteration
    TypeError ValueError ZeroDivisionError""".split()
)

# Names whose code marks can't follow: the run reads every object instead.
UNSAFE_NAMES = {
    "eval": "eval",
    "exec": "exec",
    "compile": "compile",
    "__import__": "__import__",
    "vars": "vars()",  # vars(o)[k] = v writes o through its __dict__
    "cached_property": "cached_property",  # a read that writes the object's __dict__
}
UNSAFE_MODULES = {"ctypes", "gc", "importlib"}

# operator's in-place function for each augmented assignment.
IN_PLACE = {
    ast.Add: "iadd",
    ast.Sub: "isub",
    ast.Mult: "imul",
    ast.MatMult: "imatmul",
    ast.Div: "itruediv",
    ast.FloorDiv: "ifloordiv",
    ast.Mod: "imod",
    ast.Pow: "ipow",
    ast.LShift: "ilshift",
    ast.RShift: "irshift",
    ast.BitAnd: "iand",
    ast.BitOr: "ior",
    ast.BitXor: "ixor",
}


def in_place_name(op: ast.operator) -> str:
    return "__viz_%s__" % IN_PLACE[type(op)]


def helpers(record: list) -> dict:
    """The rewritten program's helpers, for its globals: `record` is the tracer's list of notes."""
    import operator

    out = {RECORD: record.append, RECORD_EACH: record.extend, MAX: builtins.max, TUPLE: builtins.tuple}
    for name in IN_PLACE.values():
        out["__viz_%s__" % name] = getattr(operator, name)
    return out


# Expressions whose value is never an object the program had before (a new
# object or a primitive): nothing to mark.
FRESH = (
    ast.Constant,
    ast.JoinedStr,
    ast.Lambda,
    ast.List,
    ast.Tuple,
    ast.Set,
    ast.Dict,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Compare,
)


def mark(node: ast.expr) -> ast.expr:
    """node, noted as an object that may be written to: max((node,), key=__viz_r__)."""
    if isinstance(node, FRESH) or is_helper(node):
        return node
    return noted(node)


def noted(node: ast.expr, record: str = RECORD) -> ast.expr:
    """max((node,), key=record): node, after record(node). (A C call: no Python frame.)"""
    out = ast.Call(
        func=ast.Name(id=MAX, ctx=ast.Load()),
        args=[ast.Tuple(elts=[node], ctx=ast.Load())],
        keywords=[ast.keyword(arg="key", value=ast.Name(id=record, ctx=ast.Load()))],
    )
    return ast.copy_location(out, node)


def each_noted(node: ast.expr) -> ast.expr:
    """*xs's items, each noted: max((tuple(xs),), key=__viz_rx__), the extend of the same list."""
    items = ast.Call(func=ast.Name(id=TUPLE, ctx=ast.Load()), args=[node], keywords=[])
    return noted(ast.copy_location(items, node), RECORD_EACH)


def is_helper(node: ast.expr) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id.startswith("__viz_")


class Names(ast.NodeVisitor):
    """How each name is bound anywhere in the program (any scope): by def or
    class only, by import only, or otherwise."""

    def __init__(self) -> None:
        self.defined: set[str] = set()  # def, async def, class
        self.imported: set[str] = set()
        self.other: set[str] = set()  # assigned, a parameter, a loop variable...
        self.unsafe: str | None = None

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.defined.add(node.name)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.visit_FunctionDef(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.defined.add(node.name)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name.split(".")[0] in UNSAFE_MODULES:
                self.unsafe = self.unsafe or "import %s" % alias.name
            self.imported.add((alias.asname or alias.name).split(".")[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if (node.module or "").split(".")[0] in UNSAFE_MODULES:
            self.unsafe = self.unsafe or "from %s import" % node.module
        for alias in node.names:
            if alias.name in UNSAFE_NAMES:
                self.unsafe = self.unsafe or UNSAFE_NAMES[alias.name]
            if alias.name == "*":
                self.unsafe = self.unsafe or "import *"
            self.imported.add(alias.asname or alias.name)

    def visit_Name(self, node: ast.Name) -> None:
        if not isinstance(node.ctx, ast.Load):
            self.other.add(node.id)
        elif node.id in UNSAFE_NAMES:
            self.unsafe = self.unsafe or UNSAFE_NAMES[node.id]

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr == "__dict__":
            self.unsafe = self.unsafe or "__dict__"
        elif node.attr in UNSAFE_NAMES and node.attr != "compile":  # re.compile is fine
            self.unsafe = self.unsafe or UNSAFE_NAMES[node.attr]
        self.generic_visit(node)

    def visit_arg(self, node: ast.arg) -> None:
        self.other.add(node.arg)

    def visit_Global(self, node: ast.Global | ast.Nonlocal) -> None:
        self.other.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.visit_Global(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.name:
            self.other.add(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node: ast.MatchAs) -> None:
        if node.name:
            self.other.add(node.name)
        self.generic_visit(node)

    def visit_MatchStar(self, node: ast.MatchStar) -> None:
        if node.name:
            self.other.add(node.name)

    def visit_MatchMapping(self, node: ast.MatchMapping) -> None:
        if node.rest:
            self.other.add(node.rest)
        self.generic_visit(node)


class Marks(ast.NodeTransformer):
    """The rewrite (see the module's docstring)."""

    def __init__(self, names: Names) -> None:
        # Called by name, these change nothing they're given that marks don't see:
        # the program's own functions and classes (their code is rewritten too),
        # and builtins that only read.
        only = names.defined - names.other - names.imported
        self.own = only | (PURE_BUILTINS - names.defined - names.other - names.imported)
        self.modules = names.imported - names.defined - names.other
        self.temps = 0
        self.in_class = 0  # directly in a class body
        self.unsafe: str | None = None

    # -- scopes ------------------------------------------------------------

    def visit_FunctionDef(self, node: ast.AST) -> ast.AST:
        saved = self.in_class
        self.in_class = 0
        self.generic_visit(node)
        self.in_class = saved
        return node

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:
        return self.visit_FunctionDef(node)

    def visit_Lambda(self, node: ast.Lambda) -> ast.AST:
        return self.visit_FunctionDef(node)

    def visit_ClassDef(self, node: ast.ClassDef):
        saved = self.in_class
        self.in_class = 1
        self.generic_visit(node)
        self.in_class = saved
        return node

    # -- writes ------------------------------------------------------------

    def target(self, node: ast.expr) -> ast.expr:
        """A place written to: the object holding it marked (o.a, xs[i])."""
        if isinstance(node, (ast.Attribute, ast.Subscript)):
            node.value = mark(node.value)
        elif isinstance(node, (ast.Tuple, ast.List)):
            node.elts = [self.target(elt) for elt in node.elts]
        elif isinstance(node, ast.Starred):
            node.value = self.target(node.value)
        return node

    def visit_Assign(self, node: ast.Assign):
        self.generic_visit(node)
        node.targets = [self.target(t) for t in node.targets]
        return node

    def visit_AnnAssign(self, node: ast.AnnAssign):
        self.generic_visit(node)
        if node.value is not None:
            self.target(node.target)  # (in place: its holder marked)
        return node

    def visit_Delete(self, node: ast.Delete):
        self.generic_visit(node)
        node.targets = [self.target(t) for t in node.targets]
        return node

    def visit_For(self, node: ast.For | ast.AsyncFor) -> ast.AST:
        self.generic_visit(node)
        node.target = self.target(node.target)
        return node

    def visit_AsyncFor(self, node: ast.AsyncFor) -> ast.AST:
        return self.visit_For(node)

    def visit_withitem(self, node: ast.withitem):
        self.generic_visit(node)
        if node.optional_vars is not None:
            node.optional_vars = self.target(node.optional_vars)
        return node

    def visit_comprehension(self, node: ast.comprehension):
        self.generic_visit(node)
        node.target = self.target(node.target)
        return node

    def visit_AugAssign(self, node: ast.AugAssign):
        """x op= v changes what x holds when it's a list or set (in place): the result
        is marked too. Written out as operator's in-place function, which is what
        op= does: x = iop(x, v), with o and k evaluated once for o.a op= v and
        o[k] op= v."""
        self.generic_visit(node)
        op = ast.Name(id=in_place_name(node.op), ctx=ast.Load())
        target = node.target
        if isinstance(target, ast.Name):
            load = ast.Name(id=target.id, ctx=ast.Load())
            value = ast.Call(func=op, args=[load, node.value], keywords=[])
            out = ast.Assign(targets=[ast.Name(id=target.id, ctx=ast.Store())], value=noted(value))
            return ast.copy_location(out, node)
        if self.in_class:
            # Temporaries would be the class's attributes: not rewritten.
            self.unsafe = self.unsafe or "an augmented assignment to a field in a class body"
            self.target(target)  # (in place: its holder marked)
            return node
        holder = self.temp()
        if isinstance(target, ast.Attribute):
            # o.a op= v  ->  T.a = mark(iop((T := mark(o)).a, v))
            first = ast.Attribute(value=self.walrus(holder, mark(target.value)), attr=target.attr, ctx=ast.Load())
            store = ast.Attribute(value=ast.Name(id=holder, ctx=ast.Load()), attr=target.attr, ctx=ast.Store())
        else:
            assert isinstance(target, ast.Subscript)
            # o[k] op= v  ->  T[K] = mark(iop((T := mark(o))[(K := k)], v))
            key = self.temp()
            first = ast.Subscript(
                value=self.walrus(holder, mark(target.value)), slice=self.walrus(key, target.slice), ctx=ast.Load()
            )
            store = ast.Subscript(
                value=ast.Name(id=holder, ctx=ast.Load()), slice=ast.Name(id=key, ctx=ast.Load()), ctx=ast.Store()
            )
        value = ast.Call(func=op, args=[first, node.value], keywords=[])
        out = ast.Assign(targets=[store], value=noted(value))
        return ast.copy_location(out, node)

    def temp(self) -> str:
        self.temps += 1
        return TEMP % self.temps

    @staticmethod
    def walrus(name: str, value: ast.expr) -> ast.expr:
        return ast.NamedExpr(target=ast.Name(id=name, ctx=ast.Store()), value=value)

    # -- calls -------------------------------------------------------------

    def visit_Call(self, node: ast.Call):
        self.generic_visit(node)
        func = node.func
        if isinstance(func, ast.Name):
            if func.id.startswith("__viz_") or func.id in self.own:
                return node
            if func.id not in self.modules:
                # A function in a variable (a bound method, a partial) may write to what it's bound to.
                node.func = mark(func)
        elif isinstance(func, ast.Attribute):
            receiver = func.value
            if not (isinstance(receiver, ast.Name) and receiver.id in self.modules):
                func.value = mark(receiver)
        else:
            node.func = mark(func)
        node.args = [
            ast.copy_location(ast.Starred(value=each_noted(a.value), ctx=ast.Load()), a)
            if isinstance(a, ast.Starred)
            else mark(a)
            for a in node.args
        ]
        for kw in node.keywords:
            kw.value = mark(kw.value)
        return node


def add_marks(tree: ast.Module) -> tuple[ast.Module, str | None]:
    """The program rewritten to mark what it may write to, and why marks can't be
    trusted for it, if they can't (the run then reads every object)."""
    names = Names()
    names.visit(tree)
    marks = Marks(names)
    out = marks.visit(tree)
    return ast.fix_missing_locations(out), names.unsafe or marks.unsafe
