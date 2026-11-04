# R2d.3i.1 — staging-only task dueOn command

**Scope:** server-side, internal and staging-only date-only dueOn mutation.
No HTTP endpoint, no UI, no production store writes, no timezone/time-of-day
or user-private today/when planning field. The existing v20 task due_on
column is used unchanged; **no schema version bump or store migration**.

## Command

A trusted caller obtains a revocable **writable** token from
TargetStagingSessionAuthority.issueWritable(actor) and invokes
changeTemporalDueOn(token, command, optionalDurableSessionTokenHash).

The command accepts exactly six fields:

- commandId: UUID, reused unchanged for retries
- taskId: existing task identifier
- dueOn: strict Gregorian YYYY-MM-DD calendar date, or null to clear
- expectedRevision: task + effective Area policy SHA-256 CAS
- writeAreaId: explicitly named effective Area
- restoreGeneration: isolated staging restore UUID

Dates reject invalid leap days, rollovers, timestamps, timezones, locale
formatting and year 0000. No actor, project, title, status, assignee,
completed timestamp, today or when field is accepted.

## Atomic authorization and audit

The writer uses a canonical pinned staging source with SQLite
BEGIN IMMEDIATE. It obtains the actor from the server-minted credential,
checks a supplied durable staging session in the same DB transaction,
validates restore generation, current write ACL (private owner or shared
editor/admin), specified Area and optimistic task+Area CAS.
Receipt lookup happens **after** all current ACL checks. Shared viewers,
foreign owners and removed members cannot write or inspect a past replay.

An identical replay is acknowledged without mutation; UUID reuse with a
different date/Area/revision/generation is rejected. A fresh command
for a task already at the requested date returns unchanged with **no**
receipt. Every successful mutation atomically updates only tasks.due_on,
advances task and Area revisions and change-feed triggers, creates a
SHA-256-only actor/task/UUID receipt in the metadata namespace
r2:task-temporal-due-on-receipt-v1: with its own 4096-entry cap,
and commits a temporal_due_on intent to the antirollback journal.
The journal includes only receipt hash, numeric revision and set/clear
indicator: it excludes the date, task ID, actor and credentials.
Errors roll back the transaction.

The canonical preflight accepts only this exact receipt prefix
with 64-hex key suffix, SHA-256 value and independent bounded count.
Unknown or malformed metadata still fails closed; journal verifier
accepts the new content-free kind.

## Tests and next work

tests/target-task-temporal-due-on-writer.test.mjs covers strict
Gregorian dates, set/clear with unchanged completion state, revision
and change-feed movement, journal and preflight, idempotent replays,
UUID conflicts, stale/no-op CAS, shared project Area inheritance,
viewers/revocation, explicit Area/generation mismatch and durable-session
revocation. It runs in the focused R2d workflow and full PR checks.

**Next iteration:** a separately gated, default-off HTTP preview,
PATCH and read-only receipt adapter with exact task/parent/Area
release guards, following R2d.3h.2. A separate product design step
is required before allowing a private per-user today/when value.
Browser E2E remains a preproduction-deployment gate.
