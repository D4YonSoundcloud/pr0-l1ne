"""
The shape of the code, for complexity estimates.

A language-neutral description of each function (see CostInfo in
src/trace/types.ts): its loops and how many times each runs, calls to the
program's own functions and how their arguments shrink, built-ins that
aren't O(1), and memory that grows. trace/complexity.ts turns it into Big-O
and checks it against the run. Everything here is a heuristic about how
code is usually written; anything it can't size is marked "unknown" and
sized from the run instead.

The analysis of one function is split by question: what its names stand for
(shape_names.py), how many passes its while loops make (shape_loops.py),
what its expressions and calls cost (shape_costs.py), and here, the tree of
statements and whether it's memoized. Each module's class builds on the one
before, since they share what's learned about the function.
"""

import ast
from collections.abc import Iterator
from typing import Any

from shape_costs import ExprCosts
from shape_names import Bound, CostNode, UserFunctions, call_name, dotted_name, is_const

MEMO_DECORATORS = {"cache", "lru_cache"}


class FunctionShape(ExprCosts):
    """Builds one CostFunction."""

    #: The function's decorators' names (cost_analysis sets them): memoized functions cost differently.
    decorators: list[str | None]

    def __init__(
        self,
        name: str,
        line: int,
        params: list[str],
        body: list[ast.stmt],
        user_functions: UserFunctions,
        is_global: bool,
    ) -> None:
        self.decorators = []
        self.name = name
        self.line = line
        self.is_global = is_global
        self.recursive_args = []
        self.returned = set()  # ids of calls that are a whole `return f(...)`
        super().__init__(params, body, user_functions)

    def build(self) -> dict[str, Any]:
        body = self.block(self.body)
        return {"name": self.name, "line": self.line, "params": self.params, "memo": self.is_memoized(), "body": body}

    def block(self, stmts: list[ast.stmt], in_loop: bool = False) -> list[CostNode]:
        """The tree for a list of statements: loops as nodes, everything else flattened into them."""
        out = []
        for stmt in stmts:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(stmt, (ast.For, ast.AsyncFor)):
                out.extend(self.expr(stmt.iter, in_loop))
                out.append(self.loop_node(stmt, self.for_bound(stmt), self.block(stmt.body + stmt.orelse, True)))
            elif isinstance(stmt, ast.While):
                bound = self.while_bound(stmt)
                body = self.expr(stmt.test, True) + self.block(stmt.body + stmt.orelse, True)
                out.append(self.loop_node(stmt, bound, body))
            else:
                nested = self.compound(stmt, in_loop)
                if nested is not None:
                    out.extend(nested)
                    continue
                if isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Call):
                    self.returned.add(id(stmt.value))
                out.extend(self.statement(stmt, in_loop))
        return out

    @staticmethod
    def loop_node(stmt: ast.stmt, bound: Bound, body: list[CostNode]) -> CostNode:
        return {"kind": "loop", "loop": "L%d" % stmt.lineno, "line": stmt.lineno, "bound": bound, "body": body}

    def compound(self, stmt: ast.stmt, in_loop: bool) -> list[CostNode] | None:
        """The tree inside an if, with, try or match, in source order; None for any other statement."""
        if isinstance(stmt, ast.If):
            return self.expr(stmt.test, in_loop) + self.block(stmt.body, in_loop) + self.block(stmt.orelse, in_loop)
        if isinstance(stmt, (ast.With, ast.AsyncWith)):
            out = []
            for item in stmt.items:
                out.extend(self.expr(item.context_expr, in_loop))
            return out + self.block(stmt.body, in_loop)
        if isinstance(stmt, ast.Try) or (hasattr(ast, "TryStar") and isinstance(stmt, ast.TryStar)):
            out = self.block(stmt.body, in_loop)
            for handler in stmt.handlers:
                out.extend(self.block(handler.body, in_loop))
            return out + self.block(stmt.orelse, in_loop) + self.block(stmt.finalbody, in_loop)
        if hasattr(ast, "Match") and isinstance(stmt, ast.Match):
            out = self.expr(stmt.subject, in_loop)
            for case in stmt.cases:
                out.extend(self.block(case.body, in_loop))
            return out
        return None

    def statement(self, stmt: ast.stmt, in_loop: bool) -> list[CostNode]:
        out = []
        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, ast.expr):
                out.extend(self.expr(child, in_loop))
        # Memory that's created or grows.
        if isinstance(stmt, ast.Assign):
            value = stmt.value
            sizes = self.alloc_sizes(value)
            only = stmt.targets[0] if len(stmt.targets) == 1 else None
            name = only.id if isinstance(only, ast.Name) else None
            if sizes:
                out.append(
                    {
                        "kind": "alloc",
                        "line": stmt.lineno,
                        "what": ast.unparse(value)[:40],
                        "sizes": sizes,
                        **({"name": name} if name else {}),
                    }
                )
            for target in stmt.targets:
                # node.children[ch] = TrieNode(): a structure growing by a new object
                if (
                    isinstance(target, ast.Subscript)
                    and isinstance(target.value, ast.Attribute)
                    and isinstance(value, ast.Call)
                    and isinstance(value.func, ast.Name)
                    and value.func.id[:1].isupper()
                ):
                    base = dotted_name(target.value)
                    if base:
                        out.append(
                            {
                                "kind": "alloc",
                                "line": stmt.lineno,
                                "what": base + "[...] = " + value.func.id + "()",
                                "sizes": [],
                                "into": base,
                            }
                        )
                if (
                    isinstance(target, ast.Subscript)
                    and isinstance(target.value, ast.Name)
                    and self.containers.get(target.value.id) == "dict"
                ):
                    out.append(
                        {
                            "kind": "alloc",
                            "line": stmt.lineno,
                            "what": target.value.id + "[...] = ...",
                            "sizes": [],
                            "into": target.value.id,
                        }
                    )
        return out

    def is_memoized(self) -> bool:
        if self.is_global:
            return False
        if any(name in MEMO_DECORATORS for name in self.decorators):
            return True
        # if n in memo: return memo[n] ... memo[n] = ...
        checked, stored = set(), set()
        for node in self.walk():
            if (
                isinstance(node, ast.If)
                and isinstance(node.test, ast.Compare)
                and any(isinstance(op, ast.In) for op in node.test.ops)
                and any(isinstance(s, ast.Return) for s in node.body)
            ):
                container = dotted_name(node.test.comparators[0])
                if container:
                    checked.add(container)
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Subscript):
                        base = dotted_name(target.value)
                        if base:
                            stored.add(base)
        return bool(checked & stored)


def explorations(shape: FunctionShape) -> bool:
    """A parameter moved both ways across recursive calls (r + 1 and r - 1) is a search, not a shrink."""
    moves = {}
    for args in shape.recursive_args:
        for param, arg in args:
            if (
                isinstance(arg, ast.BinOp)
                and isinstance(arg.left, ast.Name)
                and arg.left.id == param
                and is_const(arg.right)
            ):
                moves.setdefault(param, set()).add(type(arg.op).__name__)
    return any(len(ops) > 1 for ops in moves.values())


def cost_analysis(tree: ast.Module) -> dict[str, Any]:
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
        shape.decorators = [
            (
                call_name(d)
                if isinstance(d, ast.Call)
                else (d.attr if isinstance(d, ast.Attribute) else getattr(d, "id", ""))
            )
            for d in node.decorator_list
        ]
        built = shape.build()
        if explorations(shape):
            for call in iter_calls(built["body"]):
                if call["callee"] == name:
                    call["shrink"] = "unknown"
        functions.append(built)
    return {"functions": functions}


def iter_calls(nodes: list[CostNode]) -> Iterator[CostNode]:
    for node in nodes:
        if node["kind"] == "call":
            yield node
        elif node["kind"] == "loop":
            yield from iter_calls(node["body"])
