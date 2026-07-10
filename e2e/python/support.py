"""Shared helpers for the Python e2e suite."""

import os
import time

import httpx
import pytest

EXECUTOR = os.environ.get("DORMICE_EXECUTOR", "fake")

docker_only = pytest.mark.skipif(
    EXECUTOR != "docker",
    reason="needs the docker executor (real machine)",
)

fake_only = pytest.mark.skipif(
    EXECUTOR == "docker",
    reason="observes fake-executor internals (the in-memory echo upstream)",
)


def http_get(url: str, **kwargs) -> httpx.Response:
    """A bare GET that never uses a proxy. trust_env=False matters: on macOS
    Python's getproxies() reads the *system* proxy settings, so a developer
    running a local proxy client would have these probes silently relayed —
    and a spoofed-Host request answered by the proxy client's own 502
    (measured 2026-07-10). The SDK is immune (it builds explicit transports);
    only the suite's raw probes need this.
    """
    return httpx.get(url, trust_env=False, **kwargs)


def http_post(url: str, **kwargs) -> httpx.Response:
    """A bare POST that never uses a proxy; see http_get."""
    return httpx.post(url, trust_env=False, **kwargs)


def poll_until(check, deadline_s: float = 15.0, interval: float = 0.25, what: str = "condition"):
    """Poll `check` until it returns a truthy value; the truthy value is
    returned. Real wall-clock polling with a deadline instead of fixed naps —
    a slow machine stretches schedules, and fixed naps are flaky-red bait.
    """
    deadline = time.monotonic() + deadline_s
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {deadline_s}s waiting for {what}")
        time.sleep(interval)


def poll_until_raises(exc_type, fn, deadline_s: float = 15.0, interval: float = 0.25, what: str = "exception"):
    """Poll until `fn()` raises `exc_type`; returns the exception."""
    deadline = time.monotonic() + deadline_s
    while True:
        try:
            fn()
        except exc_type as e:  # noqa: PERF203 — polling loop
            return e
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {deadline_s}s waiting for {what}")
        time.sleep(interval)
