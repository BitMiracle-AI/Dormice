"""The official Python SDK (sync) against a real daemon.

The sync SDK is the reason this suite exists: unlike the JS SDK (and the
async Python SDK), its filesystem watch runs on the **polling trio**
(CreateWatcher / GetWatcherEvents / RemoveWatcher), and its transport is
httpx — wire paths the TS e2e never exercises.
"""

import io
import time
from datetime import datetime

import pytest
from e2b import (
    CommandExitException,
    FileNotFoundException,
    FilesystemEventType,
    FileType,
    InvalidArgumentException,
    PtySize,
    Sandbox,
    SandboxException,
    SandboxNotFoundException,
    SandboxQuery,
    SandboxState,
)

from conftest import SANDBOX_DOMAIN
from support import (
    docker_only,
    fake_only,
    http_get,
    http_post,
    poll_until,
    poll_until_raises,
)

# ---------------------------------------------------------------- control


def test_create_run_kill(make_sandbox):
    sbx = make_sandbox()
    assert sbx.sandbox_id

    result = sbx.commands.run("echo hi")
    assert result.exit_code == 0
    assert result.stdout == "hi\n"

    assert sbx.is_running() is True
    assert sbx.kill() is True
    # Idempotent second kill: the SDK reads the 404 as False.
    assert sbx.kill() is False
    assert sbx.is_running() is False


def test_get_info_fields(conn, make_sandbox):
    sbx = make_sandbox(metadata={"purpose": "info-fields"})
    info = sbx.get_info()

    assert info.sandbox_id == sbx.sandbox_id
    assert info.state == SandboxState.RUNNING
    assert info.metadata == {"purpose": "info-fields"}
    assert info.envd_version == "0.6.1"
    # The generated client hard-requires these — a missing field is a
    # KeyError before any assertion runs, which is exactly the regression
    # this test pins (clientID and diskSizeMB are load-bearing for Python
    # even though the JS SDK never reads them).
    assert isinstance(info.started_at, datetime)
    assert isinstance(info.end_at, datetime)
    assert info.cpu_count >= 1
    assert info.memory_mb >= 256

    # The classmethod flavor answers the same.
    again = Sandbox.get_info(sbx.sandbox_id, **conn)
    assert again.sandbox_id == info.sandbox_id

    with pytest.raises(SandboxNotFoundException):
        Sandbox.get_info("00000000-0000-0000-0000-000000000000", **conn)


def test_list_filters(conn, make_sandbox):
    sbx = make_sandbox(metadata={"suite": "py-list"})

    paginator = Sandbox.list(
        query=SandboxQuery(metadata={"suite": "py-list"}), **conn
    )
    found = paginator.next_items()
    assert [s.sandbox_id for s in found] == [sbx.sandbox_id]
    assert found[0].metadata == {"suite": "py-list"}

    # State filter: a running sandbox must not show up in a paused-only list.
    paused_only = Sandbox.list(
        query=SandboxQuery(
            metadata={"suite": "py-list"}, state=[SandboxState.PAUSED]
        ),
        **conn,
    ).next_items()
    assert paused_only == []


def test_userkey_extension_is_idempotent(conn, make_sandbox):
    first = make_sandbox(metadata={"userKey": "py-idem"})
    second = Sandbox.create(metadata={"userKey": "py-idem"}, **conn)
    # Same key, same sandbox — the Dormice extension speaks Python too.
    assert second.sandbox_id == first.sandbox_id


def test_timeout_kills_by_default(conn):
    sbx = Sandbox.create(timeout=1, **conn)
    # Protocol death is the deadline itself; the physical teardown follows
    # on the scanner's beat. The SDK sees 404 either way.
    poll_until_raises(
        SandboxNotFoundException,
        lambda: Sandbox.get_info(sbx.sandbox_id, **conn),
        what="the expired sandbox to answer 404",
    )
    assert sbx.is_running() is False


def test_timeout_pause_then_connect_resumes(conn):
    sbx = Sandbox.create(
        timeout=1, lifecycle={"on_timeout": "pause"}, **conn
    )
    try:
        poll_until(
            lambda: Sandbox.get_info(sbx.sandbox_id, **conn).state
            == SandboxState.PAUSED,
            what="the sandbox to auto-pause at its deadline",
        )
        resumed = Sandbox.connect(sbx.sandbox_id, **conn)
        assert resumed.commands.run("echo back").stdout == "back\n"
        assert (
            Sandbox.get_info(sbx.sandbox_id, **conn).state
            == SandboxState.RUNNING
        )
    finally:
        Sandbox.kill(sbx.sandbox_id, **conn)


