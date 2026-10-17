"""
Measure's counters, added to the program by rewriting its syntax tree (see
measure.py). Each statement gets `_mc[line] += 1` before it, each loop body
`_mp[line] += 1`, each function `_mf[def line] += 1`, and every so often a
check of the clock (`_mpoll()`). Built-ins that aren't O(1) are wrapped so
their work is counted as they run (`_mw(line, xs, kind) or xs.insert(...)`).
Line numbers are kept, so errors point at the right line.
"""

import ast

from analysis import USER_FILENAME


def _pure(node: ast.AST | None) -> bool:
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


def _name(id_: str, ctx: ast.expr_context | None = None) -> ast.Name:
    return ast.Name(id=id_, ctx=ctx or ast.Load())


def _count(array: str, line: int, amount: int = 1) -> ast.AugAssign:
    """array[line] += amount"""
    return ast.AugAssign(
        target=ast.Subscript(value=_name(array), slice=ast.Constant(line), ctx=ast.Store()),
        op=ast.Add(),
        value=ast.Constant(amount),
    )


def _poll() -> list[ast.stmt]:
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


def _call(fn: str, *args: ast.expr) -> ast.Call:
    return ast.Call(func=_name(fn), args=list(args), keywords=[])


def _before(work: ast.expr, expr: ast.expr) -> ast.BoolOp:
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
    """Adds the counters to a program's syntax tree (see the module docstring)."""

    # -- statements -----------------------------------------------------------

    def body(
        self, stmts: list[ast.stmt], loop_line: int | None = None, function: bool = False, def_line: int | None = None
    ) -> list[ast.stmt]:
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
            out.append(_count("_mc", stmt.lineno))
            out.append(stmt)
        return out

    def generic_visit(self, node: ast.AST) -> ast.AST:
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
        return node

    def wrap_existing(self, stmts: list[ast.stmt]) -> list[ast.stmt]:
        """Add counters to an already-visited statement list."""
        out = []
        for stmt in stmts:
            if not (
                isinstance(stmt, ast.AugAssign)
                and isinstance(stmt.target, ast.Subscript)
                and isinstance(stmt.target.value, ast.Name)
                and stmt.target.value.id in ("_mc", "_mp", "_mf", "_mt")
            ):
                out.append(_count("_mc", stmt.lineno))
            out.append(stmt)
        return out

    def visit_Module(self, node: ast.Module) -> ast.Module:
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

    def visit_While(self, node: ast.While) -> ast.While:
        node.test = self.visit(node.test)
        node.body = self.body(node.body, loop_line=node.lineno)
        node.orelse = self.wrap_existing([self.visit(s) for s in node.orelse])
        return node

    # Every other compound statement (if, with, try, match, class): count
    # the statements in each of its blocks.
    def visit_If(self, node: ast.If) -> ast.If:
        node.test = self.visit(node.test)
        node.body = self.wrap_existing([self.visit(s) for s in node.body])
        node.orelse = self.wrap_existing([self.visit(s) for s in node.orelse])
        return node

    def visit_ClassDef(self, node: ast.ClassDef) -> ast.ClassDef:
        node.bases = [self.visit(b) for b in node.bases]
        node.body = self.wrap_existing([self.visit(s) for s in node.body])
        return node

    # -- expressions: work inside built-ins ------------------------------------

    def visit_Call(self, node: ast.Call) -> ast.expr:
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

    def visit_Compare(self, node: ast.Compare) -> ast.expr:
        self.generic_visit(node)
        if len(node.ops) == 1 and isinstance(node.ops[0], (ast.In, ast.NotIn)) and _pure(node.comparators[0]):
            work = _call("_mw", ast.Constant(node.lineno), node.comparators[0], ast.Constant("s"))
            return ast.copy_location(_before(work, node), node)
        return node

    def visit_Subscript(self, node: ast.Subscript) -> ast.expr:
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
    def visit_comprehension(self, node: ast.comprehension) -> ast.comprehension:
        self.generic_visit(node)
        node.iter = ast.copy_location(_call("_mcomp", ast.Constant(node.iter.lineno), node.iter), node.iter)
        return node


def _is_minus_one(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.UnaryOp)
        and isinstance(node.op, ast.USub)
        and isinstance(node.operand, ast.Constant)
        and node.operand.value == 1
    )


def apply_overrides(tree: ast.Module, overrides: dict[str, int] | None) -> ast.Module:
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


def instrument(source: str, overrides: dict[str, int] | None = None) -> ast.Module:
    """The program's syntax tree with its counters added (and growth-run sizes set)."""
    tree = Counters().visit(apply_overrides(ast.parse(source, USER_FILENAME), overrides))
    ast.fix_missing_locations(tree)
    return tree
