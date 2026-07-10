"""Boots the daemon the way production does — `node dist/main.js` plus
environment variables — and hands tests a connection config. The Python twin
of ../src/setup/daemon.ts: nothing here imports server internals; the suite
talks to the daemon only over the wire.
"""

import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MAIN = REPO_ROOT / "packages" / "server" / "dist" / "main.js"

# A wildcard sandbox domain so get_host() and the port proxy are exercised —
# no DNS needed, tests spoof the Host header locally.
SANDBOX_DOMAIN = "sbx.dormice.test"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Daemon:
    def __init__(self, endpoint: str, token: str):
        self.endpoint = endpoint
        self.token = token

    @property
    def conn(self) -> dict:
        """The two-URL hookup: kwargs accepted by every SDK entry point.

        The token is hex on purpose — the SDK validates the API key against
        e2b_[0-9a-f]+ client-side before any request leaves the machine.
        """
        return {
            "api_key": f"e2b_{self.token}",
            "api_url": f"{self.endpoint}/e2b/api",
            "sandbox_url": f"{self.endpoint}/e2b/envd",
        }


@pytest.fixture(scope="session")
def daemon():
    if not MAIN.exists():
        raise RuntimeError(
            f"daemon build not found at {MAIN} — run `pnpm build` first"
        )

    token = secrets.token_hex(32)
    data_dir = Path(tempfile.mkdtemp(prefix="dormice-pye2e-"))
    port = free_port()
    endpoint = f"http://127.0.0.1:{port}"

    # An explicit allowlist instead of inheriting the whole environment:
    # stray DORMICE_* exports in the developer's shell must not silently
    # reconfigure the daemon under test. DORMICE_DATA_DIR defaults into the
    # throwaway directory so a docker run never drops exam disks into the
    # resident daemon's /var/lib/dormice; an exported value still wins.
    env = {"DORMICE_DATA_DIR": str(data_dir)}
    for name in ("PATH", "DORMICE_EXECUTOR", "DORMICE_BASE_IMAGE", "DORMICE_DATA_DIR"):
        if name in os.environ:
            env[name] = os.environ[name]
    env.update(
        DORMICE_PORT=str(port),
        DORMICE_DB_PATH=str(data_dir / "dormice.db"),
        DORMICE_API_TOKEN=token,
        # Sweep every second so lifecycle tests run on second-scale deadlines.
        DORMICE_SCAN_INTERVAL_SECONDS="1",
        DORMICE_SANDBOX_DOMAIN=SANDBOX_DOMAIN,
    )

    log_path = data_dir / "daemon.log"
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(
            ["node", str(MAIN)], env=env, stdout=log, stderr=subprocess.STDOUT
        )

    deadline = time.monotonic() + 10
    while True:
        if proc.poll() is not None:
            raise RuntimeError(
                f"daemon exited during startup:\n{log_path.read_text()}"
            )
        try:
            if httpx.get(f"{endpoint}/healthz", timeout=1, trust_env=False).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        if time.monotonic() > deadline:
            proc.kill()
            raise RuntimeError(
                f"daemon did not come up within 10s:\n{log_path.read_text()}"
            )
        time.sleep(0.1)

    yield Daemon(endpoint, token)

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    # Best effort: in docker mode a leaked loop mount can pin a subtree; the
    # real-machine cleanup checklist owns that case.
    shutil.rmtree(data_dir, ignore_errors=True)


@pytest.fixture(scope="session")
def conn(daemon):
    return daemon.conn


@pytest.fixture
def make_sandbox(conn):
    """Sandboxes that are always killed at test end, pass or fail."""
    from e2b import Sandbox

    created = []

    def _make(**kwargs):
        sbx = Sandbox.create(**{**conn, **kwargs})
        created.append(sbx)
        return sbx

    yield _make
    for sbx in created:
        try:
            sbx.kill()
        except Exception:
            pass  # already dead — deadline tests kill their own
