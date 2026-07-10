"""A slim async pass: AsyncSandbox drives the same wire the JS SDK does,
but through Python's async httpx transport — and its watch_dir consumes the
**streaming** WatchDir (the sync SDK polls), so this is the one place the
Python stream parser reads our filesystem event frames.

Wrapped in asyncio.run inside plain test functions on purpose: no
pytest-asyncio dependency for three tests.
"""

import asyncio

from e2b import AsyncSandbox, CommandExitException

from support import poll_until


def test_async_create_run_kill(conn):
    async def flow():
        sbx = await AsyncSandbox.create(**conn)
        try:
            result = await sbx.commands.run("echo async hi")
            assert result.exit_code == 0
            assert result.stdout == "async hi\n"

            try:
                await sbx.commands.run("exit 7")
                raise AssertionError("exit 7 must raise")
            except CommandExitException as e:
                assert e.exit_code == 7
        finally:
            assert await sbx.kill() is True

    asyncio.run(flow())


def test_async_files_roundtrip(conn):
    async def flow():
        sbx = await AsyncSandbox.create(**conn)
        try:
            await sbx.files.write("async.txt", "written async")
            assert await sbx.files.read("async.txt") == "written async"
        finally:
            await sbx.kill()

    asyncio.run(flow())


def test_async_watch_is_streaming(conn):
    async def flow():
        sbx = await AsyncSandbox.create(**conn)
        try:
            await sbx.files.make_dir("streamwatch")
            events = []
            handle = await sbx.files.watch_dir(
                "streamwatch", on_event=events.append
            )
            await sbx.files.write("streamwatch/ping.txt", "x")

            deadline = asyncio.get_event_loop().time() + 15
            while not any(e.name == "ping.txt" for e in events):
                if asyncio.get_event_loop().time() > deadline:
                    raise AssertionError(
                        f"no streamed event for ping.txt; saw {events}"
                    )
                await asyncio.sleep(0.25)
            await handle.stop()
        finally:
            await sbx.kill()

    asyncio.run(flow())
