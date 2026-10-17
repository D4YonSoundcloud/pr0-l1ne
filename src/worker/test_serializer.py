"""Tests for serialize.py: the Serializer and value helpers, called directly.

These run inside the tracer's settrace hook during a real trace, where no
coverage tool can see them, so they're tested here on their own.
Run with: npm run test:tracer
"""

import collections
import sys
import unittest

import serialize as S


def serialize(value, focus=None, ids=None):
    """The trace value for `value` and the heap objects it refers to."""
    s = S.Serializer({}, ids if ids is not None else {}, focus=focus)
    return s.value(value), s.heap


def heap_object(value, **kwargs):
    ref, heap = serialize(value, **kwargs)
    return heap[ref["id"]], heap


class Point:
    def __init__(self):
        self.x = 1
        self.items = [2]


class Slotted:
    __slots__ = ("a",)

    def __init__(self):
        self.a = 3


def counter():
    yield 1
    yield 2


def make_closure():
    k = 5

    def inner():
        return k

    return inner


class PrimitiveTests(unittest.TestCase):
    def test_primitives_are_inline(self):
        for value, kind, text in [
            (None, "none", "None"),
            (True, "bool", "True"),
            (3, "int", "3"),
            (1.5, "float", "1.5"),
            (1 + 2j, "complex", "(1+2j)"),
            ("hi", "str", "'hi'"),
            (b"ab", "bytes", "b'ab'"),
        ]:
            out, heap = serialize(value)
            self.assertEqual((out["kind"], out["type"], out["repr"]), ("prim", kind, text))
            self.assertEqual(heap, {})

    def test_strings_and_big_ints_carry_their_size(self):
        self.assertIn("size", serialize("hi")[0])
        self.assertIn("size", serialize(2**80)[0])
        self.assertNotIn("size", serialize(7)[0])

    def test_long_strings_are_shortened(self):
        out, _ = serialize("x" * 300)
        self.assertTrue(out["repr"].endswith("…"))
        self.assertLess(len(out["repr"]), 300)


class ContainerTests(unittest.TestCase):
    def test_tuples_lists_and_sets(self):
        obj, _ = heap_object((1, "a"))
        self.assertEqual((obj["kind"], obj["length"]), ("tuple", 2))
        obj, _ = heap_object({1, 2})
        self.assertEqual((obj["kind"], obj["typeName"]), ("set", "set"))
        obj, _ = heap_object(frozenset({3}))
        self.assertEqual((obj["kind"], obj["typeName"]), ("set", "frozenset"))

    def test_lists_record_their_capacity(self):
        obj, _ = heap_object([1, 2, 3])
        self.assertGreaterEqual(obj["capacity"], 3)

    def test_deques_and_dict_subclasses_keep_their_type_name(self):
        obj, _ = heap_object(collections.deque([1, 2]))
        self.assertEqual((obj["kind"], obj["typeName"]), ("list", "deque"))
        obj, _ = heap_object(collections.Counter("aab"))
        self.assertEqual((obj["kind"], obj["typeName"], obj["length"]), ("dict", "Counter", 2))
        obj, _ = heap_object(collections.OrderedDict(a=1))
        self.assertEqual(obj["typeName"], "OrderedDict")

    def test_nested_containers_are_separate_heap_objects(self):
        obj, heap = heap_object({"a": [1]})
        key, value = obj["entries"][0]
        self.assertEqual(key["repr"], "'a'")
        self.assertEqual(heap[value["id"]]["kind"], "list")

    def test_a_list_that_contains_itself_terminates(self):
        cycle = []
        cycle.append(cycle)
        obj, heap = heap_object(cycle)
        self.assertEqual(obj["items"], [{"kind": "ref", "id": obj["id"]}])
        self.assertEqual(len(heap), 1)

    def test_long_lists_show_a_window_and_their_length(self):
        obj, _ = heap_object(list(range(500)))
        self.assertEqual(obj["length"], 500)
        self.assertEqual(len(obj["items"]), S.MAX_ITEMS)
        self.assertEqual(obj["items"][0]["repr"], "0")
        self.assertIn("strip", obj)  # numbers get a color strip of the whole list

    def test_the_window_follows_index_variables(self):
        values = list(range(500))
        obj, _ = heap_object(values, focus={id(values): [300]})
        self.assertGreater(obj["offset"], 0)
        shown = [int(item["repr"]) for item in obj["items"]]
        self.assertIn(300, shown)

    def test_sets_of_objects_list_known_objects_in_first_seen_order(self):
        a, b, c = Point(), Point(), Point()
        ids = {id(c): "o1", id(a): "o2", id(b): "o3"}
        obj, _ = heap_object({a, b, c}, ids=ids)
        self.assertEqual([item["id"] for item in obj["items"]], ["o1", "o2", "o3"])


