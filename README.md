# AI Executive

Local-first Personal AI OS prototype built with Next.js, Dexie and SQLite.

## Run

```bash
npm install
npm run dev
```

For production, run one always-on Node.js process (the current deployment uses systemd):

```bash
npm run build
npm run start -- --hostname 127.0.0.1
```

## Current MVP

- Responsive desktop and mobile task workspace
- Inbox, Today, Overdue, Upcoming, Anytime, Someday and Completed views
- Projects, areas, notes, relations and relation-aware search/context
- Persistent Personal and Shared workspaces, scoped views, and an All my work aggregate
- Task dates, deadlines, priority, notes, checklist, recurrence and history
- Quick Capture with Czech today/tomorrow/date parsing and priority tokens
- SQLite server source of truth with local IndexedDB cache and conflict-aware sync
- Daily/manual/safety backups and tombstones for deletion sync
- Installable PWA with an offline shell
- Web Push reminders delivered by a server scheduler while the PWA is closed
- Server-verified AI briefings and an approval-based task action loop with audit and Undo
- Deterministic threat detection with Web Push fallback and a least-privilege Hermes Telegram outbox

## Persistence and backups

- SQLite lives at `.data/store.sqlite` or `$AI_EXECUTIVE_DATA_DIR/store.sqlite`.
- An existing `.data/store.json` is migrated on first access without changing entity IDs or relations and remains as a recovery copy.
- Logical JSON backups live in `.data/backups`. Settings can create and restore them; restore creates a safety backup first.
- One automatic daily backup is created before the first data change of the day.

## Push reminders

The server creates and stores its VAPID key pair in SQLite. Push subscriptions and per-device delivery claims are durable across process restarts. The scheduler runs inside the single always-on Node.js service, catches up due reminders after a restart, and is not intended for serverless scale-to-zero or multi-host deployments.

On iPhone, install the PWA from its HTTPS address first, open the installed app, then enable notifications in Settings. Explicit reminder timestamps are stored in UTC; the workday shortcut converts the configured IANA timezone and workday profile to an exact instant.

Set `VAPID_SUBJECT` to a public HTTPS app origin (recommended for Apple Push
Service) or a valid `mailto:` contact. Do not use localhost or a `.local`
address: Apple rejects those VAPID identities with `BadJwtToken`. If the value
is omitted, the server uses the first HTTPS origin from
`AI_EXECUTIVE_PASSKEY_ORIGINS` or `AI_EXECUTIVE_ALLOWED_ORIGINS`.

## Security deployment

The MVP4 security layer adds streamed request-size limits, schema validation, rate limits, same-origin checks, security headers, bounded backup retention, and a bounded operational security event log that never stores task content or credentials. The event log is best-effort diagnostics, not a transactionally complete compliance ledger.

MVP4 also introduces the persistent workspace boundary. `All my work` is an aggregate view, never a write target; each create operation resolves to one explicit workspace. Cross-workspace relations are rejected. Shared workspaces currently have an owner membership seam, but invitations and additional accounts remain disabled until multi-user identity and server-side membership authorization are implemented.

The hardened unit template at `deployment/ai-executive.service` intentionally uses a dedicated `ai-executive` account, owner-only state directory, loopback binding, an external root-managed environment file, no Linux capabilities, and systemd filesystem/device isolation. Migrate the existing data and service only during a planned maintenance window; do not install the template over the current shared `hermesadmin` service without moving `.data` and `.env` first.

Production authentication fails closed: without a valid password hash and session secret the protected APIs return `401` and sign-in returns `503`. Only local non-production development can explicitly opt out with `AI_EXECUTIVE_AUTH_ENABLED=false`. Generate a password hash without placing the password in shell history:

```bash
read -s AI_EXECUTIVE_PASSWORD
printf '%s\n' "$AI_EXECUTIVE_PASSWORD" | npm run --silent hash-password
openssl rand -base64 48
unset AI_EXECUTIVE_PASSWORD
```

