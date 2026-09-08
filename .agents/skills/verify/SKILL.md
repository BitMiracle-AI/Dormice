---
name: verify
summary: Drive Dormice's built daemon over its public HTTP and E2B surfaces.
---

# Verify Dormice runtime behavior

1. Run `pnpm build` before verification; the black-box surface is `packages/server/dist/main.js`.
2. Launch an isolated fake daemon with an unused port, a temporary absolute `DORMICE_DB_PATH`/`DORMICE_DATA_DIR`, a 64-hex `DORMICE_API_TOKEN`, and `DORMICE_EXECUTOR=fake`.
3. Wait for `GET /healthz`, then drive native or E2B routes only over HTTP. E2B control auth is `X-API-KEY: e2b_<token>`; envd requests use the returned `sandboxID`/`envdAccessToken` as `E2b-Sandbox-Id` and `X-Access-Token`.
4. Connect streaming requests use one envelope: flag byte `0`, four-byte big-endian JSON length, then JSON bytes. Parse responses as repeated envelopes.
5. Capture response status/body inline. Probe malformed input, replay/concurrency, and resource cleanup around the claimed flow.
6. Stop the daemon and remove its temporary directory. Docker/gVisor process facts require the Linux test host and cannot be established with the fake executor.
