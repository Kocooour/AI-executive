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

The assistant calls server-side `/api/ai`. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the deployment environment. Secrets are never stored in IndexedDB or exposed to the browser. If the endpoint is unavailable, the UI falls back to `LocalPreviewProvider`.
