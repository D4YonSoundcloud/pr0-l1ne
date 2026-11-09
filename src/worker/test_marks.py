"""Tests for marks.py: every way a program can change an object, traced with
marks and without, must give the same trace. Run with: npm run test:tracer

A way of writing Python that changes objects (new syntax, a library function
that changes what it's given) belongs in WRITE_FORMS: this is the list a
reviewer checks it against. Each program reads the objects at a recorded step
first (so the tracer has them as they were), then changes them, then records
steps where it shows.
"""

import ast
import json
import re
import textwrap
import unittest

from marks import add_marks
from test_tracer import expand_heaps
from tracer import run_trace

SETUP = """\
import heapq, bisect, random, operator, functools, contextlib, collections, dataclasses, asyncio
random.seed(1)


class Obj:
    def __init__(self):
        self.a = 1
        self.b = Inner()
        self.n = 0
        self.k = "x"
        self.lst = [1]


class Inner:
    def __init__(self):
        self.c = 2


o = Obj()
a = [3, 1, 2]
d = {"x": 1, "l": [0]}
s = {1}
q = collections.deque([1, 2])
seen = 0
"""


def around(write: str, extra: str = "") -> str:
    """`o` (fields), `a` (a short list), `d` (a dict), `s` (a set), `q` (a deque), read
    at the step before the write, and steps after it where it shows."""
    return "%s%s%s\nseen = 1\nseen = 2\n" % (SETUP, textwrap.dedent(extra), textwrap.dedent(write).strip())