def test_pause_resume_and_already_paused(conn, make_sandbox):
    sbx = make_sandbox()
    assert sbx.pause() is True
    # Already paused: the SDK reads the 409 as False.
    assert sbx.pause() is False
    assert sbx.get_info().state == SandboxState.PAUSED

    resumed = Sandbox.connect(sbx.sandbox_id, **conn)
    assert resumed.commands.run("echo warm").stdout == "warm\n"


def test_pause_without_memory_cold_boots(conn, make_sandbox):
    sbx = make_sandbox()
    sbx.files.write("kept.txt", "still here")
    assert sbx.pause(keep_memory=False) is True
    assert sbx.get_info().state == SandboxState.PAUSED

    # Resuming a filesystem-only snapshot is a cold boot from disk: the
    # file must have survived, in a brand-new shell.
    resumed = Sandbox.connect(sbx.sandbox_id, **conn)
    assert resumed.files.read("kept.txt") == "still here"


def test_set_timeout_extends_life(conn):
    sbx = Sandbox.create(timeout=2, **conn)
    try:
        sbx.set_timeout(3600)
        time.sleep(3)
        # Would have expired at 2s; the rewritten deadline keeps it alive.
        assert Sandbox.get_info(sbx.sandbox_id, **conn).state == SandboxState.RUNNING
    finally:
        sbx.kill()


def test_get_metrics_single_sample(make_sandbox):
    sbx = make_sandbox()
    metrics = sbx.get_metrics()
    # No metrics history lives in the daemon: the answer is always one
    # sample, taken now.
    assert len(metrics) == 1
    m = metrics[0]
    assert m.cpu_count >= 1
    assert m.mem_total > 0
    assert m.disk_total > 0
    assert isinstance(m.timestamp, datetime)


# ---------------------------------------------------------------- commands


def test_nonzero_exit_raises_command_exit(make_sandbox):
    sbx = make_sandbox()
    with pytest.raises(CommandExitException) as excinfo:
        sbx.commands.run("exit 3")
    assert excinfo.value.exit_code == 3


def test_streaming_callbacks_in_order(make_sandbox):
    sbx = make_sandbox()
    chunks = []
    result = sbx.commands.run(
        "echo first; sleep 1; echo second", on_stdout=chunks.append
    )
    assert result.exit_code == 0
    # The sleep forces two wire chunks: streaming, not one buffered blob.
    assert len(chunks) >= 2
    assert "".join(chunks) == "first\nsecond\n"


def test_background_list_connect_kill(conn, make_sandbox):
    sbx = make_sandbox()
    handle = sbx.commands.run("sleep 30", background=True)
    assert handle.pid > 0

    listed = sbx.commands.list()
    mine = [p for p in listed if p.pid == handle.pid]
    assert len(mine) == 1
    # config.cmd/args are always present — the SDK dereferences them
    # unconditionally.
    assert mine[0].cmd == "/bin/bash"
    assert mine[0].args[-1] == "sleep 30"

    # Disconnect only drops the stream; the process lives on.
    handle.disconnect()
    reconnected = sbx.commands.connect(handle.pid)
    assert sbx.commands.kill(handle.pid) is True
    with pytest.raises(CommandExitException) as excinfo:
        reconnected.wait()
    assert excinfo.value.exit_code == 137

    # The pid is gone now: kill answers False.
    assert sbx.commands.kill(handle.pid) is False


def test_stdin_echo_and_close(make_sandbox):
    sbx = make_sandbox()
    handle = sbx.commands.run("cat", background=True, stdin=True)
    handle.send_stdin("hello from python\n")
    handle.close_stdin()
    result = handle.wait()
    assert result.exit_code == 0
    assert result.stdout == "hello from python\n"


def test_run_as_root(make_sandbox):
    sbx = make_sandbox()
    assert sbx.commands.run("whoami").stdout == "user\n"
    assert sbx.commands.run("whoami", user="root").stdout == "root\n"


