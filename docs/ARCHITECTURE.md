# Lumi — technická architektura a provozní kontrakty

> **Závazná technická specifikace** (stav k 14. 10. 2026). [Rozcestník](../README.md) · [Produktové zadání](PRODUCT.md) · [UX/UI](UX-UI.md). Technické interní identifikátory typu `aifred` se nemění pouze kvůli nové produktové značce.

## Architektonický přehled

- **Next.js** tvoří serverové API a aplikaci; **SQLite** je kanonický serverový stav a **Dexie/IndexedDB** lokální cache se synchronizací a konflikty. Webová PWA je instalovatelná na Mac a iPhone.
- **PACT** znamená Projects, Agents, Context a Tools; **Context Resolver** filtruje minimální oprávněný kontext a typovaný **Tool Registry** omezuje akce.
- **Attention Engine** vyhodnocuje stabilní signály a jejich stav; produktová pravidla, meze a deduplikaci definuje [produktový kontrakt](PRODUCT.md#attention-contract--target-requirement).
- **Planning Engine** pracuje s ověřenou čerstvostí kalendáře a nepovažuje neznámé časové bloky za volné.
- **Action Engine** dodržuje `intent → context → allowlisted tool → proposal → approval → execution → audit → guarded Undo`; API a storage vynucují revize, idempotenci a hranice workspace.
- **Privacy-first:** Personal a Shared zůstávají oddělené, `All my work` je jen read-only pohled; citlivé či neověřené claims nejsou automatickým důkazem ani povoleným kontextem pro agenty.
- Stav implementace je důsledně oddělen od **target specification** v níže uvedených oddílech. Při rozporu UI návrhu s oprávněními a integritou dat platí přísnější bezpečnostní kontrakt.

## Mapování dokumentů a implementace

| Oblast | Dokument s produktovým pravidlem | Implementační oblast v tomto dokumentu |
|---|---|---|
| LUMI-FR-001/002 | [PRODUCT.md](PRODUCT.md) | Current MVP; Persistence and backups |
| LUMI-FR-003/009 | [Attention a proaktivita](PRODUCT.md#attention-contract--target-requirement) | Current MVP; Push reminders |
| LUMI-FR-004 | [Plan](PRODUCT.md#product-contract) | Read-only calendar planning |
| LUMI-FR-005/011 | [Trust and action](PRODUCT.md#trust-and-action-contract) | PACT architecture; Security deployment |
| LUMI-FR-006/012 | [Universal chat a hlas](PRODUCT.md#product-contract) | ChatGPT / Voice integration contract |
| LUMI-FR-007/008 | [Remember a search](PRODUCT.md#product-contract) | Personal Context Graph v2 |

## Run

```bash
pnpm install --frozen-lockfile
pnpm dev
```

For production, run one always-on Node.js process (the current deployment uses systemd):

```bash
pnpm build
pnpm exec next start --hostname 127.0.0.1
```



---

## Current MVP

- Responsive desktop and mobile task workspace
- Inbox, Today, Overdue, Upcoming, Anytime, Someday and Completed views
- Projects, areas, notes, relations and relation-aware search/context
- Persistent Personal and Shared workspaces, scoped views, and an All my work aggregate
- Task dates, deadlines, priority, notes, checklist, recurrence and history
- Quick Capture with Czech today/tomorrow/date parsing, priority tokens and a reviewable Lumi suggestion for project, area, priority, effort and the first suitable free calendar block
- Manual Context Inbox for pasted meeting, email or Copilot summaries. It creates an in-memory preview, matches existing workspace entities, and may suggest a person waiting for a result. The owner selects an existing person or explicitly creates one, then separately saves the relationship as a protected reviewable claim. Ambiguous lines remain literal proposals. Action items remain editable drafts until reviewed in Quick Capture.
- First-class people and organizations in the Context workspace, with workspace-scoped names, duplicate warnings, revision-safe rename/archive, change history and searchable relationships to tasks and projects. Each relationship remains an independently reviewed claim; archiving a person or organization removes its claims from AI eligibility without deleting history.
- SQLite server source of truth with local IndexedDB cache and conflict-aware sync
- When the session ends on the server (it lasts seven days) the app returns to the sign-in screen and says so, instead of looking offline. The local copy and unsent changes are kept and sent after signing in again; only an explicit sign-out clears them.
- Signing out clears the browser's local copy (IndexedDB data, unsent-change markers, remembered workspace) and reloads; other open tabs follow. Unsent changes are synchronized first; if that fails the user chooses whether to discard them. Without a reachable server sign-out is refused and nothing is removed, because the session cookie cannot be cleared offline. A wipe that cannot finish is completed on the next start. The local placeholder for the Personal workspace carries timestamp 0 so it never wins a merge against the server copy. Push subscriptions and device preferences (theme, language, start view) are kept.
- Daily/manual/safety backups (full database copies; older JSON backups stay restorable) and tombstones for deletion sync
- Installable PWA with an offline shell. Started without a connection, a browser that has synchronized before and was not signed out shows the data it holds, marked as offline, instead of only the access screen (owner decision 2026-10-09); changes made meanwhile wait on the device. Access is checked again in the background (on connection, focus and every 15 seconds); if the server then says the session has ended, the sign-in screen replaces the app and the waiting changes are sent after signing in. A browser without such data stays on the access screen.
- The address carries the open view (`/?view=Today`; the start view has the plain address), so Back, Forward and reload keep the place. It never carries a workspace, a search text or a record id; the `?task=` id from a notification link is removed from the address once the task is open, or once a completed synchronization shows the task does not exist.
- Web Push reminders delivered by a server scheduler while the PWA is closed
- Attention notifications: one Web Push when a task deadline comes within 48 hours and one when it passes, evaluated by the server every five minutes with the same rules as Home. Tasks only, never projects. Each item is announced once; snoozed and dismissed items stay silent; nothing is sent between 22:00 and 08:00 local time (held until morning) and at most three are sent per rolling 24 hours. The first pass after enabling records what is already on Home as known instead of announcing a backlog. The message shows a short task title and the reason, including on the lock screen (owner decision 2026-10-07), and opens the task. It needs the reminders switch on and a subscribed device; the message text is Czech. Delivery is at most once per item: with no subscribed device the item is recorded as not delivered and is not sent later; delivery is tracked per subscribed device, so a device whose send failed is retried on later passes (three attempts, never at night) without notifying the devices that already received the message, and a device whose subscription has expired is dropped; a pass interrupted by a restart is not resent. An item that was snoozed is announced when the snooze ends if it had not been announced before. Items held by the daily limit are sent later while their condition lasts. Quiet hours and the daily limit are fixed values for now; the urgent exception, per-rule settings, pause, in-app delivery state and push for waiting follow-ups (shown on Home only) and calendar rules from the target contract are not implemented.
- OS-level urgent-task badges for installed iOS/iPadOS Home Screen and macOS Dock web apps
- Server-verified on-demand priorities in chat and an approval-based task action loop with audit and Undo
- Home now uses a server-evaluated Attention foundation for overdue and soon deadlines, waiting follow-ups, tasks whose planned day has passed, projects without a next action, and idle projects. The last evaluation of each workspace is kept in the browser (owner decision 2026-10-09): until the server has evaluated again, Home shows it marked as a saved copy (or as out of date when the server cannot evaluate), at most 50 items per workspace, with snooze and dismiss disabled; it is also shown, marked as offline, when the app starts without a connection; signing out removes it with the rest of the local copy. A waiting follow-up comes from an explicit waiting task (marked in the task detail with who or what it waits for and an optional follow-up date): it leaves the Inbox (owner decision 2026-10-09), is left out of the day plan, does not carry over to the next occurrence of a repeating task, and returns at the start of the follow-up date in the user's time zone, or 7 days after it was marked when there is no date; waiting-on relationships from reviewed claims are not used yet. Candidates have stable identities, deterministic ordering, explicit reasons, source revisions and evaluation freshness. The five highest-ranked items are shown first; snooze and dismiss are stored in SQLite with content-free lifecycle history, expire or resurface when the underlying condition changes, and are shared across devices. Calendar conflicts and capacity risk remain planned rules and are disclosed as unavailable rather than inferred.
- Lumi's day plan previews ranked tasks in a mobile-friendly timeline and explains why each item matters now. Ranking can use confirmed, current, non-sensitive task/project importance and waiting-party claims in addition to deadlines, priority, calendar availability and measured duration. Exact blocks require a fresh connected calendar and avoid existing planned tasks. Accepting a block uses a server-side, single-task proposal with a current-revision and overlap check, audit history and Undo; it does not change the task's due date. When the calendar is missing or stale, the plan lists tasks without claiming exact free times. Decisions and manual time changes are recorded as task planning feedback.
- Read-only private ICS calendars with normalized recurring events, busy-time merging and free-window planning
- Deterministic threat detection with Web Push fallback and a least-privilege Hermes Telegram outbox

## PACT architecture

AI Executive uses PACT (Projects, Agents, Context, Tools) as the target operating model for the Personal AI OS. PACT is an architectural layer over the existing local-first task model, not a replacement for it.

### P — Projects

Existing Areas, Projects, Tasks, Notes and Relations form the P layer and retain their IDs, workspace boundaries, recurrence, history and offline/sync behavior. Projects can reference project-scoped context, preferred agents and allowed tools. All my work remains an aggregate read view, never a write target.

### A — Agents

Agents are reusable, versioned definitions of repeatable AI work, not unrestricted chatbots. Each agent declares its purpose/instructions, permitted context scopes, tool capabilities, workspace/project scope, trigger mode, output contract and mutation/approval policy.

Initial built-ins: Executive Assistant, Inbox Processor, Project Manager, Researcher and Meeting Prep. Deterministic ranking remains a safe fallback and validation layer.

Agents never receive provider credentials or bypass authorization. Model-proposed actions always pass through the Tool Registry and policy layer.

### C — Context

Context is a first-class structured layer over the existing canonical entities, tasks and notes. The next specification is [Personal Context Graph v2](#personal-context-graph-v2--target-specification): evidence-backed claims and typed relations, claim-level review, durable revision history and an Obsidian-inspired owner workspace.

Supported PACT scopes remain me, work, family, rules, project and workspace. Scope is not a substitute for workspace authorization or sensitivity. Owner statements, imported evidence and AI inferences remain distinguishable; confirmation applies to an individual claim and never implicitly completes a task or verifies every fact about a person.

The Context Resolver builds the minimum permitted bundle for each agent run from the canonical SQLite state. It enforces workspace/project, agent/tool, sensitivity, review status and freshness before returning data. Sensitive context cannot silently cross workspace boundaries or reach external providers. Graph v2 is a planned extension of this resolver and the existing proposal -> approval -> audit -> Undo boundary, not a second assistant or an independent source of truth.

### T — Tools

Agent capabilities are exposed through a typed Tool Registry rather than direct database/provider access. Initial tools include task read/propose-create/propose-update/propose-complete, project read/search, note read/search, calendar read/find-free-time and context read.

Future adapters can add email search/draft, calendar writes, Microsoft Graph, files, web research and other services without changing agent definitions. Every tool declares input/output schemas, read/write classification, scope, audit behavior and approval policy.

### Executive Orchestrator

For each run the orchestrator resolves workspace/project, loads the agent, resolves minimum context, exposes only allowlisted tools, runs deterministic and/or model reasoning, validates structured output, executes permitted reads and converts mutations into proposals. Confirmation, audit and guarded Undo remain server-controlled.

The model is never the authority for access control or writes.

### Permission model

- READ: automatic only inside explicitly allowed scopes.
- PROPOSE: AI may prepare a mutation but cannot apply it.
- WRITE: a validated proposal is applied only after required approval.
- SEND / EXTERNAL SIDE EFFECT: explicit approval by default plus a dedicated tool policy.

Scheduled/proactive agents may perform read-only analysis automatically and create proposals. Autonomous external side effects require a separately configured policy.

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

A run can combine an Executive Assistant with active projects/tasks, relevant personal/work/project context and read-only calendar tools. It identifies risks, capacity and next actions, then proposes changes instead of silently mutating the plan.

### PACT implementation status

The server-side PACT foundation is now in place: SQLite persistence for agents, durable context, tool permissions and agent runs; a default Lumi agent (with the stable internal ID `aifred`); a workspace-scoped Context Resolver; and a typed read-only Tool Registry. Provider-assisted reasoning now receives canonical entities and non-sensitive durable context through the resolver. Mutations continue to use the existing proposal -> confirmation -> audit -> Undo boundary.

The owner UI now exposes a dedicated Agents view with Project Manager and Meeting Prep. Each manual run requires one explicit workspace, uses only the agent's declared tools and context scopes, and records a sanitized operational run without task titles or context contents. Project Manager and Meeting Prep currently return deterministic recommendations and never write data. The former Morning Planner and Evening Reviewer agents and their scheduled briefings were removed on 2026-10-07; their past runs remain in the sanitized history. Rich results are returned only to the authenticated owner session, while persisted history contains status and bounded operational metadata.

The authenticated Lumi integration API is implemented for external conversational clients. It uses a dedicated bearer token and requires one explicit workspace. The planning endpoint can return read-only answers or create approval-bound proposals. A separate read-only tools endpoint exposes only task.read, project.read, note.read, calendar.read, calendar.free_time and context.read; task.propose cannot be invoked through that endpoint. Proposal confirmation is intentionally not exposed to the external integration. Its versioned OpenAPI 3.1 schema remains at the compatibility path `docs/aifred-openapi.json`, and the running app serves it at `/api/integrations/aifred/openapi`. This is the contract for a future ChatGPT/Voice connector; it advertises only planning and allowlisted read operations. Owner-only durable context management is available through `/api/context` and the Settings UI. The owner can list, create and archive context, choose scope and sensitivity, and bind project context only to a project in the same workspace. Sensitive items remain visible to the owner UI/API but are excluded from the external `context.read` tool and provider reasoning by default. Run history records only sanitized operational summaries (kind, trigger and status), not task titles or durable context, and is visible in the owner Agents view. Next: verify the PACT integration in build/CI and complete the Context Graph v2 reliability, provenance, review and export gates below before adding new account adapters. Existing read-only ICS planning remains supported.

The first Context Graph v2 foundation is additive to `pact_context`: owner-authored, workspace-bound claims have stable revisions, independent review/freshness/sensitivity state, non-fabricated sources and evidence as separate records, idempotent transaction commands and content-bearing owner history. The Context view supports create, edit, claim-level review and archive. The resolver adds only confirmed, current, normal and non-archived claims while retaining eligible legacy PACT context. Claim sensitivity has three levels: normal, confidential and restricted. Only normal claims reach agents, the day plan, attention rules or AI providers; the two-level `sensitive` of earlier clients is still accepted by the API and stored as `confidential`, an existing `sensitive` claim was converted to `confidential` by a registered migration, and a stored value nobody recognises is read as restricted and needs review. The Context Inbox saves proposals as confidential. Legacy `pact_context` keeps its own normal/sensitive classification. Claims and standalone people/organizations share one command service: each command carries an idempotency key, object id, explicit workspace and expected revision, and the change, its history and the stored result commit in one transaction (an exact retry returns the stored result, a changed request under the same key is a 409, a no-op writes no history, a stale revision writes nothing, and a failure part-way leaves no object change, history entry or command record). A claim can move between proposed, confirmed and rejected in any direction, each move recorded as a review event, and an edit returns it to proposed. The Context view keeps one idempotency key per user intent until it succeeds or the draft changes, applies each response only to the object it was sent for, and keeps the draft when a save fails. Claims and standalone people/organizations in one workspace have durable multi-step Undo/Redo. Change events carry a per-database sequence, the object type, a kind (change, undo or redo) and the event a reversal reverses, added by a registered migration that backfills existing events without rewriting their content; the Undo and Redo stacks are derived from that table, so they are identical after a restart. An Undo or Redo is an idempotent command that appends a compensating revision and a new change event (history only grows; a reversed review also writes a review event); it is refused with `history_changed` when the step on top is no longer the one the client saw, with `undo_conflict` when the object was changed after that step, and when the restored state would break an invariant (a name another active person or organization already has, an archived or missing related subject), in each case without writing anything. A new ordinary change empties the Redo stack; no-op commands and retries add no step. The Context view shows the next Undo and Redo step with its target (Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z work outside text fields), and each saved edit offers the same Undo. The route `/api/context/history` accepts only the signed-in owner session; the external integration API has no Undo or Redo. Tasks keep their own existing approval-bound Undo. Sources and evidence are records. `context_sources` holds where information came from (provider, account, external id, locator, author/role, source and ingestion time, coverage `metadata`/`excerpt`/`body` and sensitivity) and is unique per external item within a workspace, provider and account (creating a source for an item that exists returns the existing one, raised to a stricter requested sensitivity, and a new source must state its coverage); `context_evidence` links one claim to one source with an optional excerpt of at most 500 characters, a location in the source and a stance (supports or contradicts). Both are workspace-scoped, change only through the same idempotent context commands (change events of object type `source` and `evidence`) and take part in Undo/Redo; a step that can no longer be done can be skipped only after the expected conflict, without changing data. The server never fills in an author, date, external id or quote. Evidence with an excerpt or location needs a source with `excerpt` or `body` coverage; evidence on a metadata-only source only references it and is marked metadata-only, and a claim reports its coverage as missing, metadata-only or documented content. Any evidence change returns the claim to review. Lowering a source's sensitivity needs a non-empty reason, kept in its change event; that and any other edit of what the evidence rests on (coverage, location, author, external id, provider, account, dates) returns every active claim citing the source to review (every citing claim gets a new revision, whatever its review state, so a stale confirm is refused), so agents see its evidence again only after the claims are confirmed again; raising the sensitivity needs no reason. The source/evidence JSON previously stored on claims was converted into records by a registered migration (nothing missing is invented, sensitivity is never weakened, a source shared by several claims keeps the strictest sensitivity and the strongest coverage) and a repair at every start converts claims written later by an older binary (merging into an existing source of the same external item; JSON with an excerpt or location never yields a metadata-only source). Every command marks the claims it writes with `legacy_synced_revision`; an older binary bumps the revision without it, so at every start a claim whose revision differs from that mark and whose JSON source/evidence no longer reads like its records is rebuilt from the JSON in one command (its active evidence is archived, the source is resolved by its external item, coverage is raised to what the evidence needs and lowered only on a source no other claim cites, absent coverage meaning unknown), returns to review with a new revision, and is recorded as a system change event (`claim.legacy_reconcile`) that Undo can reverse; the identity is claim, revision and JSON, so a cycle of edits is never replayed and one start never repairs a claim twice. The JSON is still accepted and kept for older code. This start-up repair is best effort for an accidental short run of an older binary; downgrading below the release that introduced source and evidence records is not supported, and a rollback past it means restoring the database backup made before that deployment. Only evidence from `normal` sources can reach agents, external tools or AI providers; a single serializer strips everything else. Relationship claims (claims with a target) use a predicate from a static, versioned relation registry with Czech and English labels, inverse labels, direction and permitted subject and target types: uses, responsible_for, works_for, participates_in, assigned_to, blocked_by, arose_from, related_to (symmetric), supersedes, and `waiting_for`, which earlier data and the waiting attention rule already use. Other pairs are refused (`invalid_relation`); `supersedes` links only tasks, projects, notes and areas of the same type; an active relationship is unique per subject, predicate and target (`duplicate_relation`; `related_to` also in reverse), and Undo/Redo never recreates a duplicate; literal claims keep free predicates. Existing relationship claims outside the registry are not rewritten: they read as needing review, are never eligible for AI, cannot be confirmed (`relation_needs_fix`) and are fixed by editing them to a registered predicate. No mention or link creates a relation. This slice does not migrate legacy context, expose context mutations to external Lumi tools, implement graph/import/export, or satisfy the full Graph v2 acceptance gates. Full backups (format 2, see Persistence and backups) now include the Context tables, their history and the note versions; older JSON backups still cover canonical entities and relations only.

C1d note history: a note's text (Markdown in `content`) stays in the ordinary entity sync, so it works offline and across devices. The server additionally records a revision in `note_revisions` whenever a saved change alters a note's title or content, inside the same transaction that stores the change (`replaceSnapshot`, and the restore of an older JSON backup with origin `backup_restore`). A new note gets revision 1 (`created`), a changed title or text the next number (`edited`), and the registered migration `2026-10-note-revisions` gave every existing note a `baseline` revision 1. A change of anything else (properties, status, project link, `updatedAt`) or an identical text writes nothing, and a conflict, a refused write or a failure part-way leaves no revision. Restoring an old version is an ordinary new edit, so history only grows; deleting a note (or a note that is gone after a backup restore) deletes its revisions, and a mistaken deletion is recovered from the daily backup. At most 20 revisions are kept per note: beyond that the oldest are pruned (never the newest) and revision numbers are never reused, so the oldest kept version may be higher than 1. Revisions are read only through `/api/notes/revisions` (list: version, time, origin, title, text length and `sameAsRevision`, the newest kept earlier version with identical text (the title is not compared), without content; one version with `revision=N`), which accepts only the signed-in owner session, never the integration token, writes security events without note text and answers 404 for an unknown or deleted note. Revisions never reach agents, PACT tools, AI providers, attention, the day plan, security logs or the client snapshot. The note detail edits the body as text with a local draft kept on every key press (saved on leaving the field through the normal save path) and previews it as untrusted Markdown: raw HTML is dropped, images are not loaded (their alt text is shown), only `http:`, `https:` and `mailto:` links are links and they open with `rel="noopener noreferrer"`. The version history is shown only online, compares a version with the current text by line and restores a version as a new edit. A deleted note that is later revived starts its history again at version 1. AI proposal paths (`lib/ai-actions.ts`) do not target notes today and therefore record no note revisions; if they ever do, they must go through the same transactional recording. Unsaved note text never overwrites newer text from another device: when the text the draft started from is no longer the note's text, nothing is saved, the draft stays in the field and on the device (also a draft left behind by a crashed page, which is adopted by the open page instead of being deleted) and the note shows a conflict in which the owner chooses between using the draft (the other text stays in the version history) and discarding it; restoring a version is disabled while the note has an unsaved draft. Full backups and exports include the note revisions and a restore returns them to the backup's state; an older JSON backup does not (restoring one records a `backup_restore` revision for the notes it changes).

### Implementation roadmap

1. Verify and preserve the current PACT foundation: agents, durable context, Context Resolver, Tool Registry, tracked runs and owner-confirmed task actions.
2. Extend the existing SQLite and mutation service with claim/source schemas, revision checks, idempotent commands and transactional context history; prepare a non-destructive migration.
3. Add claim-level review, explicit evidence, conflict handling and guarded multi-step Undo/Redo. Keep task execution state separate from claim review.
4. Add the Context workspace: Markdown editing, search, dynamic graph, relation details, review queue and history in the current PWA.
5. Complete portable export/import, encrypted backup/restore and server-enforced data-boundary checks before connecting new real accounts. (Done: full backups, export/import and the data-boundary checks, slice D1. Open: encrypted backups.)
6. Introduce normalized external adapters incrementally: one selected personal calendar first, then approved M365 and selective email. Preserve current ICS planning throughout.
7. Extend the Context Resolver and typed tools for evidence-backed recommendations and proposals; then expand controlled proactivity under existing approval policies.

The original PACT milestone remains the integration baseline: an Executive Assistant can read one workspace, receive a minimal resolved context bundle, inspect tasks/projects/calendar through registered tools, produce a structured recommendation and propose changes without direct database access or provider credentials. Context Graph v2 adds the acceptance gates below; they must not be described as already implemented.

### ChatGPT / Voice integration contract

External conversational clients authenticate with `Authorization: Bearer <AI_EXECUTIVE_INTEGRATION_TOKEN>`. Use a dedicated random token of at least 32 characters and never reuse the browser password, session secret, Hermes token or calendar secret. The connector must select one explicit workspace for every call; `all` is rejected.

The OpenAPI contract exposes two operations: `planWithAifred` for reasoning and approval-bound proposals, and `readAifredTool` for the allowlisted read-only Tool Registry. A proposal returned to ChatGPT is only a pending proposal; the owner must confirm it through Lumi. The integration has no confirmation, Undo, arbitrary database or provider-credential endpoint.

Before connecting an external client in production, deploy the new code, set `AI_EXECUTIVE_INTEGRATION_TOKEN` in the root-managed service environment, restart AI Executive, and verify that the OpenAPI endpoint is reachable only over the intended HTTPS/Tailscale path. Do not expose the local Node listener directly to the public Internet.

## Personal Context Graph v2 — target specification

Specification revision: 2026-10-02. This section is a product and implementation contract, not a declaration of shipped functionality. It incorporates the reviewed Lumi context prototype into the AI Executive technical foundation while preserving the application's existing architecture.

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
| Backups | full SQLite-copy backups with Context, history and note versions, restore, export/import package; older JSON backups stay restorable | encrypted backup option |
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
- supersedes — nahrazuje;
- waiting_for — čeká na (the target is a person or organization; used by the Context Inbox, the waiting attention rule and the day plan).

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

Project Manager and Meeting Prep should cite eligible evidence, report missing/conflicting context and avoid converting inference into a commitment. Scheduled runs may prepare proposals; they do not self-approve them.

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

Gate D status (slice D1). Demonstrated by automated tests: a full backup and an exported package restore every included table with IDs preserved (including Context claims, sources, evidence, the Undo/Redo history and note versions); a restore is one transaction after a safety backup and an interrupted or refused one changes nothing; a package that was changed, incomplete, from a newer version or malicious (path names, entry counts, inflated sizes) is refused; every API handler (listed from the file system) refuses a request without a session unless documented as public, refuses a write from another origin, and the backup, export and import endpoints refuse the integration token; backup, export and data files are not served as static files. Not demonstrated or still open: encrypted backups (needs a key-management decision), the cross-workspace read/link tests of the other Graph v2 gates and sensitive-source access beyond the existing leak tests, which remain as they were, and a restore of a production database (not run here).

**E — Incremental sources and agent use.** Add one chosen personal calendar, then approved work sources and selective email. Target Gmail through its read-only API, M365 through approved delegated Microsoft Graph access and an Apple/iCloud adapter appropriate to the actual backing account. Apple Calendar may display Google or M365 data, so deduplicate by provider/account/source identity. Validate recurrence, timezone, incremental import and disconnect behavior. Metadata-only ingestion must not invent commitments from unread message bodies. Expand agent briefings only after evidence and review behavior is verified.

Acceptance tests must cover integration with existing tasks, workspaces, offline/sync, scheduler and external API—not only the graph in isolation. No live account connection, deployment migration or runtime behavior change is authorized merely by this specification.

## Persistence and backups

- SQLite lives at `.data/store.sqlite` or `$AI_EXECUTIVE_DATA_DIR/store.sqlite`.
- An existing `.data/store.json` is migrated on first access without changing entity IDs or relations and remains as a recovery copy.
- Named schema/data migrations are recorded in the `schema_migrations` table and each runs once, inside a transaction, when the database is opened (additive and safe on an existing database). Context writes do not change the task-sync revision.
- Full backups (format 2) live in `.data/backups` (0700; files 0600) as `<time>-<label>.sqlite`, a consistent SQLite copy made with `VACUUM INTO` while the app keeps running, with a sidecar `<time>-<label>.meta.json` (format version, time, label, applied migration ids, row counts per included table, size and SHA-256 of the copy). The copy is cleaned before it is published: the rows of the excluded tables are deleted and the file is vacuumed, so passkeys, push endpoints, security logs and the keys kept in `metadata` are not in a backup or an export (only `schema_migrations` stays, to bring an older copy to the current schema; `metadata` keeps only the store revision and its time). Settings creates, lists and restores them. The table scope is one list in `lib/backup-scope.ts` and a unit test fails when a table of the schema is in neither list, so a new table has to be classified.
  - Included (owner data): `entities`, `relations`, `tombstones`, `pact_context`, `pact_agents`, `pact_tool_permissions`, `pact_agent_runs`, `context_subjects`, `context_claims`, `context_review_events`, `context_change_events` (the durable Undo/Redo history), `context_sources`, `context_evidence`, `note_revisions`, `work_sessions`, `work_session_intervals`, `work_session_events`, `attention_states`, `attention_history`, `calendar_sources` (the address of a calendar subscription, which may contain a secret token, is stored encrypted with a key derived from `AI_EXECUTIVE_CALENDAR_SECRET` or the session secret; the backup and the export hold the ciphertext, so a restore on a server with another secret keeps the rows but cannot read the address) and `ai_action_history`.
  - Excluded and kept as they are on restore: `passkey_credentials`, `passkey_challenges`, `push_subscriptions`, `notification_deliveries`, `security_events`, `security_alerts`, `schema_migrations`, `metadata` (except the store revision) and `calendar_events` (a cache that is fetched again).
  - Excluded and emptied on restore, because they refer to results or sessions from before it: `context_commands`, `work_session_commands`, `ai_proposals`.
- A restore of a full backup: the name and sidecar are checked and the SHA-256 is verified; the backup is copied (the backup file is never modified) and brought to the current schema by the same table setup and registered migrations as the live database, without its start-up side effects (such as the legacy `store.json` import); a copy that names a migration this build does not know (made by a newer version) is refused with nothing changed; a safety backup `before-restore` of the current state is made; then one `BEGIN IMMEDIATE` transaction on the live database with the copy attached replaces every included table (explicit column lists), empties the cleared tables and treats entities, relations and tombstones as the restore of a JSON backup always did (current records the backup lacks get tombstones, tombstones of restored ids are dropped, the store revision moves to the current one plus one, so clients pull and do not write their copies back). An error rolls the transaction back and leaves the live data as it was. Everything in scope returns to the state of the backup, including Context with its Undo/Redo steps and the note versions (no `backup_restore` revision is added); what was created after the backup survives only in the safety backup. The client, after a restore, drops notes being typed, pulls the snapshot and reloads Context, its history, sources, work sessions and the open note's versions. A restore records a security event without content.
- Retention counts `.json` and `.sqlite` backups together per class (daily 30, manual 20, safety 20, other 10) and deletes a backup's sidecar with it. One automatic daily backup (format 2) is created before the first data change of the day.
- Older logical JSON backups (`<time>-<label>.json`: entities, relations, tombstones, revision) stay in the folder, are listed as "Starší záloha — jen úkoly, projekty a poznámky" and restore as before: entities and relations only, Context and note versions untouched, a `backup_restore` revision for the notes that change. Their confirmation says Context is not changed.
- Export: `GET /api/backups/export` (owner session only; the integration token and a request from another origin are refused; rate limited; `Cache-Control: no-store`; `Content-Disposition: attachment`) streams a ZIP built from a fresh backup copy that is deleted afterwards and never stored. It holds `manifest.json` (format `lumi-export`, version 1, time, migration ids, row counts, size and SHA-256 of every other file), `database.sqlite` (the full backup copy, the only part an import reads), `notes/<id>.md` (each note as Markdown with a small front matter; a reading copy), `data/<table>.json` for every included table (rows as stored, JSON columns stay strings; a reading copy) and `history/context-changes.jsonl` and `history/note-revisions.jsonl`. It contains all workspaces of the instance; there is one owner, so that is the owner's data only, and it is given only to the owner's session. A security event without content is recorded.
- Import: `POST /api/backups/import` (owner session, same origin, rate limited, body up to 200 MB) writes the ZIP to a temporary file, never into the backups folder, reads it in pieces and checks it completely before anything changes: names with `..`, absolute or backslash paths, more than 20 000 entries, an entry above 64 MB (the database above 1 GiB) or a total above 2 GiB while inflating (not only as declared), a missing or extra file compared with the manifest, a different format or version, and any size or SHA-256 mismatch refuse the package with a reason. It then restores `database.sqlite` through the same pipeline as a backup restore (schema check, safety backup, one transaction), with original IDs and no merging.
- Encrypted backups are not implemented; backups and exports are plain files, so they need the same protection as the live database.
- `AI_EXECUTIVE_DATA_DIR`, when set, must be an absolute path (a relative value would depend on the working directory, so it is rejected: the process stays up, but `next build` fails and every request that touches the store answers 500). After the move to a dedicated service account, production uses `/var/lib/ai-executive`.
- `pnpm check-data <path to store.sqlite>` opens a database (or a copied backup) read-only and prints only integrity results, row counts per table, and size/SHA-256 of the file (plus WAL size); it never prints content, exits 1 when the file has no tables, and should be run as the account that owns the data (opening creates `-wal`/`-shm`).

These describe what is implemented and tested. Encrypted backups and key recovery remain target requirements above; attachments do not exist yet and are not part of an export.

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

The hardened unit template at `deployment/ai-executive.service` intentionally uses a dedicated `ai-executive` account, owner-only state directory, loopback binding, an external root-managed environment file, no Linux capabilities, and systemd filesystem/device isolation. Migrate the existing data and service only during a planned maintenance window; do not install the template over the current shared `hermesadmin` service without moving `.data` and `.env` first. The step-by-step migration, verification and rollback procedure is in [docs/PRECHOD-SYSTEMOVY-UCET.md](PRECHOD-SYSTEMOVY-UCET.md); `deployment/rehearsal/rehearse.sh` rehearses its file-system part in a disposable environment.

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

The deterministic local planner provides current priorities on request, task creation,
rescheduling/snoozing, completion, priority changes and project moves without
an external model. Every mutation remains a proposal with confirmation and
guarded Undo. For broader read-only answers, set
`AI_PROVIDER=hermes`, `HERMES_AI_ENABLED=true`, `HERMES_BRIDGE_URL` and
`HERMES_BRIDGE_TOKEN`, or configure `OPENAI_API_KEY` and `OPENAI_MODEL`.
Provider secrets remain server-side. The current Hermes bridge invokes the
Hermes agent CLI, so enable it only with a dedicated read-only profile; provider
output never bypasses the application's proposal/confirmation boundary.

## Removed: scheduled briefings

Scheduled morning briefs and evening reviews, their push and Telegram delivery
and the related settings were removed on 2026-10-07 by owner decision. Home is
the brief of the current state, and chat answers "what matters today" on request
from canonical data without storing or sending anything.

Existing databases keep the `executive_briefings` table and old rows untouched;
new databases no longer create it. A server that installed the Telegram adapter
should retire it during the next maintenance window:

```bash
sudo systemctl disable --now ai-executive-briefings.timer ai-executive-briefings.service
sudo rm /etc/systemd/system/ai-executive-briefings.service /etc/systemd/system/ai-executive-briefings.timer
sudo rm /etc/systemd/system/ai-executive.service.d/30-executive-briefings.conf
sudo systemctl daemon-reload
sudo systemctl restart ai-executive
```

`AI_EXECUTIVE_BRIEFING_OUTBOX_DIR` is no longer read. The adapter's script in
`/usr/local/lib/ai-executive-briefings` and its queue in
`/var/lib/ai-executive-briefings` can be deleted once any undelivered files
there have been reviewed. The server security monitor watches the service
drop-in directory, so removing the drop-in raises one expected integrity alert.

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

Calendar events remain read-only. The Calendar view merges overlapping busy
intervals and shows actual free blocks inside the configured workday; Home shows
today's fixed events and the resulting free capacity. A failed
or older-than-24-hours source is marked stale, and on-demand priorities will not
claim a free slot from stale data. The current horizon is 14 days back and 90
days forward; sources refresh at most every 30 minutes in the single always-on
Node process. Microsoft Graph can later implement the same normalized adapter
without changing the planning model.

Lumi's task suggestion endpoint is authenticated, same-origin protected and
workspace-scoped. It compares the new title with project names and earlier
related tasks, estimates effort from explicit duration or task type, and checks
the next 14 configured workdays for up to three sufficiently long free intervals. The
suggestion is advisory: Quick Capture shows every proposed field before save,
allows edits or one-click opt-out, and never blocks task creation when calendar
data or the suggestion service is unavailable. Only the confirmed values are
stored on the task; those final project and area relations become historical
evidence for future suggestions, including when the owner corrected Lumi.

The application badge counts all open tasks whose scheduled date or deadline
is overdue, today or tomorrow. Foreground sync updates it through the Badging
API and every visible Web Push carries the current canonical count for the
service worker to apply while the installed app is closed. The count is cleared
at zero. iOS requires a Home Screen installation, HTTPS, notification permission
and the system Badges toggle; macOS requires an installed web app (for Safari,
Add to Dock). The Install app settings card reports installation, permission,
Badging API support and the canonical count, and provides a one-item badge test
plus a control to restore the real count. Browsers without the Badging API
continue without an in-app badge.

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
