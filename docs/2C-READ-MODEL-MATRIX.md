# 2c, part 7 — exact Home / Today / Inbox context matrix postcheck

**Status:** pure, bounded, non-authorizing comparison of caller-supplied synthetic before/after snapshots. This adds no database extraction, migration, recovery-hold release, deployment, read-route change, My Plan activation or sharing.

## Why a matrix?

Part 6 compares one claimed authenticated actor, instant, timezone and query configuration across Home, Today and Inbox. A future migration must prove more than a single owner/date combination: the actual routes need to preserve results for a reviewed matrix of actors, times, visibility/ACL states and filters.

`checkLegacyAssigneeReadModelMatrixPreservation({ expectedContexts, cases, legacySharedWorkspaceIds })` accepts an **explicit and untrusted** list of expected context objects and an unordered set of corresponding snapshot pairs:

```ts
{
  expectedContexts: [
    { actorUserId: "owner", asOf: "2026-10-26T11:00:00.000Z",
      timezone: "Europe/Prague", queryFingerprint: "home-today-inbox:v1" },
    { actorUserId: "member", asOf: "2026-10-27T11:00:00.000Z",
      timezone: "Europe/Prague", queryFingerprint: "home-today-inbox:v1" },
  ],
  cases: [
    { before: /* full 2c snapshot with readModels */, after: /* full 2c snapshot */ },
    { before: /* full 2c snapshot with readModels */, after: /* full 2c snapshot */ },
  ],
  legacySharedWorkspaceIds: ["legacy-shared"],
}
```

The helper first checks that the expected contexts are unique, that every expected context appears **exactly once** among the cases, and that each pair's before/after context matches its expected context without reordering ambiguity. A context is identified by collision-free JSON framing of its four strings; no input identifiers or data are returned. Cases may appear in any order. Each case then invokes the full part 6 comparator, which includes all canonical entity/relation/tombstone, side-table, metadata and read-model checks from parts 1–5.

## Hard boundaries

- Requires **1–16** distinct contexts, **1–16** equally many cases, and at most 20,000 legacy workspace IDs. All arrays must be dense, plain arrays with no extra own keys or accessors.
- Every context field must be nonblank and at most **512 UTF-16 code units**. Context objects and case envelopes have exactly the required own enumerable data fields, with no symbols or extra properties.
- Rejects JS Proxy objects at the matrix, case, snapshot, read-model envelope and context layers **before executing proxy traps**; rejects inherited or accessor fields at those layers. Nested views are validated by part 6, including size, cycle, exotic and proxy checks.
- On any failure, throws the single `LegacyAssigneeReadModelMatrixBlocked` error without leaking payloads. Success only returns `checkedContextCount`, `comparedReadModelCount` (3 per context) and the existing literal-false verification and authorization flags.
- The expected manifest, actor IDs and query fingerprints are **assertions supplied by the caller**, not independently validated identities, authoritative actor rosters or cryptographic provenance. Even a complete-looking matching matrix is **not** evidence of genuine route equivalence or ACL correctness.

## Production gates remain closed

To move toward a production backfill, a separately reviewed implementation must independently derive a complete actor/permission/time/query matrix, authenticate actors, derive the actual routes' responses from transactionally consistent real snapshots, ensure full SQLite table/schema and metadata coverage, independently enforce Area/member ACL boundaries, review triggers, caches and offline clients, and provide rollback/CAS safety. The present helper provides none of those guarantees and cannot authorize any write, hold release, My Plan activation or sharing.

Validate with the regular deployment-script syntax check, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Browser E2E remains a **release gate** for the exact deployable commit, not a per-PR requirement.
