# AI Executive

**Product name: AIfréd** — a proactive personal chief of staff. AI Executive remains the technical repository/service name.

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
- Proactive morning briefs and evening reviews with deterministic top-three, risk and capacity heuristics
- Read-only private ICS calendars with normalized recurring events, busy-time merging and free-window planning
- Deterministic threat detection with Web Push fallback and a least-privilege Hermes Telegram outbox

## PACT architecture

AI Executive uses PACT (Projects, Agents, Context, Tools) as the target operating model for the Personal AI OS. PACT is an architectural layer over the existing local-first task model, not a replacement for it.

### P — Projects

Existing Areas, Projects, Tasks, Notes and Relations form the P layer and retain their IDs, workspace boundaries, recurrence, history and offline/sync behavior. Projects can reference project-scoped context, preferred agents and allowed tools. All my work remains an aggregate read view, never a write target.

### A — Agents

Agents are reusable, versioned definitions of repeatable AI work, not unrestricted chatbots. Each agent declares its purpose/instructions, permitted context scopes, tool capabilities, workspace/project scope, trigger mode, output contract and mutation/approval policy.

Initial built-ins: Executive Assistant, Morning Planner, Evening Reviewer, Inbox Processor, Project Manager, Researcher and Meeting Prep. Existing deterministic briefings remain a safe fallback and validation layer.

Agents never receive provider credentials or bypass authorization. Model-proposed actions always pass through the Tool Registry and policy layer.

### C — Context

Context becomes a first-class structured layer separate from tasks and notes. Supported scopes include me, work, family, rules, project-specific and workspace-specific context.

Each context item records provenance, workspace, sensitivity, timestamps and lifecycle. Owner-authored facts must remain distinguishable from AI-derived context. Material AI-suggested durable context requires confirmation.

A Context Resolver builds the minimum permitted context bundle for each agent run. It selects only scopes allowed by the agent, workspace/project and operation. Sensitive context cannot silently cross workspace boundaries or be sent to external providers unless policy permits it.

### T — Tools

Agent capabilities are exposed through a typed Tool Registry rather than direct database/provider access. Initial tools include task read/propose-create/propose-update/propose-complete, project read/search, note read/search, calendar read/find-free-time, context read and briefing read.

Future adapters can add email search/draft, calendar writes, Microsoft Graph, files, web research and other services without changing agent definitions. Every tool declares input/output schemas, read/write classification, scope, audit behavior and approval policy.

### Executive Orchestrator

For each run the orchestrator resolves workspace/project, loads the agent, resolves minimum context, exposes only allowlisted tools, runs deterministic and/or model reasoning, validates structured output, executes permitted reads and converts mutations into proposals. Confirmation, audit and guarded Undo remain server-controlled.

The model is never the authority for access control or writes.

### Permission model

- READ: automatic only inside explicitly allowed scopes.
- PROPOSE: AI may prepare a mutation but cannot apply it.
- WRITE: a validated proposal is applied only after required approval.
- SEND / EXTERNAL SIDE EFFECT: explicit approval by default plus a dedicated tool policy.

Scheduled/proactive agents may perform read-only analysis automatically and create briefings/proposals. Autonomous external side effects require a separately configured policy.

### Target execution flow

    Inputs / events / schedules
              |
              v
     Executive Orchestrator
              |
       +------+------+ 
       |      |      |
     Agents Context Tools
       |      |      |
       +------+------+ 
              |
              v
     Projects / Tasks / Notes
              |
              v
     Proposal -> Approval -> Execute -> Audit -> Undo

A morning run can combine an Executive Assistant or Morning Planner with active projects/tasks, relevant personal/work/project context and read-only calendar tools. It identifies risks, capacity and next actions, then proposes changes instead of silently mutating the plan.

### PACT implementation status

The server-side PACT foundation is now in place: SQLite persistence for agents, durable context, tool permissions and agent runs; a default AIfréd agent; a workspace-scoped Context Resolver; and a typed read-only Tool Registry. Provider-assisted reasoning now receives canonical entities and non-sensitive durable context through the resolver. Mutations continue to use the existing proposal -> confirmation -> audit -> Undo boundary.

The authenticated AIfréd integration API is now implemented for external conversational clients. It uses a dedicated bearer token and requires one explicit workspace. The planning endpoint can return read-only answers or create approval-bound proposals. A separate read-only tools endpoint exposes only task.read, project.read, note.read, calendar.read, calendar.free_time and context.read; task.propose cannot be invoked through that endpoint. Proposal confirmation is intentionally not exposed to the external integration. A versioned OpenAPI 3.1 schema lives at `docs/aifred-openapi.json`, and the running app serves an origin-aware copy at `/api/integrations/aifred/openapi`. This is the contract for a future ChatGPT/Voice connector; it advertises only planning and allowlisted read operations. Owner-only durable context management is available through `/api/context` and the Settings UI. The owner can list, create and archive context, choose scope and sensitivity, and bind project context only to a project in the same workspace. Sensitive items remain visible to the owner UI/API but are excluded from the external `context.read` tool and provider reasoning by default. Next: migrate proactive morning/evening briefings onto tracked PACT agent runs.

