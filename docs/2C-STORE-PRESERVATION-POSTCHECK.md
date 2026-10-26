# 2c, part 3 — relation and tombstone preservation postcheck

**Status: read-only, synthetic/caller-supplied diagnostic. Not a migration executor or release authorization.** This extends the entity-only check from PR #118 after 2c preflight PR #117. It does not use a database connection, write data, run a migration, authorize actors, activate My Plan, change current UI or enable sharing.

## Contract

`checkLegacyAssigneeStorePreservation({ before, after, legacySharedWorkspaceIds })` requires *both* snapshots to explicitly include complete entity, relation and tombstone arrays, plus their revision and restore generation. Missing arrays **block**, rather than silently being treated as empty.

- It invokes the already-reviewed entity postcheck: only previously open, unassigned tasks in the explicitly designated current owner-only legacy shared workspace can acquire `assigneeUserId: "owner"`, with monotonic `updatedAt`, one revision increment if needed, and unchanged restore generation.
- Both canonical graphs must pass the existing `validateSnapshotStructure` constraints: valid relation endpoints, no cross-workspace links, unique canonical IDs, no overlapping entity/relation/tombstone IDs, and no dangling references.
- All relation and tombstone records must be **exactly preserved** by ID and deep JSON value. Changes to any endpoint, type, workspace, timestamp, identity or additional field, including deletion or addition, block the result. Array ordering is immaterial, but field values and nested array contents are not.
- Both sides must contain only plain, finite, fully materialized JSON values; exotic objects, undefined values, sparse arrays, accessors, symbols, cycles and non-finite numbers are blocked. Strict structural comparison is shared with 2c/2.
- Bounds: at most 20,000 entities, 50,000 relations and 50,000 tombstones in each claimed snapshot. Invalid data, missing metadata and inconsistent revision/generation all fail closed.

Successful output is frozen and contains **aggregate counts only**. All authorization-capable fields are permanently false: `verifiedPersistedState`, `verifiedSideTables`, `verifiedHomeTodayInbox`, `canApply`, `canReleaseHold`, `canActivateMyPlan` and `canEnableSharing`. It exposes no IDs, titles, assignment list or entity content. Inputs are neither mutated nor persisted.

## Explicit trust boundary

The caller can forge either snapshot, the legacy designation, `workspace.properties.members`, revisions or a purported complete array. This library cannot authenticate their provenance, prove they correspond to a transactionally locked SQLite store or verify consent and actual permissions. `validateSnapshotStructure` proves only internal structural consistency, **not authoritative completeness, freshness, historical scope or ACL**.

The diagnostic covers only canonical **entities, relations and tombstones**; it does not inspect the other SQLite tables (attention, mail, calendars, context, history, claims, drafts, caches, offline sync queues, etc.), actual Home/Today/Inbox identity, counts or order, authorization policy revision, historical 2b lineage, backup or rollback. A success is **never** proof that a migration is safe to apply or that sharing can be enabled. Client-supplied versions or hashes must never be promoted to authorization proof.

A future real 2c executor must wait for reviewed and applied 2a/2b, trusted 2b provenance, current authoritative membership/ACL, transactional revision and restore-generation CAS, comprehensive side-table and history audits, preserved offline changes, verified backup and rollback, and an independently sourced exact **Home/Today/Inbox** before/after comparison. No enabling My Plan without a separate release gate.

## Verification and isolation

Tests in `tests/legacy-assignee-store-postcheck.test.mjs` cover identity/order invariance, immutable aggregates, unchanged no-op, membership/assignee restrictions, entity drift, relation additions/deletions/rewrites/duplicates, dangling/cross-workspace edges, tombstone changes/collisions and non-JSON inputs. Existing 2c/2 tests continue to validate the refactored shared JSON comparator.

GitHub-only branch `codex/2c-store-preservation-postcheck-20261026` from main squash merge `d5fd964f32aa3d8e0b9ca65cde7a67db16f48e78` (PR #118). No app instance, SQLite copy, service, port, deployment, private dataset or secret required. Run standard `PR Checks` (deployment syntax, typecheck, unit tests and build) on exact PR HEAD. Browser E2E remains solely the predeployment exact-main release gate.
