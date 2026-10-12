# Security audit — 2026-09-30

## Scope and method

The audit combined two independent, non-destructive penetration reviews,
white-box inspection, safe unauthenticated production probes and a separate
monitoring review. No brute force, denial of service, destructive request,
credential extraction or mutation of production workspace data was performed.

The tested controls rejected anonymous reads and writes with 401, rejected a
foreign Origin with 403, returned 404/405 for invalid paths and methods, and
served a valid TLS certificate. The production dependency audit reported no
known production-package vulnerability. No P0 or confirmed application-entry
P1 exploit was found.

## Findings

### P1 — Security events did not create an alert

Before remediation, rejected login and AI requests appeared only in the local
SQLite `security_events` table. They were absent from the application journal,
no process read the table, and no notification was sent. Anonymous GET probes,
404/405 responses and several early-return branches were not recorded at all.

Live evidence: deliberate unauthenticated `POST /api/ai` and an invalid login
created events 109 and 110, while unauthenticated `GET /api/store` and
`GET /api/auth/passkeys` created no event. No active alert fired.

Remediation in this release: uniform logging was added to sensitive early
returns, rejected events are no longer silently coalesced, alert rules are
deterministic, and alerts are queued for Hermes Telegram with Web Push as a
fallback. Generic 404 access logging still requires a reverse-proxy access-log
sink and remains a residual visibility gap.

### P2 — One client could exhaust the global login rate limit

All clients previously shared `single-user` as the rate-limit identity. Ten
invalid attempts from one source could make a correct login from another source
return 429 for the remainder of the 15-minute window.

Remediation in this release: limits now use the trusted Tailscale proxy source
identity plus a larger global ceiling. An isolated regression test produced 429
for the attacking source while a correct login from a different source still
returned 200.

### P2 — Audit attribution and retention were insufficient

Every event had the same actor hash, no request ID, method or route. Rejected
events inside a 60-second window were discarded without a count. Retention was
the newest 1,000 rows in the mutable application database.

Remediation in this release: actor identifiers are keyed HMACs over the trusted
proxy source, every event receives a request ID/method/path, rejected events are
retained individually, and indexes support time/action queries. Raw addresses,
headers, credentials and bodies are not stored. Off-host immutable retention is
still recommended.

### P2 — Production service hardening is incomplete

The AI Executive systemd unit runs as `hermesadmin` without `NoNewPrivileges`,
`ProtectSystem`, `ProtectHome`, `PrivateTmp` or an empty capability bounding
set. Its data and `.env` permissions are appropriately restrictive (0700/0600),
and the application itself listens only on loopback.

Recommendation: move the app to a dedicated unprivileged account and apply the
same systemd hardening pattern used by the new Hermes alert delivery service.

Status: the migration runbook is `docs/PRECHOD-SYSTEMOVY-UCET.md`; this finding stays open until it has been carried out on the server.

### P2 — Public Hermes MCP information surface

Tailscale Funnel exposes the Hermes bridge on the hostname's default HTTPS
port. The bridge source explicitly mounts a temporarily unauthenticated,
read-only MCP endpoint that can return Hermes status and installed skills. The
authenticated REST API remains token-protected, but the public MCP endpoint is
an unnecessary information-disclosure surface.

Recommendation: disable the Funnel when it is not required, or put OAuth/auth
in front of `/mcp` and keep only the health endpoint public.

### P3 — HTTPS responses lacked HSTS

TLS and certificate validation succeeded, but HTTPS responses had no
`Strict-Transport-Security` header. This release adds a six-month HSTS policy.

## Monitoring acceptance criteria

- One anonymous mutating request creates a critical alert without changing data.
- Three authentication failures from one source within ten minutes create one
  critical incident alert.
- Five rejected protected reads within five minutes create a warning.
- A rate-limit event creates a critical alert.
- The alert contains only rule, severity, bounded summary, count, time and a
  pseudonymous source ID.
- Hermes delivers through its configured Telegram home channel without sharing
  Hermes or Telegram credentials with AI Executive.
- The sender atomically claims alerts into a Hermes-only directory before
  parsing them, derives notification text from an allowlist of rules and does
  not trust app-supplied free-form alert text.
- If Hermes delivery is unavailable, registered PWA devices still receive Web
  Push; the outbox file remains queued for retry.
