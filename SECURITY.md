# Security Policy

Dormice runs untrusted code on your own machine — security reports are
the most valuable kind of feedback this project can get.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public
issue is a zero-day announcement for everyone running Dormice.

Instead, use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/BitMiracle-AI/Dormice/security/advisories/new)
— it opens a private thread between you and the maintainers.

You can expect an acknowledgement within 7 days. Dormice is in early
development and not yet recommended for production, so there is no
formal SLA and no bug bounty — but security reports are prioritized
over feature work, and you will be credited in the advisory unless you
prefer otherwise.

## What counts

Anything that breaks the model documented in the README, for example:

- **Sandbox escape**: code inside a sandbox affecting the host or
  another sandbox (the isolation boundary is Docker + gVisor).
- **Authentication bypass** on the daemon API, the E2B-compatible
  surface, the signed file URLs, or the web console's session cookies.
- **Unexpected exposure**: the daemon being reachable in ways the
  documentation says it is not (it binds to 127.0.0.1 only, by design).

Vulnerabilities in upstream components (gVisor, Docker, Node.js) belong
with those projects — but if Dormice *configures* them insecurely, that
is ours and we want to know.

## Supported versions

Pre-1.0, only the latest release and `main` receive fixes.
