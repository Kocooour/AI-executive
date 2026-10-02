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
- Quick Capture with Czech today/tomorrow/date parsing, priority tokens and a reviewable Albert suggestion for project, area, priority, effort and the first suitable free calendar block
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

Context is a first-class structured layer over the existing canonical entities, tasks and notes. The next specification is [Personal Context Graph v2](#personal-context-graph-v2--target-specification): evidence-backed claims and typed relations, claim-level review, durable revision history and an Obsidian-inspired owner workspace.

Supported PACT scopes remain me, work, family, rules, project and workspace. Scope is not a substitute for workspace authorization or sensitivity. Owner statements, imported evidence and AI inferences remain distinguishable; confirmation applies to an individual claim and never implicitly completes a task or verifies every fact about a person.

The Context Resolver builds the minimum permitted bundle for each agent run from the canonical SQLite state. It enforces workspace/project, agent/tool, sensitivity, review status and freshness before returning data. Sensitive context cannot silently cross workspace boundaries or reach external providers. Graph v2 is a planned extension of this resolver and the existing proposal -> approval -> audit -> Undo boundary, not a second assistant or an independent source of truth.

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

The owner UI now exposes a dedicated Agents view with Morning Planner, Evening Reviewer, Project Manager and Meeting Prep. Each manual run requires one explicit workspace, uses only the agent's declared tools and context scopes, and records a sanitized operational run without task titles or context contents. Project Manager and Meeting Prep currently return deterministic recommendations and never write data; Morning Planner and Evening Reviewer use the existing briefing engine. Rich results are returned only to the authenticated owner session, while persisted history contains status and bounded operational metadata.

The authenticated AIfréd integration API is now implemented for external conversational clients. It uses a dedicated bearer token and requires one explicit workspace. The planning endpoint can return read-only answers or create approval-bound proposals. A separate read-only tools endpoint exposes only task.read, project.read, note.read, calendar.read, calendar.free_time and context.read; task.propose cannot be invoked through that endpoint. Proposal confirmation is intentionally not exposed to the external integration. A versioned OpenAPI 3.1 schema lives at `docs/aifred-openapi.json`, and the running app serves an origin-aware copy at `/api/integrations/aifred/openapi`. This is the contract for a future ChatGPT/Voice connector; it advertises only planning and allowlisted read operations. Owner-only durable context management is available through `/api/context` and the Settings UI. The owner can list, create and archive context, choose scope and sensitivity, and bind project context only to a project in the same workspace. Sensitive items remain visible to the owner UI/API but are excluded from the external `context.read` tool and provider reasoning by default. Morning and evening briefings now execute as tracked PACT agent runs for both manual and scheduled paths. Run history records only sanitized operational summaries (kind, trigger, status and delivery outcome), not task titles or durable context, and is visible in the owner Agents view. Next: verify the PACT integration in build/CI and complete the Context Graph v2 reliability, provenance, review and export gates below before adding new account adapters. Existing read-only ICS planning remains supported.

### Implementation roadmap

1. Verify and preserve the current PACT foundation: agents, durable context, Context Resolver, Tool Registry, tracked runs and owner-confirmed task actions.
2. Extend the existing SQLite and mutation service with claim/source schemas, revision checks, idempotent commands and transactional context history; prepare a non-destructive migration.
3. Add claim-level review, explicit evidence, conflict handling and guarded multi-step Undo/Redo. Keep task execution state separate from claim review.
4. Add the Context workspace: Markdown editing, search, dynamic graph, relation details, review queue and history in the current PWA.
5. Complete portable export/import, encrypted backup/restore and server-enforced data-boundary checks before connecting new real accounts.
6. Introduce normalized external adapters incrementally: one selected personal calendar first, then approved M365 and selective email. Preserve current ICS planning throughout.
7. Extend the Context Resolver and typed tools for evidence-backed briefings and proposals; then expand controlled proactivity under existing approval policies.

The original PACT milestone remains the integration baseline: an Executive Assistant can read one workspace, receive a minimal resolved context bundle, inspect tasks/projects/calendar through registered tools, produce a structured recommendation and propose changes without direct database access or provider credentials. Context Graph v2 adds the acceptance gates below; they must not be described as already implemented.

### ChatGPT / Voice integration contract

External conversational clients authenticate with `Authorization: Bearer <AI_EXECUTIVE_INTEGRATION_TOKEN>`. Use a dedicated random token of at least 32 characters and never reuse the browser password, session secret, Hermes token or calendar secret. The connector must select one explicit workspace for every call; `all` is rejected.

The OpenAPI contract exposes two operations: `planWithAifred` for reasoning and approval-bound proposals, and `readAifredTool` for the allowlisted read-only Tool Registry. A proposal returned to ChatGPT is only a pending proposal; the owner must confirm it through AI Executive. The integration has no confirmation, Undo, arbitrary database or provider-credential endpoint.

Before connecting an external client in production, deploy the new code, set `AI_EXECUTIVE_INTEGRATION_TOKEN` in the root-managed service environment, restart AI Executive, and verify that the OpenAPI endpoint is reachable only over the intended HTTPS/Tailscale path. Do not expose the local Node listener directly to the public Internet.

## Personal Context Graph v2 — target specification

Specification revision: 2026-10-02. This section is a product and implementation contract, not a declaration of shipped functionality. It incorporates the reviewed Albert context prototype into AI Executive / AIfréd while preserving the application's existing architecture.

### Product and deployment boundaries

- Provide an owner-controlled knowledge workspace with an Obsidian-inspired layout, Markdown notes, backlinks, evidence, a relationship map and a review queue. No Obsidian installation, account, subscription or plugin is required.
- Reuse the existing Next.js application, server-side SQLite, authenticated APIs, Dexie cache and PACT services. Do not add a competing Python server, a second task store or an independent approval mechanism.
- Preserve the installable desktop/mobile PWA and the existing always-on self-hosted Node deployment. A Mac-local installation is an optional deployment profile; a native desktop wrapper is not required to deliver the feature.
- The owner chooses the canonical host. In self-hosted mode, data resides on that host and in explicitly permitted device caches; it is not represented as existing only on the Mac. In a Mac-local profile, remote delivery/scheduled work cannot be promised while the host is off.
- Keep the data contract and core portable across operating systems. There is no mandatory third-party synchronization service, model provider or separate graph database.
- Existing task/project/area/note IDs, workspaces, recurrence, calendar scheduling, notification behavior, tombstones and task-action approval policies remain intact.

### Current foundation versus planned work

| Area | Existing application foundation | Graph v2 requirement |
|---|---|---|
| Canonical storage | server SQLite and local Dexie entity/relation cache | versioned claims, sources, evidence and transactional context history |
| Durable context | PACT context items, scopes, provenance and normal/sensitive classification | independently reviewed claims, validity and source-level evidence |
| Owner context UI | list, create and archive in Settings | edit claims, inspect evidence, review conflicts and navigate a graph |
| Mutations | task proposals, owner confirmation, audit and guarded Undo | reusable revision-safe context commands and durable multi-step Undo/Redo |
| External API | planning and allowlisted read tools | versioned evidence-aware reads/proposals, with no external confirmation or Undo |
| Backups | logical JSON and safety backups | complete context coverage, encrypted backup option and tested round-trip restore |
| Calendar | normalized read-only ICS planning | additional adapters only after the context acceptance gates pass |

The separate Markdown Atlas pilot is migration input, not production infrastructure. Its fixed graph coordinates, entity-wide confirmation, single last-change snapshot, plain ZIP backup and uncalibrated confidence values must not be carried forward as guarantees.

### Entity, claim and evidence model

Reuse canonical task, project, area and note entities by stable ID. Add person, organization, topic, tool, meeting and decision subjects through an explicitly versioned schema or typed subject reference. Do not duplicate a task as a new independently editable commitment: a commitment refers to its canonical task, or remains a proposal until the owner creates one.

A claim records a subject, a typed predicate and exactly one target entity/reference or literal value. A relationship is a claim whose value is another subject. Entity existence, a Markdown mention and claim confirmation are distinct operations.

Required logical records:

| Record | Required information |
|---|---|
| Subject reference | stable ID, subject type, canonical entity ID when applicable, workspace, display title and revision |
| Claim | ID, revision, subject, predicate, typed value or target, review status, freshness, provenance, evidence references, validity interval and recording time |
| Review event | claim/revision, authenticated actor, decision, timestamp and any correction/reason |
| Source | workspace/account, provider, external ID, accessible URL/locator, author/role, source timestamp, ingestion timestamp, content coverage and sensitivity |
| Evidence | source ID, exact message/section locator or bounded excerpt, supported claim and whether it supports or contradicts it |
| Change event | command ID, workspace, actor, object ID, before/after revisions, operation, time and Undo/Redo linkage |

Source IDs, authors, dates and quotes are never fabricated. A missing source remains explicitly missing. A source with metadata-only coverage cannot support claims requiring its unavailable body.

Conversation titles and cached summaries are discovery signals, not biographies. A conversation about a car does not establish ownership; an assistant suggestion does not establish a user commitment. Preserve the distinction between owner statement, source extraction, inference and legacy import. Owner-authored information may be recorded as such without requiring an external citation.

Do not display invented truth probabilities or auto-merge people using an arbitrary confidence threshold. Ambiguous identity matches require review. Conflicting evidence creates a reviewable proposal rather than silently replacing an accepted claim.

### Independent state dimensions

| Dimension | Target semantics |
|---|---|
| Claim review | proposed / confirmed / rejected; confirmation means accepted by the owner |
| Freshness | current / needs_review / stale |
| Canonical task execution | existing task statuses and scheduling semantics; never overwritten by claim review |
| Decision lifecycle | pending / decided / superseded, including the selected outcome |
| PACT scope | existing me / work / family / rules / project / workspace |
| Authorization boundary | one explicit workspace; All my work is read-only aggregation |
| Sensitivity | normal / confidential / restricted in the versioned target schema |

Maintain compatibility with the current normal/sensitive API until a schema migration is deployed. Map normal to normal and sensitive to protected confidential; both confidential and restricted remain excluded from external tools/provider reasoning by default. Preserve stricter imported labels. Unknown mappings fail closed and require review. Changes to public schemas, validators and clients must ship together; documentation alone does not enable new enum values.

Reviewing a claim that a hosting decision is needed must not mark the task done or choose a hosting option. Archived context must not become active during migration. A new claim about a confirmed person still needs its own review.

Track both when a claim was valid and when the system learned it. Unknown dates remain unknown. A time view must distinguish these two meanings.

### Relations and graph semantics

Retain existing canonical relations such as belongs_to_project and belongs_to_area. Add a typed semantic predicate registry with Czech labels, permitted endpoint types, direction and inverse display where useful:

- uses — používá;
- responsible_for — odpovídá za;
- works_for — pracuje pro;
- participates_in — účastní se;
- assigned_to — přiřazeno;
- blocked_by — blokováno;
- arose_from — vzniklo z;
- related_to — souvisí s (symmetric);
- supersedes — nahrazuje.

Disambiguate legacy owns during review instead of equating ownership with responsibility. A suggested next step is not evidence for blocked_by. Keep documentary provenance in evidence records. A wiki link only creates a navigational mention; it must not silently create a confirmed semantic claim.

Every semantic relation has its own evidence, review state, freshness and temporal validity. Confirming a subject must not confirm its incident edges. Preserve the current prohibition on cross-workspace relations; multi-workspace display does not authorize cross-workspace writes or hidden-node disclosure.

### Persistence, automatic saving and history

SQLite on the selected canonical host is the source of truth. Store Markdown note content with revisions there; Markdown exports are portable editing artifacts, not a concurrent second database. Reuse or extend existing persistence and mutation services instead of duplicating them.

Each command includes an idempotency key, object ID, explicit workspace and expected revision. Validate authorization and schema, commit state plus change history in one transaction, and return the authoritative saved object/revision. A failed transaction must leave neither a partial object change nor an orphaned history entry.

- UI saves owner edits automatically after field completion, with visible saving/saved/error state. A redundant Save button is not required.
- AI edits remain proposals requiring the existing owner confirmation. Owner autosave must not bypass that boundary for AI-generated changes.
- Bind each response to the requested object, not the current selection. Handle fast switching, repeated clicks, stale responses and overlapping edits.
- No-op commands do not consume an Undo step. Retry of one command does not duplicate it.
- Extend the existing guarded Undo model with durable, workspace-scoped multi-step Undo/Redo. A reversal is a new compensating transaction; it does not erase history.
- Show what will be undone and its target. Revision conflicts must never overwrite later edits.
- Preserve task proposal expiry and session binding. Context history must not make expired task proposals executable.
- Keep content-bearing owner history protected and separate from sanitized agent-run/security logs.
- Offline edits, where allowed by sensitivity, remain explicitly pending until the canonical server accepts them. They cannot be consumed as confirmed context by agents. Scope or session changes must not leak cached data.
- Update backup, restore, tombstone, schema-version and sync handling alongside the context tables; an old client must not erase unknown new data.

### Owner workspace and interaction design

Use the current app shell. Left: areas, projects, search and navigation. Center: Markdown note, graph or review list. Right: properties, claims, evidence and history. Keep Czech labels, keyboard access and mobile layout.

Review operates on a specific claim or relationship and shows its source and proposed difference. Actions are confirm, correct, reject and defer. Bulk confirmation, if added, shows the exact set being approved.

The active review action has a filled background after successful save. Do not add checkmarks, crosses or question marks to graph bubbles. Confirmation does not change task completion.

Graph requirements:

- automatic layout for arbitrary subjects; zoom, pan, pinning and persistent layout preferences;
- views around a person/project, open commitments, and changes awaiting review;
- filters for workspace, relation type, review/freshness and time, consistent with list/search;
- directed edges with Czech labels and selectable evidence/history;
- orange for proposed, green for confirmed, red for rejected, gray for stale/archived, with explicit text state in the detail;
- an entity with several claims shows a documented summary: pending current claims take precedence over an all-confirmed appearance; no claims means neutral;
- entity type and workspace use text/shape labels instead of competing status colors;
- distinguish a rejected relationship from a rejected subject and a stale claim from a completed task.

A generic entity-level badge must never imply that every personal fact has been verified. Each successful edit offers a concrete result and Undo. Failed saves retain the draft and explain the conflict/error.

### Context Resolver and external integration

Extend the existing resolver in lib/pact.ts and registered capabilities in lib/pact-tools.ts. The browser-side relation navigator is not an authorization authority.

Every resolved bundle must obey workspace, project, agent/tool permissions, sensitivity, review and freshness before serialization. Canonical task state and confirmed eligible claims form the factual basis. If an operation explicitly asks for proposals, conflicts or stale context, return them clearly separated and labeled. Source evidence cannot be read through a claim if the source itself is forbidden.

Add versioned logical operations for context search, claim explanation and proposed context changes through the Tool Registry. Register them explicitly; do not automatically expose them through the external tools allowlist. Update docs/aifred-openapi.json and route schemas only when implementation and authorization tests are complete.

External ChatGPT/Voice and other conversational clients retain their dedicated-token, single-workspace read/propose boundary. They cannot confirm claims, invoke owner Undo/Redo, read arbitrary files or obtain provider credentials. Owner UI mutations require the owner session and existing same-origin protections.

Morning Planner, Evening Reviewer, Project Manager and Meeting Prep should cite eligible evidence, report missing/conflicting context and avoid converting inference into a commitment. Scheduled runs may prepare proposals; they do not self-approve them.

### Security, export and recovery

- Apply authorization server-side to claims, sources, evidence, attachments, history, search, exports and provider bundles. UI filters are not security boundaries.
- Keep database files, raw imports, history snapshots, credentials and backups outside static serving. Preserve production authentication, size/rate limits, origin checks and security headers.
- Render Markdown and labels as untrusted content; no unsanitized HTML or execution of source instructions.
- Treat metadata and derived summaries as potentially sensitive. Derivations inherit source restrictions unless the owner explicitly reviews a downgrade with a recorded reason.
- Keep secrets in existing protected server/OS secret storage, never in context exports or agent bundles. Localhost binding and SQLite do not by themselves provide encryption.
- Support complete versioned exports: manifest, Markdown notes, JSON subjects/claims/relations/sources, JSONL owner history and permitted attachments with checksums. Markdown alone is not a full history/graph backup.
- External Markdown editing requires import against a recorded base revision, diff preview and conflict handling; it must not silently overwrite canonical data.
- Add encrypted consistent backups covering database and attachments, key recovery instructions and a tested restore. Existing logical JSON backups are not described as encrypted.
- Define retention, archive and explicit erasure separately, including derived copies, caches, indexes, content-bearing history and expiry from older backups.
- A private note or source must remain private even if referenced by an otherwise visible subject.

### Migration and acceptance gates

**A — Reliability and canonical integration.** Preserve current data and active features; add schemas and command/history handling. Test interrupted transactions, retries, no-op edits, concurrent revisions, rapid selection changes, rename round-trips and all review statuses. Undo/Redo must survive restart and refuse conflicting reversal.

**B — Provenance and review.** Migrate current pact_context and any separately imported Atlas files using an explicit dry run, backup and ID mapping. Preserve original content, scope, sensitivity, archive/pending state and owner confirmations. Owner-origin legacy entries remain attributable owner statements, but active is not blanket confirmation of newly extracted claims. Preserve Atlas entity-wide confirmation as legacy review rather than inventing claim-by-claim approval, actor or time. Retain uncalibrated confidence only in the migration record. Flag unresolved sources and mappings; repeated import must be idempotent.

**C — Owner experience.** Add the Context view, editor, review queue, automatic graph layout and history. Verify that a new entity renders without code changes; all displayed states are correct; confirming a claim does not finish a task or confirm edges; mobile and keyboard flows work; the UI uses the server's saved values.

**D — Portability and security.** Demonstrate full export/restore with IDs, relations, evidence and history preserved. Test unauthorized writes, cross-workspace reads/links, sensitive-source access, cache/session isolation and static-file exposure. This gate is required before adding new real-account connectors; existing ICS behavior remains supported.

**E — Incremental sources and agent use.** Add one chosen personal calendar, then approved work sources and selective email. Target Gmail through its read-only API, M365 through approved delegated Microsoft Graph access and an Apple/iCloud adapter appropriate to the actual backing account. Apple Calendar may display Google or M365 data, so deduplicate by provider/account/source identity. Validate recurrence, timezone, incremental import and disconnect behavior. Metadata-only ingestion must not invent commitments from unread message bodies. Expand agent briefings only after evidence and review behavior is verified.

Acceptance tests must cover integration with existing tasks, workspaces, offline/sync, scheduler and external API—not only the graph in isolation. No live account connection, deployment migration or runtime behavior change is authorized merely by this specification.

## Persistence and backups

- SQLite lives at `.data/store.sqlite` or `$AI_EXECUTIVE_DATA_DIR/store.sqlite`.
- An existing `.data/store.json` is migrated on first access without changing entity IDs or relations and remains as a recovery copy.
- Logical JSON backups live in `.data/backups`. Settings can create and restore them; restore creates a safety backup first.
- One automatic daily backup is created before the first data change of the day.

These describe current backups. Graph v2's complete context export, encrypted recovery and history coverage are target requirements above, not claims about existing logical JSON backups.

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

Albert's task suggestion endpoint is authenticated, same-origin protected and
workspace-scoped. It compares the new title with project names and earlier
related tasks, estimates effort from explicit duration or task type, and checks
the next 14 configured workdays for a sufficiently long free interval. The
suggestion is advisory: Quick Capture shows every proposed field before save,
allows edits or one-click opt-out, and never blocks task creation when calendar
data or the suggestion service is unavailable. Only the confirmed values are
stored on the task.

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