### Implementation roadmap

1. PACT foundation: schemas/tables for agents, context, tool permissions and agent runs; preserve all current entities.
2. Context Resolver: scoped retrieval, provenance, sensitivity and owner editing.
3. Tool Registry: wrap current task/project/note/calendar operations behind typed capabilities and the existing proposal boundary.
4. Executive Orchestrator: deterministic orchestration first, then provider-assisted structured reasoning.
5. Built-in agents: migrate Morning Brief and Evening Review, then add Executive Assistant, Project Manager and Meeting Prep.
6. External adapters: email, Microsoft Graph/files/web and other connectors through normalized tools.
7. Controlled proactivity: event-driven runs and configurable approval policies while retaining least privilege, auditability and reversible local mutations.

The first PACT milestone is complete when an Executive Assistant can read one workspace, receive a minimal resolved context bundle, inspect tasks/projects/calendar through registered read tools, produce a structured daily recommendation and propose task changes through the existing confirmation mechanism without direct database or provider credentials.

### ChatGPT / Voice integration contract

External conversational clients authenticate with `Authorization: Bearer <AI_EXECUTIVE_INTEGRATION_TOKEN>`. Use a dedicated random token of at least 32 characters and never reuse the browser password, session secret, Hermes token or calendar secret. The connector must select one explicit workspace for every call; `all` is rejected.

The OpenAPI contract exposes two operations: `planWithAifred` for reasoning and approval-bound proposals, and `readAifredTool` for the allowlisted read-only Tool Registry. A proposal returned to ChatGPT is only a pending proposal; the owner must confirm it through AI Executive. The integration has no confirmation, Undo, arbitrary database or provider-credential endpoint.

Before connecting an external client in production, deploy the new code, set `AI_EXECUTIVE_INTEGRATION_TOKEN` in the root-managed service environment, restart AI Executive, and verify that the OpenAPI endpoint is reachable only over the intended HTTPS/Tailscale path. Do not expose the local Node listener directly to the public Internet.

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

The deterministic local planner provides today's brief, task creation,
rescheduling/snoozing, completion, priority changes and project moves without
an external model. Every mutation remains a proposal with confirmation and
guarded Undo. For broader read-only answers, set
`AI_PROVIDER=hermes`, `HERMES_AI_ENABLED=true`, `HERMES_BRIDGE_URL` and
`HERMES_BRIDGE_TOKEN`, or configure `OPENAI_API_KEY` and `OPENAI_MODEL`.
Provider secrets remain server-side. The current Hermes bridge invokes the
Hermes agent CLI, so enable it only with a dedicated read-only profile; provider
output never bypasses the application's proposal/confirmation boundary.

## Proactive executive briefings

Settings can enable a morning brief and evening review for one explicit
workspace, IANA timezone and set of working days. The server reads canonical
SQLite data and stores one durable briefing per kind, workspace and local date,
so restarts and repeated DST hours do not duplicate it. A skipped wall-clock
time is caught up on the next scheduler tick. The capacity warning is explicitly
heuristic because the MVP does not yet read calendar availability or task effort.

Push contains only summary counts; task titles stay in the authenticated app.
Manual “Vytvořit teď” runs are in-app only and do not send notifications.
Telegram is a separate explicit opt-in and includes workspace and top-task
titles. Install its least-privilege Hermes adapter from a clean reviewed commit:

```bash
git diff --exit-code -- ops/executive-briefings
sudo ./ops/executive-briefings/install.sh
systemctl status ai-executive-briefings.timer
```

The adapter creates `/var/lib/ai-executive-briefings`; AI Executive can only
write the outbox and receives no Hermes or Telegram credential. Delivery is
at-least-once: an unlikely crash after Telegram accepts a message but before the
queue file is archived can duplicate that message.

## Read-only calendar planning

MVP7 accepts a private HTTPS ICS feed for one explicit workspace. The bearer
URL is encrypted at rest and is never returned by the API, copied into normal
entities/backups, sent to AI, or included in audit records. Set a stable random
`AI_EXECUTIVE_CALENDAR_SECRET` (at least 32 characters); otherwise encryption
falls back to the session secret, and rotating that secret requires reconnecting
calendar feeds.

The fetcher pins a validated public DNS answer for each HTTPS hop, rejects
loopback/private/link-local destinations and credentials in URLs, revalidates
redirects, and bounds redirects, time, bytes, lines, events and recurrence
frequency. Parsing uses `node-ical` for TZID, RRULE, EXDATE and recurrence
overrides. Only normalized title/time/status data is kept; descriptions,
attendees and locations are discarded. Private events are stored under the
generic title “Soukromá událost”.

Calendar events remain read-only. The Home view merges overlapping busy
intervals and shows actual free blocks inside the configured workday. A failed
or older-than-24-hours source is marked stale, and executive briefings will not
claim a free slot from stale data. The current horizon is 14 days back and 90
days forward; sources refresh at most every 30 minutes in the single always-on
Node process. Microsoft Graph can later implement the same normalized adapter
without changing the planning model.

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
