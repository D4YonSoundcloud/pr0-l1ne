"""
Memory sizes, as a 64-bit CPython reports them.

sys.getsizeof() is exact on a 64-bit Python. In the browser, Python is
32-bit WebAssembly (Pyodide), where pointers are 4 bytes, so sizes are
converted to what the same object would take on a 64-bit Python, using
rules measured on both (see docs/how-it-works.md, "Memory sizes"):
  objects made of pointers (lists, tuples, sets, functions, instances): x2
  ints and bools: +12, floats and complex: +8, None: 16
  strings: +20 (ASCII) or +28, bytes: +16
  dicts: worked out from their hash table's size and entry layout

Used by the serializer (each object's size) and by Measure (what the
program holds at the end). npm run test:pyodide checks these rules in the
32-bit Python they're for.
"""

import struct
import sys

POINTER = struct.calcsize("P")
EMPTY_LIST = sys.getsizeof([])


def dict_size64(d: dict, size: int) -> int:
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


def size64(v: object) -> int | None:
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


def list_capacity(v: list) -> int:
    """How many items a list has room for before it has to grow."""
    return (sys.getsizeof(v) - EMPTY_LIST) // POINTER