def test_envs_and_cwd(conn, make_sandbox):
    sbx = make_sandbox(envs={"SANDBOX_LEVEL": "floor"})
    # Sandbox-level envs are the floor; command-level envs override.
    assert sbx.commands.run("printenv SANDBOX_LEVEL").stdout == "floor\n"
    assert (
        sbx.commands.run(
            "printenv SANDBOX_LEVEL", envs={"SANDBOX_LEVEL": "override"}
        ).stdout
        == "override\n"
    )
    assert sbx.commands.run("pwd", cwd="/tmp").stdout == "/tmp\n"


def test_pty_roundtrip(make_sandbox):
    sbx = make_sandbox()
    handle = sbx.pty.create(PtySize(rows=24, cols=80))
    sbx.pty.send_stdin(handle.pid, b"echo from-pty\n")

    seen = bytearray()

    def collect(data: bytes):
        seen.extend(data)

    # The pty stream only ends when the process dies, so reap it with a
    # kill once the echo has had time to arrive.
    import threading

    waiter = threading.Thread(
        target=lambda: _swallow_exit(handle, collect), daemon=True
    )
    waiter.start()
    poll_until(lambda: b"from-pty" in seen, what="the pty echo")
    sbx.pty.resize(handle.pid, PtySize(rows=30, cols=100))
    assert sbx.pty.kill(handle.pid) is True
    waiter.join(timeout=10)
    assert not waiter.is_alive()


def _swallow_exit(handle, on_pty):
    try:
        handle.wait(on_pty=on_pty)
    except CommandExitException:
        pass  # killed on purpose


# ---------------------------------------------------------------- files


def test_files_write_read_roundtrip(make_sandbox):
    sbx = make_sandbox()
    info = sbx.files.write("notes/hello.txt", "hello from python\n")
    assert info.path == "/home/user/notes/hello.txt"
    assert info.name == "hello.txt"
    assert info.type == FileType.FILE

    assert sbx.files.read("notes/hello.txt") == "hello from python\n"
    raw = sbx.files.read("/home/user/notes/hello.txt", format="bytes")
    assert bytes(raw) == b"hello from python\n"

    with sbx.files.read("notes/hello.txt", format="stream") as stream:
        assert b"".join(stream) == b"hello from python\n"


def test_files_filelike_uses_octet_stream(make_sandbox):
    sbx = make_sandbox()
    payload = bytes(range(256)) * 64
    # A file-like body routes the SDK onto the octet-stream upload path.
    sbx.files.write("blob.bin", io.BytesIO(payload))
    assert bytes(sbx.files.read("blob.bin", format="bytes")) == payload


def test_files_gzip_upload(make_sandbox):
    sbx = make_sandbox()
    payload = b"compressible " * 1024
    # gzip=True sends Content-Encoding: gzip over the octet-stream path;
    # the daemon must store the decoded bytes, not the gzip framing.
    sbx.files.write("zipped.txt", payload, gzip=True)
    assert bytes(sbx.files.read("zipped.txt", format="bytes")) == payload


def test_files_list_depth_exists_info(make_sandbox):
    sbx = make_sandbox()
    sbx.files.write("tree/top.txt", "t")
    sbx.files.write("tree/sub/deep.txt", "d")

    top = sbx.files.list("tree")
    assert sorted(e.name for e in top) == ["sub", "top.txt"]
    deep = sbx.files.list("tree", depth=2)
    assert "deep.txt" in [e.name for e in deep]

    assert sbx.files.exists("tree/top.txt") is True
    assert sbx.files.exists("tree/absent.txt") is False

    info = sbx.files.get_info("tree/sub")
    assert info.type == FileType.DIR
    assert info.path == "/home/user/tree/sub"

    with pytest.raises(FileNotFoundException):
        sbx.files.get_info("tree/absent.txt")
    # Reading a directory is dishonest as file content: typed refusal.
    with pytest.raises(InvalidArgumentException):
        sbx.files.read("tree")


def test_files_mkdir_rename_remove(make_sandbox):
    sbx = make_sandbox()
    assert sbx.files.make_dir("made/dir") is True
    # Already there: the SDK reads already_exists as False.
    assert sbx.files.make_dir("made/dir") is False

    sbx.files.write("made/dir/a.txt", "x")
    moved = sbx.files.rename("made/dir/a.txt", "made/dir/b.txt")
    assert moved.path == "/home/user/made/dir/b.txt"
    assert sbx.files.exists("made/dir/a.txt") is False

    sbx.files.remove("made/dir/b.txt")
    assert sbx.files.exists("made/dir/b.txt") is False


