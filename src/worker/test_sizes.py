"""Tests for sizes.py: memory sizes as a 64-bit CPython reports them.

On a 64-bit Python the sizes are sys.getsizeof's own. The browser's Python is
32-bit, so the conversion rules are checked here by pretending pointers are
4 bytes; npm run test:pyodide checks them in the real 32-bit Python.
Run with: npm run test:tracer
"""

import sys
import unittest
from unittest import mock

import sizes


class Unsizable:
    def __sizeof__(self):
        raise TypeError("no size")


class SixtyFourBitTests(unittest.TestCase):
    def setUp(self):
        if sizes.POINTER != 8:
            self.skipTest("a 32-bit Python: the conversion rules are tested below")

    def test_sizes_are_sys_getsizeof(self):
        for value in (None, 1, 2**100, 1.5, "abc", "é", b"xy", [1, 2], (1,), {1}, {"a": 1}):
            self.assertEqual(sizes.size64(value), sys.getsizeof(value), value)


class ThirtyTwoBitTests(unittest.TestCase):
    """The rules that turn a 32-bit size into a 64-bit one."""

    def setUp(self):
        patch = mock.patch.object(sizes, "POINTER", 4)
        patch.start()
        self.addCleanup(patch.stop)

    def test_none_is_always_16(self):
        self.assertEqual(sizes.size64(None), 16)

    def test_numbers_grow_by_their_header(self):
        self.assertEqual(sizes.size64(7), sys.getsizeof(7) + 12)
        self.assertEqual(sizes.size64(True), sys.getsizeof(True) + 12)
        self.assertEqual(sizes.size64(1.5), sys.getsizeof(1.5) + 8)
        self.assertEqual(sizes.size64(1j), sys.getsizeof(1j) + 8)

    def test_strings_and_bytes_grow_by_their_header(self):
        self.assertEqual(sizes.size64("ab"), sys.getsizeof("ab") + 20)
        self.assertEqual(sizes.size64("é"), sys.getsizeof("é") + 28)
        self.assertEqual(sizes.size64(b"ab"), sys.getsizeof(b"ab") + 16)
        self.assertEqual(sizes.size64(bytearray(b"ab")), sys.getsizeof(bytearray(b"ab")) + 16)

    def test_objects_made_of_pointers_double(self):
        for value in ([1, 2, 3], (1, 2), {1, 2}, Unsizable.__init__):
            self.assertEqual(sizes.size64(value), sys.getsizeof(value) * 2)

    def test_dicts_are_rebuilt_from_their_table(self):
        with mock.patch.object(sys, "getsizeof", return_value=108):
            self.assertEqual(sizes.size64({"a": 1}), sizes.dict_size64({"a": 1}, 108))

    def test_unknown_sizes_are_none(self):
        self.assertIsNone(sizes.size64(Unsizable()))


class ListCapacityTests(unittest.TestCase):
    """On any Python: a list's capacity is worked out from its own pointer size."""

    def test_a_list_has_room_for_at_least_its_items(self):
        self.assertEqual(sizes.list_capacity([]), 0)
        grown = []
        for i in range(10):
            grown.append(i)
        self.assertGreaterEqual(sizes.list_capacity(grown), 10)


class DictSizeTests(unittest.TestCase):
    def test_an_empty_dict(self):
        self.assertEqual(sizes.dict_size64({}, 40), 64)

    def test_a_table_of_8_slots(self):
        # 32-bit: 40 + 20 + 8 one-byte indices + 5 usable entries.
        self.assertEqual(sizes.dict_size64({"a": 1}, 40 + 20 + 8 + 5 * 8), 64 + 32 + 8 + 5 * 16)  # str keys
        self.assertEqual(sizes.dict_size64({1: 1}, 40 + 20 + 8 + 5 * 12), 64 + 32 + 8 + 5 * 24)  # other keys

    def test_a_split_instance_dict_is_estimated(self):
        self.assertEqual(sizes.dict_size64({"a": 1}, 101), round(101 * 1.9))


if __name__ == "__main__":
    unittest.main()