WRITE_FORMS: list[tuple[str, str]] = [
    # Assignment.
    ("o.a = v", around("o.a = 5")),
    ("d[key] = v", around('d["x"] = 5')),
    ("a[i] = v", around("a[1] = 9")),
    ("nested o.b.c = v", around("o.b.c = 7")),
    ("a new field", around("o.extra = [1, 2]")),
    ("chained a.x = b.y = v", around("o.a = o.b.c = 11")),
    ("o.__class__ = Other", around("class Other:\n    pass\no.__class__ = Other")),
    ("annotated o.a: int = v", around("o.a: int = 8")),
    ("slice assignment", around("a[1:2] = [7, 8]")),
    ("a field of a call's result", around("def get():\n    return o.b\nget().c = 70")),
    # Augmented assignment: what's held changes in place too.
    ("+= -= *= on fields and items", around("o.a += 2\no.n -= 1\na[0] *= 3\nd['x'] //= 1")),
    ("**= %= <<= >>= &= |= ^= @=", around("o.a **= 2\no.a %= 3\no.n <<= 1\no.n >>= 1\no.n &= 1\no.n |= 6\no.n ^= 3")),
    ("a list += in a field", around("o.lst += [5]")),
    ("a list += in an item", around("d['l'] += [6]")),
    ("a list += through a name", around("xs = a\nxs += [4]")),
    ("a list *= through a name", around("xs = a\nxs *= 2")),
    ("a set |= and a dict |=", around("t = s\nt |= {2}\ne = d\ne |= {'y': 3}")),
    ("+= whose right side records steps", around("o.lst += more()", "def more():\n    t = [9]\n    return t\n")),
    ("+= with a key that's a call", around("d[key()] += [1]", "def key():\n    return 'l'\n")),
    # Deletes.
    ("del o.k", around("del o.k")),
    ("del a[i] and del d[k]", around('del a[0]\ndel d["x"]')),
    ("del a[i:j]", around("del a[0:2]")),
    # Destructuring into fields and items.
    ("a[i], a[j] = a[j], a[i]", around("a[0], a[2] = a[2], a[0]")),
    ("o.a, o.b.c = x, y", around("o.a, o.b.c = 40, 41")),
    ("o.first, *o.rest = xs", around("o.first, *o.rest = [7, 8, 9]")),
    ("nested [a[0], [a[1], a[2]]] = ...", around("[a[0], [a[1], a[2]]] = [1, [2, 3]]")),
    # The right-hand side records steps before the write lands.
    (
        "o.a = f() where f records steps",
        around("o.a = slow(4)", "def slow(x):\n    t = 0\n    t += x\n    return t * 2\n"),
    ),
    (
        "a[a.index(1)] = v and o.a = o.a + g(o)",
        around("a[a.index(1)] = 50\no.a = o.a + bump(o)", "def bump(x):\n    x.n = x.n + 1\n    return x.n\n"),
    ),
    # Methods that change what they're called on.
    ("append pop insert remove", around("a.append(4)\na.pop(0)\na.insert(0, 9)\na.remove(1)")),
    ("extend sort reverse clear", around("a.extend([5, 6])\na.sort()\na.reverse()\nb = [1]\nb.clear()")),
    ("sort with a key that records steps", around("a.sort(key=keyed)", "def keyed(x):\n    k = -x\n    return k\n")),
    ("dict update setdefault pop popitem", around("d.update(y=2)\nd.setdefault('z', 3)\nd.pop('x')\nd.popitem()")),
    ("d.setdefault(k, []).append(v)", around("d.setdefault('l', []).append(1)\nd.setdefault('m', []).append(2)")),
    ("set add discard", around("s.add(2)\ns.discard(1)\ns.add(3)")),
    ("deque appendleft rotate popleft", around("q.appendleft(0)\nq.rotate(1)\nq.popleft()")),
    ("a method of an item: d[k].append(v)", around("d['l'].append(3)\no.lst.append(4)")),
    # Functions that change what they're given.
    ("heapq.heappush and heappop", around("heapq.heappush(a, 0)\nheapq.heappop(a)")),
    ("random.shuffle", around("random.shuffle(a)")),
    ("bisect.insort", around("a.sort()\nbisect.insort(a, 2)")),
    ("setattr and delattr", around("setattr(o, 'a', 5)\ndelattr(o, 'k')")),
    ("operator.setitem", around("operator.setitem(a, 0, 1)")),
    (
        "object.__setattr__ and list.append(a, v)",
        around("object.__setattr__(o, 'a', 2)\nlist.append(a, 4)\ntype(a).append(a, 5)"),
    ),
    ("dict.update(d, ...)", around("dict.update(d, y=1)")),
    ("a function imported by name", around("from heapq import heappush\nheappush(a, -1)")),
    ("a starred argument", around("args = (a, 7)\nheapq.heappush(*args)")),
    ("a keyword argument", around("def put(where=None):\n    where.append(1)\nput(where=a)")),
    # Functions kept in variables.
    ("a bound method in a variable", around("push = a.append\npush(12)")),
    (
        "functools.partial",
        around("functools.partial(list.append, a)(13)\nadd = functools.partial(setattr, o)\nadd('a', 3)"),
    ),
    ("a bound method in a list", around("ops = [a.append]\nops[0](14)")),
    ("a method of another object's", around("p = q.append\np(15)")),
    # Code that writes, run by other code.
    ("map with a callback that writes", around("list(map(lambda x: a.append(x), [1, 2]))")),
    ("a comprehension that writes", around("[a.append(i) for i in range(2)]\nany(o.lst.append(x) for x in [1])")),
    ("filter and sorted with keys that write", around("sorted(a, key=lambda x: o.lst.append(x) or x)")),
    # Writes as loop and with targets.
    ("for o.a in ...", around("for o.a in [1, 2, 3]:\n    seen = 6")),
    ("for a[0] in ...", around("for a[0] in [5, 6]:\n    seen = 6")),
    ("a comprehension's target", around("[0 for o.a in [1, 2]]")),
    ("with ... as o.a", around("with contextlib.nullcontext(5) as o.a:\n    seen = 6")),
    # Classes.
    (
        "a setter that writes another field",
        around(
            "box.v = 5",
            """\
            class Box:
                def __init__(self):
                    self._v = 0
                    self.writes = 0

                @property
                def v(self):
                    return self._v

                @v.setter
                def v(self, x):
                    self._v = x
                    self.writes += 1


            box = Box()
            """,
        ),
    ),
    (
        "a __setattr__ that writes with super()",
        around(
            "w.a = 9",
            """\
            class Watched:
                def __init__(self):
                    self.a = 0

                def __setattr__(self, name, value):
                    t = name
                    super().__setattr__(t, value)


            w = Watched()
            """,
        ),
    ),
    (
        "a __setitem__ of the program's own",
        around(
            "g[1] = 2",
            """\
            class Grid:
                def __init__(self):
                    self.cells = {}

                def __setitem__(self, k, v):
                    self.cells[k] = v


            g = Grid()
            """,
        ),
    ),
    (
        "super().bump() and a name-mangled field",
        around(
            "kid.grow()",
            """\
            class Base:
                def __init__(self):
                    self.size = 1
                    self.__secret = 0

                def bump(self):
                    self.size += 1
                    self.__secret += 1


            class Kid(Base):
                def grow(self):
                    super().bump()
                    self.age = 3


            kid = Kid()
            """,
        ),
    ),
    ("a class attribute", around("Obj.count = 0\nObj.count += 1\no.seen = Obj.count")),
    (
        "a dataclass",
        around(
            "pt.x = 5\npt.tags.append('t')",
            """\
            @dataclasses.dataclass
            class Point:
                x: int
                tags: list = dataclasses.field(default_factory=list)


            pt = Point(1)
            """,
        ),
    ),
    (
        "a class with __slots__",
        around(
            "sl.v = 3",
            "class Slotted:\n    __slots__ = ('v',)\n    def __init__(self):\n        self.v = 1\n\n\nsl = Slotted()\n",
        ),
    ),
    (
        "another library's object that changes what it holds",
        around("box.put(5)", "import queue\nbox = queue.Queue()\nbox.put(1)\n"),
    ),
    # Aliases and objects that come back.
    ("a write through another name", around("alias = o\nalias.a = 21")),
    ("a write through a list of objects", around("rows = [o, Inner()]\nrows[0].b.c = 30\nrows[1].c = 1")),
    (
        "written while unreachable, then back",
        around("hold = o.b\no.b = None\nseen = 3\nhold.c = 500\nseen = 4\no.b = hold"),
    ),
    (
        "a closure's variable",
        around(
            "def counter():\n    n = 0\n    def inc():\n        nonlocal n\n        n += 1\n    return inc\nc = counter()\nc()\nc()"
        ),
    ),
    # Errors part-way.
    (
        "a write whose right side raises",
        around("try:\n    o.a = boom()\nexcept ValueError:\n    o.n = 1", "def boom():\n    raise ValueError('no')\n"),
    ),
    (
        "a sort that raises after writing",
        around(
            "def bad(x):\n    a.append(100)\n    raise ValueError('stop')\ntry:\n    [3, 2, 1].sort(key=bad)\nexcept ValueError:\n    o.n = 2"
        ),
    ),
    # Generators and async.
    (
        "a write across a yield",
        around("g = gen()\nnext(g)\nseen = 5\ng.send(77)", "def gen():\n    o.a = yield 1\n    o.n = 2\n    yield 3\n"),
    ),
    (
        "a method call paused at its argument's yield",
        around("g = gen()\nnext(g)\nseen = 5\ng.send(78)", "def gen():\n    o.lst.append((yield 1))\n    yield 2\n"),
    ),
    (
        "a method call paused at an await",
        around(
            "asyncio.run(main())",
            """\
            async def later():
                await asyncio.sleep(0)
                return 65


            async def main():
                o.lst.append(await later())
                a[0] = await later()
            """,
        ),
    ),
]

