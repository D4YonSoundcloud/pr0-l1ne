"""
asyncio for traced and measured programs: an event loop with a virtual clock.

Pyodide's event loop is the browser's, which can't block, so asyncio.run()
fails there unless WebAssembly stack switching is set up (and even then the
coroutines run from browser callbacks, outside the trace). Pyodide also
replaces asyncio.run with one that hands the coroutine to the browser's
loop, and marks that loop as running.

So while a program that uses asyncio runs, virtual_asyncio() puts in the
standard asyncio.run, clears the running loop, and sets a policy whose loops
are the standard pure-Python one with the waiting taken out. Then it puts
Pyodide's back. Used by the tracer and by Measure.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import asyncio

# asyncio is imported when it's needed, not here: only programs that use it
# pay for importing it.


def virtual_loop_policy() -> "asyncio.AbstractEventLoopPolicy":
    """An event loop policy whose loops run on a virtual clock.

    When every task is asleep, the clock jumps to the next timer instead of
    sleeping. Programs behave the same, asyncio.sleep(2) costs no real time,
    and it works the same in the browser and on your machine, like the
    JavaScript tracer's virtual timers.
    """
    import asyncio

    class Clock:
        """Stands in for the selector: "waiting" moves the clock forward."""

        def __init__(self, loop):
            self.loop = loop

        def select(self, timeout):
            if timeout is None:
                raise RuntimeError("Every task is waiting, and nothing is scheduled to wake one up.")
            self.loop.now += timeout
            return []

        def close(self):
            pass

    class VirtualLoop(asyncio.BaseEventLoop):
        def __init__(self):
            self.now = 0.0
            super().__init__()
            self._selector = Clock(self)

        def time(self):
            return self.now

        def _process_events(self, event_list):
            pass

        def _write_to_self(self):
            pass

    class Policy(asyncio.events.BaseDefaultEventLoopPolicy):
        _loop_factory = VirtualLoop

    # Typeshed's stubs list the child watcher methods as abstract; asyncio's own policy doesn't need them.
    return Policy()  # pyright: ignore[reportAbstractUsage]


@contextmanager
def virtual_asyncio(enabled: bool) -> Iterator[None]:
    """Run the block with the standard asyncio.run, no running loop, and loops on a
    virtual clock; put everything back after. Does nothing unless `enabled` (only
    programs that mention asyncio pay for it)."""
    if not enabled:
        yield
        return
    import asyncio

    events = asyncio.events
    # asyncio's private policy and running-loop slots.
    saved = (
        events._event_loop_policy,  # pyright: ignore[reportAttributeAccessIssue]
        asyncio.run,
        events._get_running_loop(),
    )
    asyncio.set_event_loop_policy(virtual_loop_policy())
    asyncio.run = asyncio.runners.run
    events._set_running_loop(None)
    try:
        yield
    finally:
        policy, asyncio.run, running = saved
        events._event_loop_policy = policy  # pyright: ignore[reportAttributeAccessIssue]
        events._set_running_loop(running)