class ObjectTests(unittest.TestCase):
    def test_instances_list_their_fields(self):
        obj, heap = heap_object(Point())
        self.assertEqual(obj["kind"], "object")
        self.assertEqual([name for name, _ in obj["fields"]], ["x", "items"])
        self.assertEqual(heap[obj["fields"][1][1]["id"]]["kind"], "list")

    def test_slotted_instances_list_their_slots(self):
        obj, _ = heap_object(Slotted())
        self.assertEqual(obj["fields"][0][0], "a")

    def test_closures_show_the_variables_they_captured(self):
        obj, _ = heap_object(make_closure())
        self.assertEqual((obj["kind"], obj["name"], obj["builtin"]), ("function", "inner", False))
        self.assertEqual(obj["fields"][0][0], "k")

    def test_builtins_and_classes(self):
        obj, _ = heap_object(len)
        self.assertEqual((obj["kind"], obj["builtin"]), ("function", True))
        obj, _ = heap_object(Point)
        self.assertEqual((obj["kind"], obj["name"]), ("class", "Point"))

    def test_generators_describe_their_state(self):
        gen = counter()
        obj, _ = heap_object(gen)
        self.assertEqual((obj["kind"], obj["repr"]), ("opaque", "counter() not started"))
        next(gen)
        self.assertRegex(S.pausable_state(gen), r"counter\(\) paused at line \d+")
        list(gen)
        self.assertEqual(S.pausable_state(gen), "counter() finished")

    def test_other_values_are_opaque_with_a_short_repr(self):
        for value, type_name in [(range(5), "range"), (sys, "module"), (Ellipsis, "ellipsis")]:
            obj, _ = heap_object(value)
            self.assertEqual((obj["kind"], obj["typeName"]), ("opaque", type_name))

    def test_the_heap_is_capped(self):
        s = S.Serializer({}, {})
        s.value([[[j] for j in range(10)] for _ in range(S.MAX_ITEMS)])  # 660 objects, 60 per list
        # Past the cap, objects still appear (so arrows have somewhere to
        # point) but as "…" placeholders instead of full descriptions.
        placeholders = [o for o in s.heap.values() if o["kind"] == "opaque" and o["repr"] == "…"]
        self.assertTrue(placeholders)
        self.assertLessEqual(len(s.heap) - len(placeholders), S.MAX_OBJECTS)


class EdgeCaseTests(unittest.TestCase):
    def test_a_repr_that_raises_shows_the_type(self):
        class Broken:
            def __repr__(self):
                raise RuntimeError("no")

        self.assertEqual(S.short_repr(Broken()), "<Broken>")

    def test_coroutines_and_async_generators_describe_their_state(self):
        async def task():
            return 1

        async def stream():
            yield 1

        coro = task()
        self.assertEqual(S.pausable_state(coro), "task() not started")
        coro.close()
        self.assertEqual(S.pausable_state(coro), "task() finished")
        self.assertEqual(S.pausable_state(stream()), "stream() not started")

    def test_a_running_generator_says_so(self):
        states = []

        def gen():
            states.append(S.pausable_state(g))
            yield

        g = gen()
        next(g)
        self.assertEqual(states, ["gen() running"])

    def test_strips_read_bools_as_numbers_and_give_up_on_anything_unplottable(self):
        strip = S.strip_of([True, False] * 50)
        assert strip is not None
        self.assertEqual((strip["min"], strip["max"]), (0, 1))
        self.assertIsNone(S.strip_of([1, 2**60]))
        self.assertIsNone(S.strip_of([1.0, float("nan")]))
        self.assertIsNone(S.strip_of([1.0, float("inf")]))

    def test_very_large_sets_keep_pythons_order(self):
        big = set(range(2000))
        self.assertEqual(S.Serializer({}, {}).stable_order(big), list(big))

    def test_long_iterables_and_dicts_stop_at_the_limit(self):
        s = S.Serializer({}, {})
        self.assertEqual(len(s.items(iter(range(100)))), S.MAX_ITEMS)
        obj, _ = heap_object({i: i for i in range(100)})
        self.assertEqual((len(obj["entries"]), obj["length"]), (S.MAX_ITEMS, 100))

    def test_a_closure_over_a_variable_not_yet_set(self):
        def outer():
            def inner():
                return later

            fields, _ = heap_object(inner)
            later = 1
            return fields

        fields = outer()["fields"]
        self.assertEqual(fields, [["later", {"kind": "prim", "type": "unbound", "repr": "?"}]])

    def test_collected_generators_give_up_their_id(self):
        ids = {}
        S.Serializer({}, ids).value(counter())  # dropped at once
        self.assertEqual(ids.get("__retired__"), 1)
        self.assertEqual(len([k for k in ids if k != "__retired__"]), 0)


class HelperTests(unittest.TestCase):
    def test_window_start_moves_in_steps_of_ten_and_stays_in_range(self):
        self.assertEqual(S.window_start([0], 500), 0)
        self.assertEqual(S.window_start([499], 500), 500 - S.MAX_ITEMS)
        start = S.window_start([250, 260], 500)
        self.assertEqual(start % 10, 0)
        self.assertTrue(start <= 250 and 260 < start + S.MAX_ITEMS)

    def test_strips_are_for_numbers_only(self):
        strip = S.strip_of(list(range(300)))
        assert strip is not None
        self.assertLessEqual(len(strip["values"]), S.STRIP_SAMPLES)
        self.assertIsNone(S.strip_of(["a"] * 300))

    def test_hidden_names(self):
        self.assertTrue(S.is_hidden_name("__name__", "x"))
        self.assertTrue(S.is_hidden_name("os", sys))
        self.assertFalse(S.is_hidden_name("_private", 1))


if __name__ == "__main__":
    unittest.main()
