"""
Static analysis: what the tracer learns from the program's source before
running anything.

- `collect_hints`: the `# viz: ...` comments, which the canvas parses.
- `analyze`: the loops (for the loop history), and which names index which
  containers (for the pointers drawn under lists and grids).

The shape of the code for complexity estimates is in shape.py.
"""

import ast
import io
import re
import tokenize
from types import TracebackType
from typing import Any

# The filename user code is parsed and compiled under. The tracer and Measure
# tell the program's own frames and tracebacks apart from theirs by it.
USER_FILENAME = "<user>"


def last_user_line(tb: TracebackType | None) -> int | None:
    """The line in the program's own code an exception came from (the deepest one)."""
    line = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == USER_FILENAME:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


HINT = re.compile(r"^#\s*viz\s*:(.*)$")


def collect_hints(source: str) -> list[dict[str, Any]]:
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


def analyze(source: str) -> tuple[list[dict[str, Any]], dict[str, list[str]], list[dict[str, Any]]]:
    """Find loops, and which names index which containers.

    `arr[j + 1]` records {"arr": ["j"]}, so the renderer knows to draw a `j`
    pointer under `arr` (and not under every other list). `grid[i][j]`
    records {"grid": ["i"], "grid[]": ["j"]}: i picks a row, j a column.
    """
    tree = ast.parse(source, USER_FILENAME)
    lines = source.splitlines()
    loops = []
    index_names = {}
    accesses = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.For, ast.While, ast.AsyncFor)) and node.body:
            body_start = min(stmt.lineno for stmt in node.body)
            body_end = max(getattr(stmt, "end_lineno", stmt.lineno) for stmt in node.body)
            header = lines[node.lineno - 1].strip() if node.lineno - 1 < len(lines) else ""
            loops.append(
                {
                    "id": "L%d" % node.lineno,
                    "kind": "while" if isinstance(node, ast.While) else "for",
                    "line": node.lineno,
                    "bodyStart": body_start,
                    "bodyEnd": body_end,
                    "header": header.rstrip(":"),
                }
            )
        if isinstance(node, ast.Subscript):
            # grid[i] records "i" under "grid". grid[i][j] also records "j"
            # under "grid[]": a name that indexes the rows of grid.
            if isinstance(node.value, ast.Name):
                key = node.value.id
            elif isinstance(node.value, ast.Subscript) and isinstance(node.value.value, ast.Name):
                key = node.value.value.id + "[]"
                # grid[a][b]: which cell this line touches (see trace/gridFocus.ts).
                row = ast.get_source_segment(source, node.value.slice)
                col = ast.get_source_segment(source, node.slice)
                if (
                    row
                    and col
                    and not isinstance(node.slice, ast.Slice)
                    and not isinstance(node.value.slice, ast.Slice)
                ):
                    accesses.append({"name": node.value.value.id, "line": node.lineno, "row": row, "col": col})
            else:
                continue
            names = index_names.setdefault(key, set())
            for sub in ast.walk(node.slice):
                if isinstance(sub, ast.Name):
                    names.add(sub.id)

    loops.sort(key=lambda loop: loop["line"])
    accesses.sort(key=lambda a: a["line"])
    return loops, {name: sorted(subs) for name, subs in index_names.items() if subs}, accesses