# Programs marks can't follow: the whole run reads every object instead.
UNSAFE_FORMS: list[tuple[str, str, str]] = [
    ("eval", around("eval(\"o.__setattr__('a', 3)\")"), "eval"),
    ("exec", around('exec("o.a = 4")'), "exec"),
    ("a __dict__", around("o.__dict__['a'] = 5"), "__dict__"),
    ("vars()", around("vars(o)['a'] = 6"), "vars()"),
    ("gc", around("import gc\ngc.collect()"), "import gc"),
    ("cached_property", around("x = functools.cached_property"), "cached_property"),
    (
        "a field += in a class body",
        around("class C:\n    x = [1]\n    x[0] += 1"),
        "an augmented assignment to a field in a class body",
    ),
]

# A write marks can't see: a builtin method run by another builtin, on the items of a
# list it's given (map calls list.reverse on each row). Only the in-run check can catch it.
HIDDEN_WRITE = around("rows = [[1, 2], [3, 4]]\nseen = 7\nlist(map(list.reverse, rows))")


def traced(source: str, marks: bool, check_every: int = 10**9) -> dict:
    out = run_trace(source, 5000, 60, None, marks=marks, check_every=check_every)
    # Reprs with an address (<function f at 0x...>) differ from run to run.
    return expand_heaps(json.loads(re.sub(r" at 0x[0-9a-f]+", " at 0x…", out)))


