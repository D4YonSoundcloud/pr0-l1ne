"""Tests for analysis.py: hints, loops and index names, read from source
without running it. Run with: npm run test:tracer
"""

import textwrap
import unittest

from analysis import analyze, collect_hints


def analysed(source):
    loops, index_names, accesses = analyze(textwrap.dedent(source))
    return loops, index_names, accesses


class HintTests(unittest.TestCase):
    def test_hints_are_read_from_comments(self):
        hints = collect_hints("x = 1  # viz: hide temp\ny = 2  # viz: pointers nums: a, b\n# just a comment\n")
        self.assertEqual(hints, [{"line": 1, "text": "hide temp"}, {"line": 2, "text": "pointers nums: a, b"}])

    def test_spacing_around_viz_is_optional(self):
        self.assertEqual(
            collect_hints("#viz:hide a\n#  viz :  show b\n"),
            [
                {"line": 1, "text": "hide a"},
                {"line": 2, "text": "show b"},
            ],
        )

    def test_code_that_cant_be_read_has_the_hints_before_the_problem(self):
        # The syntax error itself is reported when the code is compiled.
        self.assertEqual(collect_hints('# viz: hide a\ns = """never closed\n'), [{"line": 1, "text": "hide a"}])


class LoopTests(unittest.TestCase):
    def test_loops_are_listed_in_line_order_with_their_bodies(self):
        loops, _, _ = analysed("""
            total = 0
            while total < 3:
                total += 1
            for i in range(2):
                for j in range(2):
                    total += i * j
        """)
        self.assertEqual(
            [(loop["id"], loop["kind"], loop["bodyStart"], loop["bodyEnd"], loop["header"]) for loop in loops],
            [
                ("L3", "while", 4, 4, "while total < 3"),
                ("L5", "for", 6, 7, "for i in range(2)"),
                ("L6", "for", 7, 7, "for j in range(2)"),
            ],
        )

    def test_async_for_is_a_for_loop(self):
        loops, _, _ = analysed("""
            async def f(xs):
                async for x in xs:
                    pass
        """)
        self.assertEqual([loop["kind"] for loop in loops], ["for"])


class IndexNameTests(unittest.TestCase):
    def test_names_that_index_a_list(self):
        _, names, _ = analysed("""
            arr = [3, 1, 2]
            for j in range(len(arr) - 1):
                if arr[j] > arr[j + 1]:
                    arr[j], arr[j + 1] = arr[j + 1], arr[j]
            other = [0]
            other[0] = 1
        """)
        self.assertEqual(names, {"arr": ["j"]})

    def test_a_grid_records_its_rows_and_columns_and_each_cell_touched(self):
        _, names, accesses = analysed("""
            grid = [[0, 1], [2, 3]]
            for r in range(2):
                for c in range(2):
                    grid[r][c] += 1
            row = grid[0][:]
        """)
        self.assertEqual(names, {"grid": ["r"], "grid[]": ["c"]})
        self.assertEqual(accesses, [{"name": "grid", "line": 5, "row": "r", "col": "c"}])

    def test_subscripts_of_anything_else_are_ignored(self):
        _, names, accesses = analysed("""
            def f():
                return [1]
            x = f()[0]
            y = {"a": 1}["a"]
        """)
        self.assertEqual((names, accesses), ({}, []))


if __name__ == "__main__":
    unittest.main()
