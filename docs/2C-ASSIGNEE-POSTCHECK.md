# 2c, part 2 — read-only legacy assignee postcheck

**Status:** Pure, bounded **entity-level before/after diagnostic only**. This PR does not implement the 2c executor, SQLite/Dexie writes, automatic assignment, workspace partition, authentication, server authorization, My Plan activation or sharing. It builds on the owner-only candidate preflight from PR #117.

## Contract

`checkLegacyOwnerAssigneeBackfill({ before, after, legacySharedWorkspaceIds })` recomputes the original owner-only plan from the supplied **before** snapshot and validates a caller-supplied **after** snapshot. It rejects the entire check unless:

- Both snapshots are internally acceptable to the original preflight, with the same explicit current single-owner legacy shared workspace selection.
- Every entity ID and entity count is identical; no record may be added, removed, renamed, reassigned to a workspace, converted to another type or otherwise modified.
- Each **open and previously unassigned** candidate task has `assigneeUserId: "owner"`. Its `updatedAt` may increase or remain the same but may **not decrease**. All other fields, including deadline, priority, Inbox, `today/when`, manual order, status and timestamps, must remain identical.
- An existing assignment, a completed task, any personal/unrelated task, the workspace membership list and all other entities are byte-content-equivalent under canonical field comparison (object key order is not material). Any difference blocks the entire check.
- The after snapshot's `restoreGeneration` is unchanged. Revision increases by **exactly one** if any candidate changes; a no-op requires no revision change. Counter overflow is blocked.
- No candidates remain to be assigned in the selected legacy scope.

Successful output includes only revisions and aggregate counts: `phase: "legacy-assignee-postcheck-only"`, `verifiedPersistedState: false`, `canApply: false`, `canActivateMyPlan: false`, `canEnableSharing: false`. It includes neither entity content nor candidate IDs and is frozen. Input snapshots are not mutated.

## Trust limitations — **not a migration or release gate**

Both snapshots, legacy designation, workspace `properties.members` and counters are **caller-supplied**. An attacker can forge consistent before and after objects; this check cannot verify historical legacy origin, the current authoritative revision, membership/ACL or whether the after snapshot was persisted at all. Its result is **not a migration manifest, authorization proof or go-ahead** for writes, hold release or multi-user sharing.

The postcheck deliberately covers only canonical **entities**. It does **not** inspect relations, tombstones, workspace side tables, claims/evidence, context, notes history, calendar, attention, notifications, clients' offline queues, local drafts, full SQLite backups or the actual Home/Today/Inbox identity/order/counts. Preserving all entity fields is useful but does not imply preservation of those other stores and views.

A real executor still requires completed and independently reviewed 2a and 2b gates, proven legacy workspace lineage, trusted server ACL/membership, transaction-held compare-and-swap of revision and restore generation, verified backup/rollback, canonical entity/relation/side-table post-commit checks and **actual Home/Today/Inbox before/after comparisons**. Fail closed on any mismatch and keep the My Plan feature gate off. Never use untrusted preflight/postcheck results as commands.

## Validation and isolation

`tests/legacy-assignee-postcheck.test.mjs` exercises the allowed assignment shape, null/absent assignees, deterministic order independence, no-op, full-data immutability, private redaction, conflicting assignments, membership changes, every relevant placement field, task identity/metadata drift, missing/duplicate/retyped records, revision/generation drift and overflow, multi-member selections.

Branch `codex/2c-assignee-postcheck-20261026` from main `aaf99402853120e74bbf55f71e50d480710f6732`. GitHub-only editing; no local worktree, port, running app, DB, mutable storage or secrets used. If a local synthetic instance is needed later, isolate it on port 3001 and prefix `lumi_codex_2c_postcheck`. No parallel implementation branches need integration. Run `PR Checks` on the final head (deployment script syntax, `pnpm typecheck`, `pnpm test`, `pnpm build`). Full browser E2E stays the exact-main-SHA **predeployment** gate only.
