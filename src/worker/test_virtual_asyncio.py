"""Tests for virtual_asyncio.py: asyncio on a virtual clock. Run with: npm run test:tracer"""

import asyncio
import time
import unittest

from virtual_asyncio import virtual_asyncio


class VirtualAsyncioTests(unittest.TestCase):
    def test_sleeping_costs_no_real_time_and_keeps_its_order(self):
        order = []

        async def nap(name, seconds):
            await asyncio.sleep(seconds)
            order.append(name)

        async def main():
            loop = asyncio.get_running_loop()
            await asyncio.gather(nap("slow", 30), nap("fast", 10))
            return loop.time()

        started = time.perf_counter()
        with virtual_asyncio(True):
            clock = asyncio.run(main())
        self.assertLess(time.perf_counter() - started, 1)
        self.assertEqual(order, ["fast", "slow"])
        self.assertEqual(clock, 30)

    def test_waiting_forever_is_an_error_not_a_hang(self):
        async def main():
            await asyncio.get_running_loop().create_future()  # nothing will ever set it

        with virtual_asyncio(True):
            with self.assertRaisesRegex(RuntimeError, "Every task is waiting"):
                asyncio.run(main())

    def test_everything_is_put_back_even_after_an_error(self):
        policy, run = asyncio.get_event_loop_policy(), asyncio.run
        with self.assertRaises(ValueError):
            with virtual_asyncio(True):
                self.assertIsNot(asyncio.get_event_loop_policy(), policy)
                raise ValueError("the program failed")
        self.assertIs(asyncio.get_event_loop_policy(), policy)
        self.assertIs(asyncio.run, run)

    def test_does_nothing_for_programs_without_asyncio(self):
        policy = asyncio.get_event_loop_policy()
        with virtual_asyncio(False):
            self.assertIs(asyncio.get_event_loop_policy(), policy)


if __name__ == "__main__":
    unittest.main()