class MarksTests(unittest.TestCase):
    def test_every_write_form_traces_the_same_with_marks_and_without(self):
        for name, code in WRITE_FORMS:
            with self.subTest(name):
                compile(code, "<user>", "exec")
                plain = traced(code, marks=False)
                self.assertIsNone(plain["error"], plain["error"])
                marked = traced(code, marks=True)
                self.assertNotIn("selfCheck", marked)  # the check at the program's last step found nothing
                self.assertEqual(marked, plain)

    def test_the_in_run_check_finds_nothing_at_any_step_of_the_catalogue(self):
        # Checked at every step, not only where the trace would show a difference.
        for name, code in WRITE_FORMS:
            with self.subTest(name):
                self.assertNotIn("selfCheck", traced(code, marks=True, check_every=1))

    def test_the_catalogue_writes_something_the_trace_shows(self):
        # Each form changes the heap between the step before it and the end, or it tests nothing.
        for name, code in WRITE_FORMS:
            with self.subTest(name):
                steps = traced(code, marks=False)["steps"]
                before = next(s for s in steps if s["line"] == SETUP.count("\n"))  # `seen = 0`
                self.assertNotEqual(before["heap"], steps[-1]["heap"])

    def test_code_marks_cant_follow_is_read_whole(self):
        for name, code, reason in UNSAFE_FORMS:
            with self.subTest(name):
                self.assertEqual(add_marks(ast.parse(code))[1], reason)
                self.assertEqual(traced(code, marks=True), traced(code, marks=False))
        self.assertIsNone(add_marks(ast.parse(WRITE_FORMS[0][1]))[1])
        self.assertIsNone(add_marks(ast.parse("import re\nre.compile('a')"))[1])  # not the builtin

    def test_the_in_run_check_catches_a_write_marks_missed(self):
        plain = traced(HIDDEN_WRITE, marks=False)
        # Checked only at the last step, the steps between show the rows as they were...
        unchecked = traced(HIDDEN_WRITE, marks=True)
        self.assertNotEqual(unchecked["steps"][:-1], plain["steps"][:-1])
        # ...and the check at the last step finds it (that step is right: it read everything).
        self.assertEqual(unchecked.pop("selfCheck").split(" by ")[0], "marks missed a write to 2 objects")
        self.assertEqual(unchecked["steps"][-1], plain["steps"][-1])
        # Checked at every step, it's found at the step after it, which is right (it read
        # everything), and so is every step after (marks are off from then on).
        checked = traced(HIDDEN_WRITE, marks=True, check_every=1)
        self.assertRegex(
            checked.pop("selfCheck"), r"^marks missed a write to 2 objects by step \d+, line \d+: o\d+ \(list\)"
        )
        self.assertEqual(checked, plain)

    def test_the_rewrite_adds_no_python_frames(self):
        # The notes are C calls (max with a key): no trace events, so nothing to skip.
        tree, _ = add_marks(ast.parse("o.a = 1\na.append(2)\nx += [3]\nd[k] += 1"))
        calls = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        self.assertEqual(calls - {"__viz_max__"}, {"__viz_iadd__"})

    def test_calls_to_the_programs_own_functions_and_pure_builtins_add_no_marks(self):
        tree, _ = add_marks(ast.parse("def f(x):\n    return x\nclass C:\n    pass\nf(a)\nC(a)\nlen(a)\nsorted(a)"))
        self.assertNotIn("__viz_max__", ast.unparse(tree))
        # ...unless the name is something else somewhere too.
        tree, _ = add_marks(ast.parse("def f(x):\n    return x\nf = a.append\nf(a)"))
        self.assertIn("__viz_max__", ast.unparse(tree))

    def test_marks_make_a_big_tree_cheaper(self):
        # Not a timing (machines vary): what's read. A tree's build reads only the new
        # node and the one it's put under, not every node again.
        code = textwrap.dedent(
            """\
            class Node:
                def __init__(self, v):
                    self.v = v
                    self.left = None
                    self.right = None

            def build(lo, hi):
                if lo > hi:
                    return None
                mid = (lo + hi) // 2
                n = Node(mid)
                n.left = build(lo, mid - 1)
                n.right = build(mid + 1, hi)
                return n

            root = build(0, 126)
            """
        )
        import serialize

        reads = {"n": 0}
        original = serialize.slots_of

        def counting(v):
            reads["n"] += 1
            return original(v)

        serialize.slots_of = counting
        try:
            run_trace(code, 5000, 60, None, marks=False)
            without = reads["n"]
            reads["n"] = 0
            run_trace(code, 5000, 60, None, marks=True)
            with_marks = reads["n"]
        finally:
            serialize.slots_of = original
        self.assertLess(with_marks * 5, without)


if __name__ == "__main__":
    unittest.main()
