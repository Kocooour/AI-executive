# D2b part 6 — provisional local recovery preference draft

This stage does **not** activate D2b partition, read/write ACL, invitations,
replay, import, discard, merge, resume or removal of the recovery hold.

## What it does

- `draftOfflineRecoveryDecisions(bytes, currentServerSnapshot, activeHold)`
  reads a **locally selected** v1 rescue file in memory and applies the
  existing strict size / UTF-8 / full schema / SHA / generation / ID-namespace
  validation. It shares the same active-hold consistency predicate as the
  existing aggregate review in PR #114.
- Server **revision** is required and recorded, along with restore generation,
  only to describe the comparison point. Neither value proves authorization.
  The caller must obtain a current authenticated server GET; a pure function
  cannot verify that the request was authenticated or guarantee freshness
  after the GET. Missing, malformed or stale generation is rejected.
- Returns a private, **ID-only**, in-memory list of candidates with the
  existing seven reasons and a default `defer` preference for every item.
  The result contains no titles, properties, note/project drafts, before/after
  record bodies, credentials, tokens or pending-marker IDs.
- All relation changes (including new or moved `belongs_to_area` links),
  Area/workspace/project entity edits, new/deleted entities, and existing
  task/note records with changed `areaId`, `projectId`, workspace or type
  **only** offer `defer`. This also applies when the *server* changed a
  stored scope and when a changed relation directly references the record.
  Only existing task/note content edits with unchanged stored scope can
  express provisional `prefer-local` or `prefer-server`; this does not
  verify their *effective* Area and never authorizes replay.
  `preferOfflineRecoveryOutcome` changes **only** an in-memory preference
  list, not any source data or persisted state. It rejects unknown candidates
  and unavailable preferences.
- Decision drafts are recursively frozen across their mutable surface and
  marked with module-private WeakSet identity; cloned, deserialized or altered
  plans fail closed instead of permitting a forged reason or expanded options.
  This identity exists only in the current runtime and is **not** a credential
  or server-side ACL token.
- Drafts, pending deletion/revival markers and pending sync are not lost:
  aggregate counts and `unresolvedNonRecordWork` explicitly keep them
  outside individual record preferences and mark them for separate review.

## Hard authorization boundary

**Identity, current membership, Area ACL and owner consent are always
`unverified` / `not-requested` in D2b/6.** The existing app is still
single-owner; it does not have an authoritative multi-user Area-membership
proof API and the v1 file does not sign an owner or a hold identity.
Neither a checksum, previous workspace ID, browser login, local click nor a
matching record can substitute for a server-side owner/actor/Area check.

Consequently **every** output has:

- `automaticReplayAllowed: false`
- `canApply: false`
- `canReleaseHold: false`
- `consent: "not-requested"`

These are not configurable flags. Never turn preferences into an executable
write request or an implicit sign-off, even if all records are already present,
no local changes exist, or the user has expressed a preferred outcome.

The plan includes private IDs and a digest of the sensitive rescue package.
Keep it in volatile browser memory only. Never persist, log, emit to analytics,
put in a URL, send it to the server or AI, or expose it through a public
review summary. The existing aggregate review remains the only presentation
surface; **this iteration does not wire the draft into the UI**.

## Before a recovery release can be designed

1. Implement **authoritative server-side** actor identity and per-Area
   membership/role/ACL evidence for the target generation. Enforce revocation
   and deny-by-default on both read and proposed future writes.
2. Audit 2b Area/workspace partition mappings and related entities,
   relation endpoints, note drafts, pending tombstones and attachments.
   Collisions need deterministic owner-reviewed remapping, not local overwrite.
3. Establish a versioned, fresh, per-item compare-and-swap contract against
   the current server revision, membership-policy revision and target Area.
   Cross-tab and crash-safe fencing must remain active throughout.
4. Implement independent owner **confirmation** of the complete reconciliation
   and an audited execute/rollback/undo boundary. Preferences are *not* consent.
5. Run focused multi-tab, restore/expiration, browser crash/reload and
   security tests on an isolated instance before merging any release-capable
   UI. The entire browser E2E suite is only the exact-main-SHA
   **pre-deployment** gate per `AGENTS.md`.

## Validation and isolation

Focused Node tests: `tests/d2b-recovery-decision-plan.test.mjs`. Standard
PR Checks: deployment syntax, `pnpm typecheck`, `pnpm test`, `pnpm build`.

No server, preview, DB or production state is needed for this pure-library
change. Branch: `codex/d2b-owner-recovery-decision-plan-20261025`,
based directly on the merged `main` commit `eb93bdbf`. If a focused UI
preview is ever needed, use a private synthetic instance on port `3001`
with state prefix `lumi_codex_d2b_plan` and no production credentials.
There is no parallel implementation branch or overlapping database state;
integration branch not required for this additive pure library PR.