Store the printed `scrypt:<salt>:<hash>` value as `AI_EXECUTIVE_PASSWORD_HASH`, the random value as `AI_EXECUTIVE_SESSION_SECRET`, and set `AI_EXECUTIVE_AUTH_ENABLED=true` in the required root-managed service environment. The colon-separated form avoids dotenv expansion; legacy dollar-separated hashes remain accepted for migration. If a proxy reconstructs a different request URL, add the exact comma-separated browser origin to `AI_EXECUTIVE_ALLOWED_ORIGINS`. Authentication protects every data, backup, notification and AI API with an opaque 7-day HttpOnly, Secure, SameSite=Strict session cookie. Sign-out clears the current browser cookie; rotate the session secret to revoke all existing sessions. Use `https://vm13861.tail412944.ts.net:8443` on iPhone. On a Mac SSH tunnel, consistently open `http://localhost:3000` (do not switch between `localhost` and `127.0.0.1`) and verify that a reload keeps the session. The plaintext tailnet IP is intentionally unsuitable for secure sign-in.

Passkeys are optional and keep password sign-in as recovery. Set `AI_EXECUTIVE_PASSKEY_ORIGINS` to an exact comma-separated allowlist such as `https://vm13861.tail412944.ts.net:8443,http://localhost:3000`. Each hostname is a separate WebAuthn RP ID; an iCloud-synced passkey is shared across devices only when they use the same HTTPS hostname. Registration requires an existing authenticated owner session, user verification, and a one-time five-minute challenge. Credentials, counters, and metadata are stored in SQLite; private keys never leave the authenticator.

## AI provider

The assistant calls server-side `/api/ai`. It reconstructs its context from the
canonical SQLite snapshot and ignores client-supplied entity data. Task writes
are stored as five-minute proposals and do not mutate data until the owner
confirms them. Confirmation is session-bound, revision-checked and idempotent;
successful changes have a guarded server-side Undo.

The deterministic local planner provides today's brief, task creation and task
rescheduling without an external model. For broader read-only answers, set
`AI_PROVIDER=hermes`, `HERMES_AI_ENABLED=true`, `HERMES_BRIDGE_URL` and
`HERMES_BRIDGE_TOKEN`, or configure `OPENAI_API_KEY` and `OPENAI_MODEL`.
Provider secrets remain server-side. The current Hermes bridge invokes the
Hermes agent CLI, so enable it only with a dedicated read-only profile; provider
output never bypasses the application's proposal/confirmation boundary.

## Security alerts

Rejected requests are recorded with a request ID, route, method and a keyed,
pseudonymous source identifier. The monitor raises alerts for unauthorized
write attempts, repeated authentication failures, protected-route probing and
rate-limit activation. It never sends cookies, request bodies, task content or
raw IP addresses to an alert channel.

Web Push is the fallback alert channel. Production also uses the files in
`ops/security-alerts`: AI Executive writes a narrow JSON alert to a setgid
outbox, and a hardened oneshot service running as the unprivileged `hermes`
account delivers it to the configured Telegram home channel through Hermes.
The application receives no Hermes, Telegram or bridge credential.

Install the production delivery service only from the clean, reviewed commit
you intend to deploy. Before granting `sudo`, confirm that the checkout has no
unexpected modifications and record its exact revision:

```bash
git status --short
git rev-parse HEAD
sudo ./ops/security-alerts/install.sh
```

The installer creates `/var/lib/ai-executive-security`, enables the one-minute
timer, configures the application outbox and restarts AI Executive. Verify with
`systemctl status ai-executive-security-alerts.timer` and inspect delivery
failures with `journalctl -u ai-executive-security-alerts.service`.

## Server security monitoring

The separate collector under `ops/server-security` monitors the host rather
than the application. It detects repeated SSH/sudo failures, new fail2ban bans,
stopped or failed services, new non-loopback/non-Tailscale listeners, changes
to Tailscale Serve/Funnel or UFW, bursts of firewall blocks, and integrity
changes to SSH, sudo, account and selected systemd configuration. The initial
run records a baseline and does not alert on existing ports or configuration.

The root collector has no network access and never sends log text, usernames,
raw addresses, file contents or credentials. It writes a sanitized event to a
dedicated queue that AI Executive cannot access. A separate oneshot running as
`hermes` converts only allowlisted event types into Czech Telegram messages.

Install from a clean, reviewed revision:

```bash
git diff --exit-code -- ops/server-security ops/security-alerts
git rev-parse HEAD
sudo ./ops/server-security/install.sh
```

The installer creates two one-minute timers. Check them with
`systemctl status server-security-monitor.timer server-security-alerts.timer`
and inspect failures with `journalctl -u server-security-monitor.service -u server-security-alerts.service`.
