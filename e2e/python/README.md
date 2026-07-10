# Python SDK e2e suite

Black-box verification of the E2B compat layer under the **official `e2b`
Python package** — the second official client after the JS SDK the TS suite
uses. The sync SDK exercises wire paths the JS SDK never touches (the watcher
polling trio, httpx transport behavior), which is why this suite exists.

Not wired into `pnpm test` or CI: it needs a Python ≥3.10 interpreter, so it
runs on demand.

```sh
pnpm build                                  # the daemon under test is dist/main.js
python3 -m venv .venv                       # or: uv venv .venv
.venv/bin/pip install -r requirements.txt   # or: uv pip install -r requirements.txt --python .venv/bin/python
.venv/bin/python -m pytest -q               # fake executor by default
```

Against the real docker executor (Linux root, same ritual as the TS suite —
stop the resident daemon first, clean residue after):

```sh
DORMICE_EXECUTOR=docker DORMICE_BASE_IMAGE=<image> .venv/bin/python -m pytest -q
```

The conftest boots the daemon exactly like production (`node dist/main.js`
plus environment variables) on a random port with a throwaway ledger, and
every test talks to it only through the SDK or plain HTTP.
