"""
The shape of the code, part 2: how many passes a while loop makes.

A loop that halves what it tests runs log n times (binary search, n //= 2);
one that follows a link walks a structure (node = node.next); one that
counts toward a size runs that many times (while i < n: i += 1). Anything
else is "unknown", and the run sizes it instead. Builds on shape_names.py.
"""

import ast

from shape_names import Bound, NameSizes, Size, is_const, is_halving, walk_shallow


class LoopBounds(NameSizes):
    """Bounds for one function's while loops (for loops: NameSizes.for_bound)."""

    def while_bound(self, node: ast.While) -> Bound:
        """A while loop's bound: halving, following a link, counting, or unknown."""
        test = node.test
        header = "while " + ast.unparse(test)
        test_names = {n.id for n in ast.walk(test) if isinstance(n, ast.Name)}
        changes = self.changes(node)
        return (
            self.halving_bound(test, header, changes, test_names)
            or self.following_bound(node, header, changes)
            or self.counting_bound(test, header, changes, test_names)
            or {"kind": "unknown", "why": header}
        )

    def changes(self, node: ast.While) -> dict[str, str]:
        """How the loop's body changes each name: "log" (halves or doubles), "follow"
        (node = node.next) or "step" (i += 1)."""
        changes = {}  # name -> how the body changes it
        for sub in walk_shallow(ast.Module(body=node.body, type_ignores=[])):
            if isinstance(sub, ast.AugAssign) and isinstance(sub.target, ast.Name):
                change = self.augmented_change(sub)
                if change == "log":
                    changes[sub.target.id] = "log"
                elif change == "step":
                    changes.setdefault(sub.target.id, "step")
            elif isinstance(sub, ast.Assign):
                for target in sub.targets:
                    for t, v in self.pairs(target, sub.value):
                        if isinstance(t, ast.Name):
                            self.assigned_change(t.id, v, node.body, changes)
        return changes

    @staticmethod
    def augmented_change(sub: ast.AugAssign) -> str | None:
        """n //= 2, x *= 2, x <<= 1: "log"; i += 1: "step"."""
        op = sub.op
        if (
            isinstance(op, (ast.FloorDiv, ast.RShift, ast.Div))
            or (isinstance(op, ast.Mult) and is_const(sub.value))
            or (isinstance(op, ast.LShift))
        ):
            return "log"
        if isinstance(op, (ast.Add, ast.Sub)):
            return "step"
        return None

    def assigned_change(self, name: str, v: ast.expr, body: list[ast.stmt], changes: dict[str, str]) -> None:
        """How `name = v` changes name, recorded in changes."""
        if is_halving(v) or self.uses_mid(v):
            changes[name] = "log"
        elif (
            isinstance(v, ast.Attribute)
            and isinstance(v.value, (ast.Name, ast.Attribute))
            and self.root_name(v) == name
        ):
            changes[name] = "follow"
        elif isinstance(v, ast.Name) and self.follows(v.id, name, body):
            changes[name] = "follow"
        elif (
            isinstance(v, ast.BinOp)
            and isinstance(v.left, ast.Name)
            and v.left.id == name
            and isinstance(v.op, (ast.Add, ast.Sub))
            and is_const(v.right)
        ):
            changes.setdefault(name, "step")

    def halving_bound(self, test: ast.expr, header: str, changes: dict[str, str], test_names: set[str]) -> Bound | None:
        """Halving: binary search, n //= 2."""
        logs = [n for n in changes if changes[n] == "log" and (n in test_names or self.uses_mid_name(n, test_names))]
        if logs:
            ref = self.test_size(test, set(logs))
            if ref and ref != "const":
                return {"kind": "log", "size": ref, "why": header + " (halves each pass)"}
        return None

    def following_bound(self, node: ast.While, header: str, changes: dict[str, str]) -> Bound | None:
        """Walking a linked structure: node = node.next."""
        follows = [n for n in changes if changes[n] == "follow"]
        if follows:
            root = self.structure_root(follows[0])
            if root:
                return {
                    "kind": "size",
                    "sizes": [{"name": root, "len": True}],
                    "why": header + " (follows ." + self.follow_attr(follows[0], node.body) + ")",
                }
        return None

    def counting_bound(
        self, test: ast.expr, header: str, changes: dict[str, str], test_names: set[str]
    ) -> Bound | None:
        """Counting: while i < n: i += 1."""
        steps = [n for n in changes if changes[n] == "step" and n in test_names]
        if not steps:
            return None
        sizes = []
        for compare in [c for c in ast.walk(test) if isinstance(c, ast.Compare)]:
            sides = [compare.left] + compare.comparators
            if not any(isinstance(s, ast.Name) and s.id in steps for s in sides):
                continue
            for side in sides:
                ref = self.side_size(side, steps)
                if ref and ref != "const" and ref not in sizes:
                    sizes.append(ref)
        return {"kind": "size", "sizes": sizes, "why": header} if sizes else None

    def side_size(self, side: ast.expr, steps: list[str]) -> Size:
        """The size one side of a counting loop's comparison stands for."""
        if isinstance(side, ast.Name) and side.id in steps:
            # A counter is bounded by where it starts: j = i - 1 counting
            # down to 0, right = len(s) - 1 moving toward left.
            start = self.inits.get(side.id)
            return self.size_of(start, allow_value=True) if start is not None else None
        if is_const(side):
            return None
        return self.size_of(side, allow_value=True)

    @staticmethod
    def pairs(target: ast.expr, value: ast.expr) -> list[tuple[ast.expr, ast.expr]]:
        if (
            isinstance(target, (ast.Tuple, ast.List))
            and isinstance(value, (ast.Tuple, ast.List))
            and len(target.elts) == len(value.elts)
        ):
            return list(zip(target.elts, value.elts))
        return [(target, value)]

    def uses_mid(self, value: ast.expr) -> bool:
        return any(isinstance(n, ast.Name) and n.id in self.mids for n in ast.walk(value))

    def uses_mid_name(self, name: str, test_names: set[str]) -> bool:
        return name in self.mids or bool(test_names & self.mids)

    @staticmethod
    def root_name(node: ast.expr) -> str | None:
        while isinstance(node, ast.Attribute):
            node = node.value
        return node.id if isinstance(node, ast.Name) else None

    def follows(self, temp: str, name: str, body: list[ast.stmt]) -> bool:
        """nxt = curr.next; ...; curr = nxt"""
        for sub in walk_shallow(ast.Module(body=body, type_ignores=[])):
            if isinstance(sub, ast.Assign) and any(isinstance(t, ast.Name) and t.id == temp for t in sub.targets):
                v = sub.value
                if isinstance(v, ast.Attribute) and self.root_name(v) == name:
                    return True
        return False

    def follow_attr(self, name: str, body: list[ast.stmt]) -> str:
        for sub in walk_shallow(ast.Module(body=body, type_ignores=[])):
            if isinstance(sub, ast.Attribute) and self.root_name(sub) == name and isinstance(sub.ctx, ast.Load):
                return sub.attr
        return "next"

    def structure_root(self, name: str) -> str | None:
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

    def test_size(self, test: ast.expr, changing: set[str]) -> Size:
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
