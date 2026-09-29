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

Set `VAPID_SUBJECT` to a `mailto:` contact if desired.

## AI provider

The assistant calls server-side `/api/ai`. Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the deployment environment. Secrets are never stored in IndexedDB or exposed to the browser. If the endpoint is unavailable, the UI falls back to `LocalPreviewProvider`.