# ---------------------------------------------------------------- watch
# The polling trio is the whole reason this suite exists: the sync SDK is
# its only official consumer, and the JS e2e can only poke it with raw fetch.


def test_watch_polling_trio(make_sandbox):
    sbx = make_sandbox()
    sbx.files.make_dir("watched")
    handle = sbx.files.watch_dir("watched")

    sbx.files.write("watched/one.txt", "1")
    events = poll_until(
        lambda: handle.get_new_events(), what="events for the first write"
    )
    names = {(e.name, e.type) for e in events}
    assert (
        "one.txt",
        FilesystemEventType.CREATE,
    ) in names or ("one.txt", FilesystemEventType.WRITE) in names

    # Draining resets the buffer: an immediate second poll is empty.
    assert handle.get_new_events() == []

    sbx.files.write("watched/two.txt", "2")
    more = poll_until(
        lambda: handle.get_new_events(), what="events for the second write"
    )
    assert any(e.name == "two.txt" for e in more)

    handle.stop()
    # The handle refuses further polls once stopped — client-side.
    with pytest.raises(SandboxException):
        handle.get_new_events()


def test_watch_recursive_sees_subdirs(make_sandbox):
    sbx = make_sandbox()
    sbx.files.make_dir("deepwatch")
    handle = sbx.files.watch_dir("deepwatch", recursive=True)
    try:
        sbx.files.write("deepwatch/sub/leaf.txt", "x")
        events = poll_until(
            lambda: handle.get_new_events(), what="recursive events"
        )
        # Event names are relative to the watched directory.
        assert any(e.name.startswith("sub") for e in events)
    finally:
        handle.stop()


def test_watch_missing_dir_is_typed(make_sandbox):
    sbx = make_sandbox()
    with pytest.raises(FileNotFoundException):
        sbx.files.watch_dir("no-such-dir")


# ---------------------------------------------------------------- signed URLs
# Consumed by bare HTTP clients (no SDK headers): the sandbox identity is
# recovered from the signature itself.


def test_signed_download_and_upload(make_sandbox):
    sbx = make_sandbox()
    sbx.files.write("public.txt", "published")

    url = sbx.download_url("public.txt")
    got = http_get(url)
    assert got.status_code == 200
    assert got.content == b"published"

    up = sbx.upload_url("incoming.txt")
    posted = http_post(up, files={"file": ("incoming.txt", b"delivered")})
    assert posted.status_code == 200
    assert sbx.files.read("incoming.txt") == "delivered"


def test_signed_url_expiration_and_tamper(make_sandbox):
    sbx = make_sandbox()
    sbx.files.write("secret.txt", "timed")

    url = sbx.download_url("secret.txt", use_signature_expiration=1)
    assert http_get(url).status_code == 200
    time.sleep(2)
    expired = http_get(url)
    assert expired.status_code == 401
    assert "expired" in expired.json()["message"]

    tampered = sbx.download_url("secret.txt").replace(
        "signature=v1_", "signature=v1_x"
    )
    assert http_get(tampered).status_code == 401


# ---------------------------------------------------------------- get_host


def test_get_host_shape(make_sandbox):
    sbx = make_sandbox()
    host = sbx.get_host(8000)
    assert host == f"8000-{sbx.sandbox_id}.{SANDBOX_DOMAIN}"


@fake_only
def test_proxy_routes_by_host_header(daemon, make_sandbox):
    # The fake executor answers proxied traffic with an in-memory echo
    # upstream — the proxy chain is real, only the upstream is fake.
    sbx = make_sandbox()
    host = sbx.get_host(8000)
    res = http_get(f"{daemon.endpoint}/probe", headers={"Host": host})
    assert res.status_code == 200
    body = res.json()
    assert body["sandboxId"] == sbx.sandbox_id
    assert body["path"] == "/probe"


# ---------------------------------------------------------------- docker-only


@docker_only
def test_real_shell_and_root_power(make_sandbox):
    sbx = make_sandbox()
    # A real login shell in a real container: the disk's birthmark exists.
    result = sbx.commands.run("ls /home/user")
    assert result.exit_code == 0
    # root's actual power, not just its name: /root is readable.
    root_ls = sbx.commands.run("ls /root", user="root")
    assert root_ls.exit_code == 0
